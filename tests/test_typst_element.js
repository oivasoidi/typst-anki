/*
 * Integration test for typst-element.js against a simulation of Anki's new
 * editor (26.08+): a shadow-root <anki-editable> with Anki's bidirectional
 * DOM mirror (editable blur => field content replaced from the store).
 *
 * Requires jsdom and exits with a hint when it is not installed:
 *   npm install jsdom && node tests/test_typst_element.js
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
    // jsdom from the current directory's node_modules, or a global install.
    JSDOM = require("jsdom").JSDOM;
} catch (err) {
    try {
        JSDOM = require("/usr/lib/node_modules/jsdom").JSDOM;
    } catch (err2) {
        console.error("jsdom is required: npm install jsdom");
        process.exit(2);
    }
}

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) {
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
    if (!cond) failures++;
}

// ---- Anki bridge (pycmd) stub ----
const compileCalls = [];
let bridgeMode = "sync"; // "sync": result via the pycmd callback,
// "async": pending placeholder via pycmd, result via __typstAnkiResolve.
window.pycmd = (msg, cb) => {
    if (!msg.startsWith("typst-anki:compile:")) return;
    const payload = JSON.parse(msg.slice("typst-anki:compile:".length));
    compileCalls.push(payload);
    setTimeout(() => {
        // Sources marked BROKEN simulate typst compile errors.
        const result = payload.source.includes("BROKEN")
            ? { ok: false, error: "does not compile" }
            : { ok: true, html: `<img data-src="${payload.source}">` };
        if (bridgeMode === "sync") {
            cb(result);
        } else {
            cb({ __pending: true });
            window.__typstAnkiResolve(payload.id, result);
        }
    }, 0);
};

// ---- Build the new-editor page: shadow editable + DOM mirror ----
const host = document.createElement("div");
host.className = "rich-text-editable";
document.body.appendChild(host);
host.attachShadow({ mode: "open" });
const editable = document.createElement("anki-editable");
editable.setAttribute("contenteditable", "true");
editable.tabIndex = 0;
host.shadowRoot.appendChild(editable);

// A faithful-enough copy of Anki's ts/lib/sveltelib/dom-mirror.ts.
function makeMirror(element) {
    const state = { allow: true, store: "", prevented: 0, restored: 0, replacements: 0 };
    const save = () => { state.store = element.innerHTML; };
    const observer = new window.MutationObserver(save);
    observer.observe(element, { childList: true, subtree: true, attributes: true, characterData: true });

    function replaceFromStore() {
        state.replacements++;
        observer.disconnect();
        while (element.firstChild) element.firstChild.remove();
        // clone the stored content (like range.cloneContents of the store)
        const tmp = document.createElement("div");
        tmp.innerHTML = state.store;
        while (tmp.firstChild) element.appendChild(tmp.firstChild);
        observer.observe(element, { childList: true, subtree: true, attributes: true, characterData: true });
    }

    let offBlur = null;
    const onBlur = () => replaceFromStore();
    const onAllow = (allow) => {
        if (allow) {
            if (!offBlur) {
                element.addEventListener("blur", onBlur);
                offBlur = onBlur;
            }
            const root = element.getRootNode();
            if (!root.activeElement || root.activeElement !== element) {
                replaceFromStore(); // subscribe fires the callback immediately
            }
        } else if (offBlur) {
            element.removeEventListener("blur", offBlur);
            offBlur = null;
        }
    };
    onAllow(true); // initial subscribe replaces only when not focused

    state.preventResubscription = () => {
        state.prevented++;
        onAllow(false);
        return () => { state.restored++; onAllow(true); };
    };
    return state;
}
const mirror = makeMirror(editable);
// The mirror's initial subscription replaces the (empty) field content
// once; count replacements relative to that baseline.
const baselineReplacements = mirror.replacements;

// The runtime package the new editor exposes to add-ons.
const fakeInput = {
    name: "rich-text",
    element: Promise.resolve(editable),
    preventResubscription: () => mirror.preventResubscription(),
    editable: { focusHandler: { flushCaret: () => {} } },
};
window.require = (name) => {
    if (name === "anki/RichTextInput") return { instances: [fakeInput] };
    throw new Error(`Cannot require "${name}" at runtime.`);
};

// ---- Load the element ----
const elementJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "typst-anki", "web", "typst-element.js"),
    "utf-8"
);
// ---- Fake BroadcastChannel, simulating the hidden compiler page ---- //
// Installed before the element script so its local-compile channel can be
// exercised. It starts "not ready" (like a compiler page that is still
// booting), so all earlier sections keep using the Python bridge.
const localRequests = [];
const localChannels = [];
let localReady = false;
window.BroadcastChannel = class {
    constructor(name) {
        this.name = name;
        this.onmessage = null;
        localChannels.push(this);
    }
    postMessage(msg) {
        if (!msg) {
            return;
        }
        if (msg.type === "ping") {
            if (localReady) {
                this._reply({ type: "ready" });
            }
            return;
        }
        localRequests.push(msg);
        // The compiler page: SVG compiles answered locally (mirroring the
        // preamble + equation + bake), mathml and not-ready requests
        // answered with a fallback so the editor uses the Python bridge.
        setTimeout(() => {
            if (!localReady || msg.render === "mathml") {
                this._reply({ type: "result", id: msg.id, fallback: true });
            } else {
                this._reply({
                    type: "result",
                    id: msg.id,
                    ok: true,
                    html: `<img data-local="${msg.source}" ${msg.block ? "data-block" : ""}>`,
                });
            }
        }, 0);
    }
    _reply(message) {
        this.onmessage && this.onmessage({ data: message });
    }
    close() {}
};

window.eval(elementJs);
check("element defined", !!window.customElements.get("anki-typst"));

(async () => {
    // 1. Display mode with an existing render.
    const el = document.createElement("anki-typst");
    el.setAttribute("data-typst", "x^2");
    el.setAttribute("data-render-src", "x^2");
    el.setAttribute("data-render", "svg");
    el.innerHTML = "<img data-src='baked'>";
    editable.appendChild(el);
    await window.customElements.whenDefined("anki-typst");
    await sleep(10);
    check("upgraded in display mode", el.shadowRoot && el.shadowRoot.querySelector("slot") !== null);
    check("no compile for fresh render", compileCalls.length === 0);
    check("no mirror replacement so far (focused field)", mirror.replacements === baselineReplacements);

    // 2. Click to edit: the mirror must be suspended BEFORE the editable
    //    blurs, so the field content (and the element) survives.
    el.click();
    await sleep(20);
    check("edit panel created on body", !!document.querySelector(".typst-anki-panel"));
    check("source textarea seeded", document.querySelector(".typst-anki-panel .src").value === "x^2");
    check("mirror suspended (preventResubscription)", mirror.prevented === 1 && mirror.restored === 0);
    check("editable content not replaced", mirror.replacements === baselineReplacements);
    check("element survived (same instance)", el.isConnected && editable.firstChild === el);

    // Simulate the blur that focusing the textarea caused in the real app.
    editable.dispatchEvent(new window.Event("blur"));
    await sleep(20);
    check("blur did not replace the field content", mirror.replacements === baselineReplacements && el.isConnected);
    check("panel still open after blur", !!document.querySelector(".typst-anki-panel"));

    // 3. Live compile while typing.
    const srcBox = document.querySelector(".typst-anki-panel .src");
    srcBox.value = "x^2 + 1";
    srcBox.dispatchEvent(new window.Event("input"));
    await sleep(300);
    check("live compile requested", compileCalls.length === 1 && compileCalls[0].source === "x^2 + 1");
    check("live render updated", el.shadowRoot.querySelector(".inline-render img") !== null);

    // 4. Enter commits; mirror is resumed afterwards.
    srcBox.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(20);
    check("panel closed on Enter", !document.querySelector(".typst-anki-panel"));
    check("source committed", el.dataset.typst === "x^2 + 1");
    check("render baked into field DOM", el.innerHTML.includes("x^2 + 1"));
    await sleep(20);
    check("mirror resumed after commit", mirror.restored === 1);

    // 5. Empty equations do not compile junk (<math></math> regression).
    compileCalls.length = 0;
    const fresh = document.createElement("anki-typst");
    fresh.setAttribute("data-typst", "");
    fresh.setAttribute("data-render", "mathml");
    editable.appendChild(fresh);
    await sleep(20);
    check("empty source not compiled", compileCalls.length === 0);
    check("empty render-src self-healed", fresh.dataset.renderSrc === "");
    check("placeholder shown", fresh.shadowRoot.textContent.includes("(typst)"));

    // 6. Typing then emptying then Enter removes the element.
    fresh.click();
    await sleep(20);
    const box2 = document.querySelector(".typst-anki-panel .src");
    check("fresh equation editable", box2 !== null && box2.value === "");
    box2.value = "z";
    box2.dispatchEvent(new window.Event("input"));
    await sleep(10);
    box2.value = "";
    box2.dispatchEvent(new window.Event("input"));
    box2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(20);
    check("emptied equation removed", !fresh.isConnected);

    // 7. Escape cancels (keeps original source).
    const esc = document.createElement("anki-typst");
    esc.setAttribute("data-typst", "keepme");
    esc.setAttribute("data-render-src", "keepme");
    esc.innerHTML = "<img data-src='keepme'>";
    editable.appendChild(esc);
    await sleep(10);
    esc.click();
    await sleep(20);
    const box3 = document.querySelector(".typst-anki-panel .src");
    box3.value = "changed";
    box3.dispatchEvent(new window.Event("input"));
    box3.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(20);
    check("Escape reverts source", esc.dataset.typst === "keepme" && esc.innerHTML.includes("keepme"));

    // 8. Outside click commits and closes. (After the Escape above, the
    //    mirror resumed and re-cloned the field content, like the real
    //    editor does when its equation editor closes unfocused; grab the
    //    current element instance.)
    const escNow = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "keepme"
    );
    check("equation re-cloned but intact", escNow !== null && escNow !== esc);
    escNow.click();
    await sleep(20);
    const box4 = document.querySelector(".typst-anki-panel .src");
    check("re-cloned equation editable", box4 !== null && box4.value === "keepme");
    box4.value = "committed";
    box4.dispatchEvent(new window.Event("input"));
    document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    const committed = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "committed"
    );
    check("outside click commits", !!committed && !document.querySelector(".typst-anki-panel"));

    // 9. Arrow keys exit the source editor at its boundaries.
    const arrowEl = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "x^2 + 1"
    );
    arrowEl.click();
    await sleep(20);
    const box5 = document.querySelector(".typst-anki-panel .src");
    check("arrow test equation editable", box5 !== null && box5.value === "x^2 + 1");
    box5.value = "x^2 + 10";
    box5.dispatchEvent(new window.Event("input"));
    // Caret in the middle: arrows must not exit.
    box5.setSelectionRange(3, 3);
    box5.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await sleep(10);
    check("arrow in the middle does not exit", !!document.querySelector(".typst-anki-panel"));
    // Selection spanning the boundary: arrows must not exit either.
    box5.setSelectionRange(0, 3);
    box5.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await sleep(10);
    check("arrow with a selection does not exit", !!document.querySelector(".typst-anki-panel"));
    // At the start: ArrowLeft commits and exits.
    box5.setSelectionRange(0, 0);
    box5.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await sleep(20);
    check("ArrowLeft at start exits and commits",
        !document.querySelector(".typst-anki-panel") && arrowEl.dataset.typst === "x^2 + 10");
    // Re-enter and exit on the right side. (The jsdom mirror re-clones the
    // field on commit — in the real editor the placed caret keeps the field
    // focused, so no re-clone happens; grab the current instance either way.)
    const arrowEl2 = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "x^2 + 10"
    );
    arrowEl2.click();
    await sleep(20);
    const box6 = document.querySelector(".typst-anki-panel .src");
    box6.setSelectionRange(box6.value.length, box6.value.length);
    box6.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await sleep(20);
    check("ArrowRight at end exits",
        !document.querySelector(".typst-anki-panel") && arrowEl.dataset.typst === "x^2 + 10");

    // 10. Block math: exiting hands the caret to a visible line. A caret
    //     placed directly after a block equation has no line of its own, so
    //     a <br> is inserted next to the equation (like the native editor).
    const blk = document.createElement("anki-typst");
    blk.setAttribute("data-typst", "b^2");
    blk.setAttribute("data-render-src", "b^2");
    blk.setAttribute("block", "true");
    blk.innerHTML = "<img data-src='b2'>";
    editable.appendChild(blk); // last element of the field
    await sleep(10);
    blk.click();
    await sleep(20);
    const boxB = document.querySelector(".typst-anki-panel .src");
    check("block equation editable", boxB !== null && boxB.value === "b^2");
    check("block edit style centers live render",
        blk.shadowRoot.querySelector("style").textContent.includes(
            ':host([block="true"]) .inline-render { display: block; text-align: center; }'
        ));
    boxB.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(20);
    check("br inserted after block equation", blk.nextSibling && blk.nextSibling.tagName === "BR");
    // No <br> needed when an inline line follows the equation.
    const blk2 = document.createElement("anki-typst");
    blk2.setAttribute("data-typst", "c^2");
    blk2.setAttribute("data-render-src", "c^2");
    blk2.setAttribute("block", "true");
    blk2.innerHTML = "<img data-src='c2'>";
    editable.appendChild(blk2);
    editable.appendChild(document.createTextNode("tail"));
    await sleep(10);
    blk2.click();
    await sleep(20);
    const boxB2 = document.querySelector(".typst-anki-panel .src");
    boxB2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(20);
    check("no br inserted when a line follows",
        blk2.nextSibling === null || blk2.nextSibling.nodeType === 3 /* text */);
    // The empty placeholder of a block equation is centered as well.
    const blkEmpty = document.createElement("anki-typst");
    blkEmpty.setAttribute("data-typst", "");
    blkEmpty.setAttribute("block", "true");
    editable.appendChild(blkEmpty);
    await sleep(10);
    check("block placeholder centered",
        blkEmpty.shadowRoot.querySelector("style").textContent.includes(
            ':host([block="true"]) { display: block; text-align: center; }'
        ));

    // 11. Broken sources: the erroneous source replaces the render in red,
    //     but only once the user settles on it (no flicker while typing).
    const brk = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "committed"
    );
    brk.click();
    await sleep(20);
    const boxC = document.querySelector(".typst-anki-panel .src");
    boxC.value = "1 + BROKEN";
    boxC.dispatchEvent(new window.Event("input"));
    await sleep(400); // compile debounce (250ms) + response, but < error delay
    check("error delay: red source not shown yet",
        brk.shadowRoot.querySelector(".inline-render").textContent !== "1 + BROKEN");
    // 250ms compile debounce + 700ms error delay -> ~1s until the red
    // source appears.
    await sleep(700);
    check("settled broken source shown in red",
        brk.shadowRoot.querySelector(".inline-render span").textContent === "1 + BROKEN" &&
        brk.__errorSource === "1 + BROKEN");
    // Fixing the source swaps back to the live render.
    boxC.value = "1 + ok";
    boxC.dispatchEvent(new window.Event("input"));
    await sleep(400);
    check("fixed source renders again",
        brk.__errorSource === null &&
        brk.shadowRoot.querySelector(".inline-render img") !== null);
    // Committing a broken equation keeps the last render in the note, but
    // shows the source in red.
    boxC.value = "2 + BROKEN";
    boxC.dispatchEvent(new window.Event("input"));
    await sleep(400);
    boxC.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(100);
    const brkNow = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "2 + BROKEN"
    );
    check("committed broken source shows red",
        !!brkNow &&
        brkNow.__errorSource === "2 + BROKEN" &&
        brkNow.shadowRoot.querySelector("span") !== null &&
        brkNow.shadowRoot.querySelector("span").textContent === "2 + BROKEN");
    check("broken equation keeps its last render stored",
        brkNow.innerHTML.includes("img"));

    // 12. The source panel is centered under block equations, and left-
    //     aligned under inline ones (jsdom does no layout, so geometry is
    //     stubbed per element).
    const rectStub = (el, r) => (el.getBoundingClientRect = () => r);
    const viewport = { width: 1024, height: 768 };
    const origInnerWidth = window.innerWidth;
    const origInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { value: viewport.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: viewport.height, configurable: true });

    const blkNow2 = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "b^2"
    );
    rectStub(blkNow2, { left: 200, right: 600, top: 100, bottom: 150, width: 400, height: 50 });
    blkNow2.click();
    await sleep(20);
    let panel = document.querySelector(".typst-anki-panel");
    check("block panel centered under the equation",
        !!panel &&
        panel.style.left === `${200 + 400 / 2}px` &&
        panel.style.top === `${150 + 6}px`);
    document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);

    const brkNow2 = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "2 + BROKEN"
    );
    rectStub(brkNow2, { left: 100, right: 140, top: 300, bottom: 350, width: 40, height: 50 });
    brkNow2.click();
    await sleep(20);
    panel = document.querySelector(".typst-anki-panel");
    check("inline panel aligned with the equation",
        !!panel && panel.style.left === "100px" && panel.style.top === `${350 + 6}px`);

    Object.defineProperty(window, "innerWidth", { value: origInnerWidth, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: origInnerHeight, configurable: true });

    // 13. Live compiling: no debounce, and rapid keystrokes coalesce —
    //     while a compile is in flight, further keystrokes only queue a
    //     single recompile with the latest source.
    const liveEl = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "x^2 + 10"
    );
    liveEl.click();
    await sleep(20);
    const boxL = document.querySelector(".typst-anki-panel .src");
    check("live test equation editable", boxL !== null && boxL.value === "x^2 + 10");
    const callsBefore = compileCalls.length;
    boxL.value = "x";
    boxL.dispatchEvent(new window.Event("input"));
    boxL.value = "xy";
    boxL.dispatchEvent(new window.Event("input"));
    boxL.value = "xyz";
    boxL.dispatchEvent(new window.Event("input"));
    await sleep(50);
    // One compile for the first keystroke, one queued recompile for the rest.
    check("rapid keystrokes coalesce into latest-source compiles",
        compileCalls.length - callsBefore === 2 &&
        compileCalls[compileCalls.length - 1].source === "xyz");
    check("live render shows the latest source",
        liveEl.shadowRoot.querySelector(".inline-render img").getAttribute("data-src") === "xyz");
    document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);

    // 14. The async delivery channel: when the addon only answers the
    //     pycmd callback with a pending placeholder and delivers the real
    //     result through window.__typstAnkiResolve, the live render
    //     still updates.
    bridgeMode = "async";
    const asyncEl = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === "xyz"
    );
    asyncEl.click();
    await sleep(20);
    const boxA = document.querySelector(".typst-anki-panel .src");
    boxA.value = "async ok";
    boxA.dispatchEvent(new window.Event("input"));
    await sleep(50);
    check("async-resolved compile updates the render",
        asyncEl.shadowRoot.querySelector(".inline-render img").getAttribute("data-src") === "async ok");

    // 15. Holding a key (auto-repeat) does not recompile per repeat —
    //     the source compiles once when the key is released. (Continues
    //     in the editing session left open by section 14.)
    check("hold test equation editable", boxA !== null && boxA.value === "async ok");
    const holdCallsBefore = compileCalls.length;
    // Press (no repeat yet) -> one compile for the initial press.
    boxA.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    boxA.value = "async o";
    boxA.dispatchEvent(new window.Event("input"));
    await sleep(30);
    check("initial press compiles", compileCalls.length - holdCallsBefore === 1);
    // Held: auto-repeat keydowns + input events must not compile.
    for (let i = 0; i < 3; i++) {
        boxA.dispatchEvent(
            new window.KeyboardEvent("keydown", { key: "Backspace", repeat: true, bubbles: true })
        );
        boxA.value = boxA.value.slice(0, -1);
        boxA.dispatchEvent(new window.Event("input"));
    }
    await sleep(30);
    check("held key does not recompile", compileCalls.length - holdCallsBefore === 1);
    // Release: exactly one compile of the final source.
    boxA.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
    await sleep(30);
    check("release compiles the final source",
        compileCalls.length - holdCallsBefore === 2 &&
        compileCalls[compileCalls.length - 1].source === boxA.value);
    check("render updated after release",
        asyncEl.shadowRoot.querySelector(".inline-render img").getAttribute("data-src") === boxA.value);

    // 16. The local incremental-compiler channel: once the hidden compiler
    //     page signals readiness, SVG compiles are answered through the
    //     BroadcastChannel without any Python bridge traffic; MathML
    //     always goes through the bridge.
    localReady = true;
    localChannels.forEach((ch) => ch._reply({ type: "ready" }));
    // Close the session left open by section 15, committing its source.
    const committedSource = boxA.value;
    document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    const localEl = Array.from(editable.querySelectorAll("anki-typst")).find(
        (e) => e.dataset.typst === committedSource
    );
    check("committed equation found", !!localEl, committedSource);
    localEl.click();
    await sleep(20);
    const boxLocal = document.querySelector(".typst-anki-panel .src");
    check("local test equation editable", boxLocal !== null && boxLocal.value === committedSource);
    const bridgeBefore = compileCalls.length;
    const localBefore = localRequests.length;
    boxLocal.value = "a + b";
    boxLocal.dispatchEvent(new window.Event("input"));
    await sleep(50);
    check("svg compile served locally",
        localRequests.length === localBefore + 1 &&
        localRequests[localRequests.length - 1].source === "a + b");
    check("local render applied",
        localEl.shadowRoot.querySelector(".inline-render img").getAttribute("data-local") === "a + b");
    const bridgeAfterSvg = compileCalls.length;
    check("no bridge compile for svg", bridgeAfterSvg === bridgeBefore);
    // MathML short-circuits to the bridge.
    localEl.dataset.render = "mathml";
    boxLocal.value = "c + d";
    boxLocal.dispatchEvent(new window.Event("input"));
    await sleep(50);
    check("mathml compile goes through the bridge",
        compileCalls.length === bridgeAfterSvg + 1 &&
        compileCalls[compileCalls.length - 1].render === "mathml");

    console.log(failures === 0 ? "ALL ELEMENT TESTS PASSED" : failures + " FAILURES");
    process.exit(failures === 0 ? 0 : 1);
})();
