/*
 * Integration test for typst-new-editor.js: the webview chord shortcuts
 * dispatch through pycmd, and the native equations menu gets the Typst
 * entries — including "Edit preamble..." — appended.
 *
 * Run: npm install jsdom && node tests/test_typst_new_editor.js
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
    JSDOM = require("jsdom").JSDOM;
} catch (err) {
    try {
        JSDOM = require("/usr/lib/node_modules/jsdom").JSDOM;
    } catch (err2) {
        console.error("jsdom is required: npm install jsdom");
        process.exit(2);
    }
}

const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    { runScripts: "outside-only", pretendToBeVisual: true }
);
const { window } = dom;
const { document } = window;

let failures = 0;
function check(name, cond, extra = "") {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  <<< " + extra));
    if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Stubs: the editor page's runtime packages and bridge ---- //
const registeredShortcuts = [];
const pycmdCalls = [];
window.pycmd = (msg) => pycmdCalls.push(msg);
window.require = (name) => {
    if (name === "anki/shortcuts") {
        return {
            registerShortcut: (fn, combination) => registeredShortcuts.push([fn, combination]),
            getPlatformString: (combination) => "⌘" + combination.split(",")[1].trim(),
        };
    }
    throw new Error(`Cannot require "${name}" at runtime.`);
};

const newEditorJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "typst-anki", "web", "typst-new-editor.js"),
    "utf-8"
);
window.eval(newEditorJs);

const click = (target) => target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

(async () => {
    // 1. Shortcut registration (the webview chords).
    const combos = registeredShortcuts.map(([, c]) => c);
    check("chords registered", combos.length === 2 && combos[0] === "Control+M, T", combos);
    const pycmdBefore = pycmdCalls.length;
    registeredShortcuts[0][0]({ preventDefault: () => {} });
    check("chord dispatches through the bridge", pycmdCalls.length === pycmdBefore + 1 &&
        pycmdCalls[pycmdCalls.length - 1] === "typst-anki:shortcut:inline");

    // 2. The Typst toolbar button is gone entirely.
    check("no Typst button code left", !newEditorJs.includes("typst_menu"));

    // 3. Native equations menu augmentation: the popover gets the three
    //    Typst math entries plus "Edit preamble...".
    const popover = document.createElement("div");
    const item0 = document.createElement("button");
    const label0 = document.createElement("span");
    label0.textContent = "Mathjax Inline";
    const hint0 = document.createElement("span");
    hint0.className = "shortcut";
    hint0.textContent = "⌘M";
    item0.append(label0, hint0);
    popover.appendChild(item0);
    document.body.appendChild(popover);
    await sleep(10);
    const typstEntries = [...popover.querySelectorAll("button[data-typst-menu]")];
    check("equations menu gained typst entries", typstEntries.length === 3, typstEntries.length);
    if (typstEntries.length === 3) {
        const labels = typstEntries.map((b) => b.querySelector("span:not(.shortcut)").textContent);
        check("entry labels", labels.join("|") ===
            "Typst Math|Typst Math block|Edit preamble...", labels.join("|"));
        check("no replace entry left", !labels.some((l) => l.includes("replace")));
        check("shortcut hints localized", typstEntries[0].querySelector(".shortcut").textContent === "⌘T");
        check("preamble entry has no shortcut hint", typstEntries[2].querySelector(".shortcut") === null);

        const mousedown = (target) =>
            target.dispatchEvent(
                new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })
            );
        mousedown(typstEntries[0]);
        click(typstEntries[0]);
        check("equations entry dispatches",
            pycmdCalls[pycmdCalls.length - 1] === "typst-anki:shortcut:inline");
        check("entries prevent the mousedown default (keep the field focused,",
            // so the popover is not unmounted before the click fires; the
            // native entries do the same via on:mousedown|preventDefault
            (() => {
                const event = new window.MouseEvent("mousedown", {
                    bubbles: true,
                    cancelable: true,
                });
                typstEntries[0].dispatchEvent(event);
                return event.defaultPrevented;
            })());
        click(typstEntries[2]);
        check("preamble entry dispatches",
            pycmdCalls[pycmdCalls.length - 1] === "typst-anki:shortcut:preamble");
    }

    // 4. The augmentation is applied only once per popover (guarded).
    document.body.appendChild(popover); // re-append fires the observer again
    await sleep(10);
    const allTypstEntries = document.querySelectorAll("button[data-typst-menu]");
    check("popover not augmented twice", allTypstEntries.length === 3, allTypstEntries.length);

    console.log(failures === 0 ? "ALL NEW-EDITOR TESTS PASSED" : failures + " FAILURES");
    process.exit(failures === 0 ? 0 : 1);
})();
