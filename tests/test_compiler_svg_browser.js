/* Real-browser (Playwright/Chromium) test of the hidden compiler page.
 *
 * Boots web/typst-compiler.html (the real WASM compiler) and compiles an
 * equation through the same BroadcastChannel protocol the <anki-typst>
 * element uses, then checks the baked <img>'s SVG.
 *
 * Regression guard for the "smaller black copy of each symbol" bug:
 * typst.ts renders every glyph twice — as a vector glyph and as an HTML
 * text-selection layer (<foreignObject><div class="tsel">). Inside a
 * baked <img> the browser draws that layer with the fallback font in
 * black, overlaid on the real glyph. bakeSvgImg strips it; this test
 * fails if it ever comes back.
 *
 * Run: node tests/test_compiler_svg_browser.js
 */
let chromium;
try {
  chromium = require("playwright").chromium;
} catch (err) {
  try {
    chromium = require("/tmp/node_modules/playwright").chromium;
  } catch (err2) {
    console.error("playwright is required: npm install playwright");
    process.exit(2);
  }
}
const http = require("http");
const fs = require("fs");
const path = require("path");

const WEB_ROOT = path.join(__dirname, "..", "src", "typst-anki", "web");
const PORT = 8936;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};

let failures = 0;
function check(name, cond, extra = "") {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  <<< " + extra));
  if (!cond) failures++;
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = req.url.split("?")[0].replace(/^\/_addons\/typst-anki\/web\//, "");
      if (rel === "blank.html") {
        // Minimal stand-in for the editor page (same origin, so the
        // BroadcastChannel reaches the compiler page).
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><html><body></body></html>");
        return;
      }
      const file = path.join(WEB_ROOT, rel);
      if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(PORT, "127.0.0.1", () => resolve(s));
  });

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // The compiler page, as the hidden webview loads it.
  const compilerPage = await context.newPage();
  await compilerPage.goto(
    `http://127.0.0.1:${PORT}/_addons/typst-anki/web/typst-compiler.html`
  );
  await compilerPage.waitForFunction(
    () => window.__typstAnkiCompilerState?.ready === true,
    null,
    { timeout: 90000 }
  );

  // An editor page in the same storage partition: the BroadcastChannel
  // connects them, like the hidden compiler webview connects to the editor.
  const editorPage = await context.newPage();
  await editorPage.goto(`http://127.0.0.1:${PORT}/blank.html`);
  const result = await editorPage.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const chan = new BroadcastChannel("typst-anki-compiler");
        const timer = setTimeout(
          () => reject(new Error("compile result did not arrive")),
          60000
        );
        const ask = () => chan.postMessage({ type: "ping" });
        chan.onmessage = (ev) => {
          const msg = ev.data;
          if (msg.type === "booting") {
            ask();
            return;
          }
          if (msg.type === "ready" && !window.__asked) {
            window.__asked = true;
            chan.postMessage({
              type: "compile",
              id: 1,
              source: "x^2 + 1",
              block: false,
              render: "svg",
            });
            return;
          }
          if (msg.type === "result" && msg.id === 1) {
            if (msg.fallback) {
              // The compiler is not ready after all: re-probe.
              window.__asked = false;
              ask();
              return;
            }
            clearTimeout(timer);
            resolve(msg);
          }
        };
        ask();
      })
  );

  check("compile succeeded via WASM channel", result.ok && !result.fallback);
  check("result is a baked <img>", /^<img/.test(result.html || ""));

  const svg = await editorPage.evaluate(
    (imgHtml) => {
      const m = imgHtml.match(/src="data:image\/svg\+xml;base64,([^"]+)"/);
      const bin = atob(m[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    },
    result.html
  );

  check(
    "svg has vector glyphs",
    (svg.match(/<use /g) || []).length === 4,
    svg.slice(0, 120)
  );
  check(
    "no text-selection layer (foreignObject) in baked svg",
    !/<foreignObject/.test(svg)
  );
  check("no tsel div in baked svg", !svg.includes("tsel"));
  check("no <text> fallback in baked svg", !/<text/.test(svg));

  await browser.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
