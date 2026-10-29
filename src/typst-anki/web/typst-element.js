/*
 * typst-anki: the `<anki-typst>` live-editing custom element.
 *
 * Stored (light DOM) format — this is what Anki saves into the note field
 * and what clients *without* the addon (AnkiDroid, AnkiWeb, vanilla
 * desktop Anki) display:
 *
 *   <anki-typst data-typst="x^2 + 1" data-render-src="x^2 + 1"
 *               data-render="svg" block="true">
 *     <img src="data:image/svg+xml;base64,...">   <!-- or MathML -->
 *   </anki-typst>
 *
 *   data-typst      Typst source; the source of truth. The equation can be
 *                   re-edited at any time, even after saving and reopening.
 *   data-render-src The source the baked render was produced from. Used to
 *                   detect and self-heal stale renders (e.g. the source was
 *                   edited via the HTML editor).
 *   data-render     "svg" or "mathml"; kept per-equation so re-compiles
 *                   preserve the originally chosen export format.
 *   block="true"    Display math instead of inline math.
 *
 * UX (mirrors how MathJax equations behave in Anki): outside edit mode the
 * equation shows its rendered SVG/MathML. Click it (or move the caret into
 * it with the arrow keys) and a small floating source editor appears next
 * to the equation — *inside* the editor webview, not a separate window.
 * While you type, the equation re-renders live in place. Enter (or clicking
 * away) commits, Escape reverts, emptying a typed equation deletes it.
 *
 * Placement notes: all element-anchored UI (the equation display, the live
 * render while editing) lives in the shadow root, so nothing but the stored
 * format above ever leaks into the saved note HTML. The floating source
 * panel, however, is appended to `document.body` — like Anki's own
 * MathJax editor, which portals its floating UI as well. Ancestors inside
 * the editor (transitions, overflow containers) would otherwise turn the
 * panel's `position: fixed` into ancestor-relative positioning and push it
 * off-screen.
 *
 * New editor (Anki 26.08+): the fields are `<anki-editable>`s living inside
 * shadow roots, mirrored bidirectionally with an internal DOM store: when
 * the editable loses focus, the mirror replaces the whole field content
 * from the store. Anything not serialized into the field HTML — this
 * element's shadow root, the floating panel, the editing state — is
 * destroyed the moment the editable blurs, i.e. the instant the source
 * panel's textarea takes focus. Anki's own MathJax overlay suspends that
 * mirror while its editor is open; this element does the same through the
 * `anki/RichTextInput` runtime package (see `holdMirror`/`releaseMirror`).
 */
(() => {
  "use strict";
  if (customElements.get("anki-typst")) {
    return;
  }

  // How long the source has to keep failing before it replaces the render
  // in the equation: not immediately, so that intermediate broken states
  // while typing do not make the equation flicker between the erroneous
  // source and a render.
  const ERROR_DISPLAY_DELAY_MS = 700;
  const BRIDGE_PREFIX = "typst-anki:compile:";
  const PANEL_CLASS = "typst-anki-panel";
  const PANEL_STYLE_ID = "typst-anki-panel-style";

  // ----- compile request plumbing ----- //
  //
  // Compiles happen live, on every keystroke. Requests carry an id and are
  // answered in one of two ways by the addon: either synchronously through
  // the pycmd callback (small requests, older addon versions), or — once
  // the background compile on the Python side has finished — through
  // window.__typstAnkiResolve(id, result).

  let compileSeq = 0;
  const compileCallbacks = new Map();

  window.__typstAnkiResolve = (id, result) => {
    const cb = compileCallbacks.get(id);
    if (cb) {
      compileCallbacks.delete(id);
      cb(result);
    }
  };

  // ----- local incremental compiler channel ----- //
  //
  // The addon hosts the Typst WASM compiler in a hidden page served from
  // the addon's own web exports (editor pages themselves run under a CSP
  // that forbids WebAssembly). Both pages share an origin and browser
  // profile, so a BroadcastChannel connects them: compiles are answered
  // by the incremental compiler with no Python in the loop. Everything
  // that is not ready, times out, or reports a structural failure falls
  // back to the Python bridge below.

  const LOCAL_CHANNEL = "typst-anki-compiler";
  const LOCAL_TIMEOUT_MS = 1500;

  let localChannel = null;
  let localReady = false;
  const localPending = new Map(); // id -> callback

  (function initLocalChannel() {
    if (typeof BroadcastChannel !== "function") {
      return; // e.g. jsdom or an old webview: Python bridge only
    }
    try {
      localChannel = new BroadcastChannel(LOCAL_CHANNEL);
      localChannel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") {
          return;
        }
        if (msg.type === "ready") {
          localReady = true;
          return;
        }
        if (msg.type !== "result") {
          return;
        }
        const cb = localPending.get(msg.id);
        if (cb) {
          localPending.delete(msg.id);
          cb(msg);
        }
      };
      localChannel.postMessage({ type: "ping" });
    } catch (err) {
      localChannel = null;
    }
  })();

  function compileLocal(id, source, block, render) {
    // Resolves with the compiler page's result, or with null when it is
    // unavailable — the caller then compiles through the Python bridge.
    return new Promise((resolve) => {
      if (!localChannel || !localReady || render === "mathml") {
        // MathML is always compiled by the Python bridge: the WASM
        // compiler does not expose Typst's HTML export.
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        localPending.delete(id);
        localReady = false; // re-probe via ping below
        if (localChannel) {
          localChannel.postMessage({ type: "ping" });
        }
        resolve(null);
      }, LOCAL_TIMEOUT_MS);
      localPending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.fallback) {
          resolve(null);
          return;
        }
        resolve(msg);
      });
      localChannel.postMessage({ type: "compile", id, source, block, render });
    });
  }

  // Compile Typst source. The addon answers in one of three ways, in
  // order of preference: the local incremental compiler page (over the
  // BroadcastChannel), synchronously through the pycmd callback, or —
  // once a background compile finishes — via window.__typstAnkiResolve.
  async function compileTypst(source, block, render, cb) {
    const localId = ++compileSeq;
    const local = await compileLocal(localId, source, block, render);
    if (local !== null) {
      cb(local);
      return;
    }
    if (typeof pycmd !== "function") {
      cb({ ok: false, error: "Anki bridge (pycmd) is unavailable" });
      return;
    }
    const id = ++compileSeq;
    compileCallbacks.set(id, cb);
    pycmd(
      BRIDGE_PREFIX + JSON.stringify({ source, block, render, id }),
      (res) => {
        if (!res || res.__pending) {
          return; // the result will arrive via __typstAnkiResolve
        }
        const pending = compileCallbacks.get(id);
        if (pending) {
          compileCallbacks.delete(id);
          pending(res);
        }
      }
    );
  }

  function bind(el, event, handler, capture) {
    el.addEventListener(event, handler, capture);
    return () => el.removeEventListener(event, handler, capture);
  }

  // The Selection of the tree `node` lives in. The new editor's editable —
  // and with it every <anki-typst> — lives inside a shadow root, whose
  // caret positions only its own getSelection() exposes (the same approach
  // as Anki's @tslib/cross-browser).
  function getSelectionIn(node) {
    const root = node.getRootNode();
    return root && root.getSelection ? root.getSelection() : document.getSelection();
  }

  // Place the caret inside `el` at "start" or "end".
  function setCaret(el, position) {
    // <textarea>: use the native API; a document Selection can not
    // represent positions inside a shadow tree.
    if (typeof el.setSelectionRange === "function") {
      const offset = position === "start" ? 0 : el.value.length;
      el.setSelectionRange(offset, offset);
      return;
    }
    const sel = getSelectionIn(el);
    if (!sel) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(position === "start");
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Whether a collapsed caret placed against `node` renders visibly:
  // text and inline content can host it; block-level content (block
  // elements, and equations/frames carrying a block attribute) would leave
  // the caret stranded at a block boundary again. Mirrors Anki's
  // `elementIsBlock`.
  function canHostCaret(node) {
    if (!node) {
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    if (node.hasAttribute("block")) {
      return false;
    }
    switch (node.tagName) {
      case "ADDRESS":
      case "ARTICLE":
      case "ASIDE":
      case "BLOCKQUOTE":
      case "DD":
      case "DIV":
      case "DL":
      case "DT":
      case "FIELDSET":
      case "FIGCAPTION":
      case "FIGURE":
      case "FOOTER":
      case "FORM":
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
      case "HEADER":
      case "HR":
      case "LI":
      case "MAIN":
      case "NAV":
      case "OL":
      case "P":
      case "PRE":
      case "SECTION":
      case "TABLE":
      case "UL":
        return false;
      default:
        return true;
    }
  }

  // All upgraded elements on the page; used by the arrow-key handler below.
  const elements = new Set();

  // Whether the caret sits exactly at `el`'s boundary ("before": at its
  // start, "after": at its end). Walks up from the caret's container to
  // `el`'s parent: at every level the caret must be at the very start (for
  // "after") or very end (for "before") of the intermediate node.
  function caretAdjacent(el, side) {
    const sel = getSelectionIn(el);
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0 || !sel.focusNode) {
      return false;
    }
    let node = sel.focusNode;
    let offset = sel.focusOffset;

    // Normalize text-node carets to a child position in their parent.
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.data.length;
      if (side === "before" ? offset !== length : offset !== 0) {
        return false; // caret strictly inside the text, or wrong boundary
      }
      const parent = node.parentElement;
      if (!parent) {
        return false;
      }
      offset =
        Array.prototype.indexOf.call(parent.childNodes, node) + (offset === length ? 1 : 0);
      node = parent;
    }

    // Climb towards el's parent; the caret must be at the boundary all the way.
    while (node !== el.parentElement) {
      if (node.nodeType !== Node.ELEMENT_NODE || node === document.documentElement) {
        return false;
      }
      const atBoundary = side === "before" ? offset === node.childNodes.length : offset === 0;
      if (!atBoundary) {
        return false;
      }
      const parent = node.parentNode;
      if (!parent) {
        return false;
      }
      offset = Array.prototype.indexOf.call(parent.childNodes, node);
      node = parent;
    }

    const index = Array.prototype.indexOf.call(node.childNodes, el);
    return side === "before" ? offset === index : offset === index + 1;
  }

  // Moving the caret into an equation with the arrow keys opens its source
  // editor, like native MathJax equations do.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      for (const el of elements) {
        if (el.__editing) {
          continue;
        }
        if (event.key === "ArrowRight" && caretAdjacent(el, "before")) {
          event.preventDefault();
          event.stopPropagation();
          el.enterEdit("start");
          return;
        }
        if (event.key === "ArrowLeft" && caretAdjacent(el, "after")) {
          event.preventDefault();
          event.stopPropagation();
          el.enterEdit("end");
          return;
        }
      }
    },
    true
  );

  // Move the caret right after `el`, so typing continues in the field after
  // committing an equation.
  function placeCaretAfter(el) {
    placeCaret(el, (range) => {
      range.setStartAfter(el);
      range.collapse(true);
    });
  }

  // Move the caret right before `el`.
  function placeCaretBefore(el) {
    placeCaret(el, (range) => {
      range.setStartBefore(el);
      range.collapse(true);
    });
  }

  function placeCaret(el, place) {
    const sel = getSelectionIn(el);
    if (!sel) {
      return;
    }
    const range = document.createRange();
    place(range);
    sel.removeAllRanges();
    try {
      sel.addRange(range);
    } catch (err) {
      // The webview's caret logic may refuse the position; ignore.
    }
  }

  // ----- new editor (26.08+) integration ----- //
  //
  // While a Typst equation is being edited, the field's DOM mirror must be
  // suspended (see the header comment). The runtime package `anki/RichTextInput`
  // exposes the mounted field inputs; each offers `preventResubscription()`,
  // which suspends the mirror until the returned callback is invoked — the
  // very mechanism Anki's native MathJax overlay uses while its editor is
  // open. Sessions are refcounted per field so that closing one editor and
  // immediately opening another (e.g. clicking a different equation) keeps
  // the mirror suspended throughout the transition.

  const mirrorHolds = new Map(); // RichTextInput -> { count, restore }

  function richTextInputs() {
    try {
      if (typeof require !== "function") {
        return []; // legacy editor pages have no runtime packages
      }
      const pkg = require("anki/RichTextInput");
      return Array.isArray(pkg.instances) ? pkg.instances : [];
    } catch (err) {
      return [];
    }
  }

  // The RichTextInput whose editable contains `node`, if any.
  async function richTextInputOf(node) {
    for (const input of richTextInputs()) {
      try {
        const editable = await input.element;
        if (editable && (editable === node || editable.contains(node))) {
          return input;
        }
      } catch (err) {
        // element promise rejected; try the next input
      }
    }
    return null;
  }

  // Suspend the field's DOM mirror while an equation is being edited.
  function holdMirror(input) {
    let hold = mirrorHolds.get(input);
    if (!hold) {
      hold = { count: 0, restore: null };
      mirrorHolds.set(input, hold);
    }
    if (hold.count === 0) {
      hold.restore = input.preventResubscription();
    }
    hold.count++;
  }

  // Resume the field's DOM mirror. Deferred to the next task so that a
  // focus change caused by the very interaction that closed the editor
  // (clicking into the field, or into another equation) settles first: if
  // the editable is focused by then, the mirror does not replace the
  // field content at all, and the click lands where the user aimed it.
  function releaseMirror(input) {
    const hold = mirrorHolds.get(input);
    if (!hold || hold.count === 0) {
      return;
    }
    hold.count--;
    if (hold.count > 0) {
      return;
    }
    mirrorHolds.delete(input);
    const restore = hold.restore;
    setTimeout(() => {
      // A newer edit session on the same field took over the hold; its own
      // release will resume the mirror.
      if (mirrorHolds.has(input)) {
        return;
      }
      try {
        restore && restore();
      } catch (err) {
        // best effort; the editor was likely torn down
      }
    }, 0);
  }

  // The floating panel lives on <body>, outside any shadow root; its
  // styles therefore need a page-level <style> (added once per page).
  function ensurePanelStyles() {
    if (document.getElementById(PANEL_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      .${PANEL_CLASS} {
        position: fixed;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 16em;
        max-width: 32em;
        padding: 6px;
        border: 1px solid var(--border, #7a8bc4);
        border-radius: 6px;
        /* Anki's theme variables (see ts/lib/sass/_root-vars.scss); the
           fallbacks only apply where they do not exist (legacy pages). */
        background: var(--canvas-elevated, var(--canvas, #fff));
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
        font-size: 0.95em;
        color: var(--fg, inherit);
      }
      .${PANEL_CLASS} .src {
        font-family: ui-monospace, monospace;
        min-height: 1.6em;
        max-height: 8em;
        width: 100%;
        resize: none;
        overflow: auto;
        outline: 1px dashed var(--fg-subtle, #999);
        padding: 2px 4px;
        box-sizing: border-box;
        background: transparent;
        color: inherit;
        border: none;
      }
      .${PANEL_CLASS} .error { color: var(--accent-danger, #c62828); font-size: 0.85em; white-space: pre-wrap; }
      .${PANEL_CLASS} .hint { color: var(--fg-subtle, #888); font-size: 0.75em; }
    `;
    document.head.appendChild(style);
  }

  // Visible stand-in while there is nothing to render (freshly inserted
  // equation, or its source was emptied): an empty render would be
  // invisible and leave nothing to click or arrow into.
  function placeholderHtml() {
    return (
      '<span style="display:inline-block;min-width:2.5em;padding:0 8px;' +
      "border:1px dashed var(--fg-subtle, #999);border-radius:3px;" +
      "color:var(--fg-subtle, #999);font-size:0.8em;text-align:center;" +
      '">(typst)</span>'
    );
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Stand-in for a source that does not compile: the source itself, in
  // red, so broken equations show what is wrong instead of silently
  // keeping an outdated (or no) render.
  function errorHtml(source) {
    return (
      '<span style="display:inline-block;max-width:100%;padding:0 4px;' +
      "border:1px dashed var(--accent-danger, #c62828);border-radius:3px;" +
      "color:var(--accent-danger, #c62828);font-family:ui-monospace,monospace;" +
      "font-size:0.8em;white-space:pre-wrap;text-align:center;" +
      `">${escapeHtml(source)}</span>`
    );
  }

  class AnkiTypst extends HTMLElement {
    connectedCallback() {
      elements.add(this);
      if (this.__initialized) {
        return;
      }
      this.__initialized = true;
      // Never let the surrounding contenteditable place a caret inside the
      // stored light DOM; all editing happens in the panel below.
      this.contentEditable = "false";
      if (!this.shadowRoot) {
        this.attachShadow({ mode: "open" });
      }
      this.__onDisplayClick = () => this.enterEdit("end");
      this.__showDisplay();
      this.__refreshIfStale();
      if (this.hasAttribute("focusonmount")) {
        this.removeAttribute("focusonmount");
        setTimeout(() => this.enterEdit("end"));
      }
    }

    disconnectedCallback() {
      elements.delete(this);
      clearTimeout(this.__errorTimer);
      // The element left the field (note closed/re-rendered); drop the
      // floating panel and the mirror hold with it.
      if (this.__panel) {
        this.__unbind && this.__unbind.forEach((unbind) => unbind());
        this.__unbind = [];
        this.__panel.remove();
        this.__panel = null;
        this.__editing = false;
        this.__releaseMirror();
      }
    }

    get isBlock() {
      return this.getAttribute("block") === "true";
    }

    // ----- display mode: show the baked render (a <slot> reveals the
    // ----- stored light DOM child) ----- //
    __showDisplay() {
      this.__editing = false;
      const shadow = this.shadowRoot;
      const source = (this.dataset.typst || "").trim();
      if (this.__errorSource != null) {
        // The stored source does not compile: show it in red instead of a
        // stale render. In block mode the error is centered like the
        // render would be.
        shadow.innerHTML = `
          <style>
            :host { display: inline-block; }
            :host([block="true"]) { display: block; text-align: center; }
          </style>
          ${errorHtml(this.__errorSource)}`;
      } else if (this.children.length && source) {
        shadow.innerHTML = `
          <style>
            :host { display: inline-block; }
            :host([block="true"]) { display: block; }
            slot::slotted(img) { vertical-align: middle; }
            slot::slotted(*) { max-width: 100%; }
          </style>
          <slot></slot>`;
      } else {
        // No source yet (freshly inserted equation, or one whose compile
        // failed): an empty MathML/SVG render would be invisible, so show a
        // visible, clickable placeholder instead. Block equations center
        // it, like they center their render.
        shadow.innerHTML = `
          <style>
            :host { display: inline-block; }
            :host([block="true"]) { display: block; text-align: center; }
          </style>
          ${placeholderHtml()}`;
      }
      this.removeEventListener("click", this.__onDisplayClick);
      this.addEventListener("click", this.__onDisplayClick);
    }

    // Recompile in the background if the stored render no longer matches
    // the stored source (source edited elsewhere, or a pending async
    // compile was interrupted by a save). A silent repair: it must not
    // mark the note dirty just because it was opened.
    __refreshIfStale() {
      const source = this.dataset.typst;
      if (source === undefined || this.dataset.renderSrc === source) {
        return;
      }
      if (!source.trim()) {
        // A fresh equation has no render yet; compiling the empty source
        // would only bake a meaningless empty <math> element. The
        // placeholder stays until something is typed.
        this.dataset.renderSrc = source;
        return;
      }
      compileTypst(source, this.isBlock, this.dataset.render, (res) => {
        if (!this.__editing && this.dataset.typst === source) {
          if (res.ok) {
            this.__applyRender(res.html, false);
          } else {
            // The stored render is stale and the source does not compile:
            // keep the baked render in the note, but show the erroneous
            // source in red.
            this.__errorSource = source;
            this.__showDisplay();
          }
        }
      });
    }

    // Replace the stored baked render. Only ever called outside of edit
    // mode, so the light DOM always stays in a serializable state.
    __applyRender(html, notify) {
      this.innerHTML = html;
      this.dataset.renderSrc = this.dataset.typst;
      this.__errorSource = null;
      if (!this.__editing) {
        // E.g. the placeholder is showing while a stale render compiles.
        this.__showDisplay();
      }
      if (notify) {
        // Notify the hosting editor that the field content changed.
        this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      }
    }

    // ----- edit mode: floating source panel (on <body>) + live-rendered
    // ----- equation (in the shadow root, in place) ----- //
    async enterEdit(caretPosition = "end") {
      if (this.__editing) {
        return;
      }
      this.__editing = true;
      this.removeEventListener("click", this.__onDisplayClick);

      // Suspend the field's DOM mirror *before* focusing the source panel:
      // the panel's textarea takes focus from the field's editable, whose
      // blur would otherwise replace the whole field content (destroying
      // this element and the panel with it). A no-op in editors without
      // the new editor's rich-text input.
      this.__richText = null;
      try {
        const input = await richTextInputOf(this);
        if (input) {
          this.__richText = input;
          holdMirror(input);
        }
      } catch (err) {
        // No rich-text input (e.g. legacy editor): nothing to suspend.
      }
      if (!this.isConnected) {
        // The field was re-rendered while the input was being located.
        this.__editing = false;
        this.__releaseMirror();
        return;
      }

      // In the field: the live-rendered equation, shown where the equation
      // belongs. In block mode the render container spans the whole field
      // width, so the block render (an image with auto margins, or display
      // MathML) is centered while editing, exactly like after committing.
      const shadow = this.shadowRoot;
      shadow.innerHTML = `
        <style>
          :host { display: inline-block; }
          :host([block="true"]) { display: block; }
          .inline-render { display: inline-block; }
          :host([block="true"]) .inline-render { display: block; text-align: center; }
          .inline-render img { vertical-align: middle; max-width: 100%; }
        </style>
        <div class="inline-render"></div>`;
      this.__inlineRender = shadow.querySelector(".inline-render");

      // Seed the live render with the currently stored render.
      for (const child of Array.from(this.children)) {
        this.__inlineRender.appendChild(child.cloneNode(true));
      }
      if (!this.__inlineRender.childNodes.length) {
        this.__inlineRender.innerHTML = placeholderHtml();
      }

      // The floating source editor, portaled to <body> like Anki's own
      // MathJax editor (see the header comment for why).
      ensurePanelStyles();
      const panel = document.createElement("div");
      panel.className = PANEL_CLASS;
      panel.innerHTML = `
        <textarea class="src" rows="1" spellcheck="false"></textarea>
        <div class="error" hidden></div>
        <div class="hint">Typst — Enter commits, Esc cancels, ←/→ at the edges move out</div>`;
      document.body.appendChild(panel);
      this.__panel = panel;
      this.__srcBox = panel.querySelector(".src");
      this.__error = panel.querySelector(".error");

      const source = this.dataset.typst || "";
      this.__lastGood = null;
      this.__dirty = false;
      this.__compileInFlight = false;
      this.__compileQueued = false;
      // A key is currently held down (auto-repeat): compiles are deferred
      // until it is released, so e.g. holding backspace does not recompile
      // for every intermediate deletion.
      this.__keyHeld = false;
      this.__compileDeferred = false;
      // Invalidates compile responses from previous editing sessions, which
      // may still arrive while the bridge is in flight.
      this.__compileEpoch = (this.__compileEpoch || 0) + 1;
      this.__errorTimer = null;
      this.__errorSource = null;
      this.__unbind = [
        bind(this.__srcBox, "input", () => this.__onInput()),
        bind(this.__srcBox, "keydown", (e) => this.__onKeyDown(e)),
        bind(this.__srcBox, "keyup", () => this.__onKeyUp()),
        bind(this.__srcBox, "blur", () => this.__finish(true, false)),
        bind(window, "scroll", () => this.__positionPanel(), true),
        bind(window, "resize", () => this.__positionPanel()),
        // Clicking anywhere outside the panel commits and closes, like
        // the native equation editor's closing click.
        bind(
          document,
          "click",
          (e) => {
            if (
              this.__editing &&
              this.__panel &&
              !this.__panel.contains(e.target) &&
              !this.contains(e.target)
            ) {
              this.__finish(true, false);
            }
          },
          true
        ),
      ];

      // A <textarea> is used as the source editor on purpose: it is
      // focusable and typeable even when the surrounding contenteditable
      // refuses a shadow-internal editable surface.
      this.__srcBox.value = source;
      try {
        this.__srcBox.focus();
        setCaret(this.__srcBox, caretPosition);
      } catch (err) {
        console.error("typst-anki: could not focus the source editor:", err);
      }
      this.__positionPanel();

      // The insertion path races with the editor's own focus handling (the
      // editor may refocus the field right after the bridge call, which
      // would instantly blur the source box). Re-assert focus for a short
      // while, unless the user interacted or focus moved elsewhere.
      let retries = 3;
      const refocus = () => {
        if (!this.__editing || this.__dirty) {
          return;
        }
        if (document.activeElement !== this.__srcBox && !this.__focusLeftPanel()) {
          this.__srcBox.focus();
        }
        if (--retries > 0) {
          setTimeout(refocus, 100);
        }
      };
      setTimeout(refocus, 100);

      // If the stored render is stale (or missing, e.g. for a freshly
      // inserted equation), render the source immediately.
      if (this.dataset.renderSrc !== source) {
        this.__compileCurrent();
      }
    }

    // Whether page focus moved outside this panel (e.g. the user clicked
    // another field) — in that case, do not steal focus back.
    __focusLeftPanel() {
      const active = document.activeElement;
      if (!active || active === document.body) {
        return false;
      }
      return !(this.__panel && this.__panel.contains(active));
    }

    __onKeyDown(e) {
      if (e.repeat) {
        // Auto-repeat: the key is being held down.
        this.__keyHeld = true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.__finish(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.__finish(false, false);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Like the native equation editor, moving the caret past the
        // start/end of the source commits and leaves the equation, with
        // the caret right before/after it, ready to keep moving.
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
          return;
        }
        const box = this.__srcBox;
        const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
        const atEnd =
          box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
        if (e.key === "ArrowLeft" && atStart) {
          e.preventDefault();
          this.__exitEdit("before");
        } else if (e.key === "ArrowRight" && atEnd) {
          e.preventDefault();
          this.__exitEdit("after");
        }
      }
    }

    // Commit and move the caret out of the equation (arrow-key exit).
    __exitEdit(side) {
      // While the rich-text api is still attached, keep the editable's
      // focus handler from restoring a stale caret position when the
      // editable is focused below.
      this.__flushCaret();
      this.__finish(true, false);
      if (!this.isConnected) {
        return; // e.g. the emptied equation was removed on commit
      }
      this.__placeCaretOut(side);
    }

    // Put the field caret right before/after the equation and hand focus
    // back to the field's editable. Focusing it explicitly is important:
    // placing a caret alone does not reliably focus the editable, and an
    // unfocused editable gets its content re-cloned from the field store
    // when the DOM mirror resumes — which would destroy the placed caret
    // and drop the user somewhere else in the field.
    __placeCaretOut(side) {
      const editable = this.closest("[contenteditable='true']");
      if (editable) {
        try {
          editable.focus();
        } catch (err) {
          // best effort; the caret placement below still applies
        }
      }
      if (this.isBlock) {
        this.__placeCaretBesideBlock(side);
      } else if (side === "before") {
        placeCaretBefore(this);
      } else {
        placeCaretAfter(this);
      }
    }

    // A collapsed caret placed directly before/after a block-level equation
    // has no line of its own to render on, so the text cursor would be
    // invisible. Like the native editor (FrameElement.insertLineBreak),
    // move it onto the neighbouring line instead — the end of the previous
    // line / start of the next line if one exists there, otherwise a fresh
    // <br> inserted next to the equation.
    __placeCaretBesideBlock(side) {
      const br = document.createElement("br");
      let focus = null;
      if (side === "before") {
        const previous = this.previousSibling;
        focus = canHostCaret(previous)
          ? previous
          : this.insertAdjacentElement("beforebegin", br);
        if (focus) {
          placeCaretAfter(focus);
        } else {
          placeCaretBefore(this);
        }
      } else {
        const next = this.nextSibling;
        focus = canHostCaret(next) ? next : this.insertAdjacentElement("afterend", br);
        if (focus) {
          placeCaretBefore(focus);
        } else {
          placeCaretAfter(this);
        }
      }
    }

    __onKeyUp() {
      if (!this.__keyHeld) {
        return;
      }
      this.__keyHeld = false;
      if (this.__compileDeferred) {
        // The held key changed the source; compile the final state now.
        this.__compileDeferred = false;
        if (this.__editing) {
          this.__compileCurrent();
        }
      }
    }

    __onInput() {
      this.__dirty = true;
      this.__error.hidden = true;
      // Grow the textarea with its content (capped by max-height).
      this.__srcBox.style.height = "auto";
      this.__srcBox.style.height = `${this.__srcBox.scrollHeight}px`;
      if (this.__keyHeld) {
        // Live preview: compile on every keystroke — except while a key
        // is being held down (auto-repeat, e.g. holding backspace):
        // compile once when it is released.
        this.__compileDeferred = true;
        return;
      }
      this.__compileCurrent();
    }

    __compileCurrent() {
      const source = this.__sourceText();
      clearTimeout(this.__errorTimer);
      if (!source.trim()) {
        // Nothing typed yet: keep showing the placeholder instead of
        // rendering an empty equation.
        this.__inlineRender.innerHTML = placeholderHtml();
        this.__error.hidden = true;
        return;
      }
      if (this.__compileInFlight) {
        // A compile is already running; the queued recompile below picks
        // up the latest source once it finishes, so rapid keystrokes
        // coalesce into the final one instead of piling up requests.
        this.__compileQueued = true;
        return;
      }
      this.__compileInFlight = true;
      const epoch = this.__compileEpoch;
      compileTypst(source, this.isBlock, this.dataset.render, (res) => {
        if (epoch !== this.__compileEpoch) {
          return; // the editing session this compile belonged to is over
        }
        this.__compileInFlight = false;
        if (this.__compileQueued) {
          this.__compileQueued = false;
          this.__compileCurrent();
          return;
        }
        if (!this.__editing || this.__sourceText() !== source) {
          return; // a newer keystroke superseded this compile
        }
        if (res.ok) {
          this.__errorSource = null;
          this.__lastGood = { source, html: res.html };
          this.__inlineRender.innerHTML = res.html;
          this.__error.hidden = true;
        } else {
          this.__error.textContent = res.error || "Typst compile failed";
          this.__error.hidden = false;
          // Only swap the equation over to the erroneous source once the
          // user has settled on it; intermediate broken states while
          // typing must not make the equation flicker between the red
          // source and a render.
          this.__errorTimer = setTimeout(() => {
            if (this.__editing && this.__sourceText() === source) {
              this.__errorSource = source;
              this.__inlineRender.innerHTML = errorHtml(source);
              this.__positionPanel();
            }
          }, ERROR_DISPLAY_DELAY_MS);
        }
        // The live render's size (and with it a block equation's center)
        // changed; follow it with the source panel.
        this.__positionPanel();
      });
    }

    __positionPanel() {
      const rect = this.getBoundingClientRect();
      if (!this.__panel || (!rect.width && !rect.height)) {
        return;
      }
      const margin = 8;
      const panel = this.__panel;
      let top = rect.bottom + 6;
      let left;
      if (this.isBlock) {
        // The source editor sits centered under block equations, whose
        // render is centered as well.
        left = rect.left + rect.width / 2 - panel.offsetWidth / 2;
        left = Math.max(
          margin,
          Math.min(left, window.innerWidth - panel.offsetWidth - margin)
        );
      } else {
        left = rect.left;
        if (left + panel.offsetWidth > window.innerWidth - margin) {
          left = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
        }
      }
      if (top + panel.offsetHeight > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - panel.offsetHeight - 6);
      }
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
    }

    // Resume the field's DOM mirror when the editing session ends.
    __releaseMirror() {
      if (this.__richText) {
        releaseMirror(this.__richText);
        this.__richText = null;
      }
    }

    // Keep the editable from restoring a stale caret position when the
    // caret is placed programmatically after committing (the native
    // equation editor calls the same API before moving its caret).
    __flushCaret() {
      try {
        this.__richText?.editable?.focusHandler?.flushCaret?.();
      } catch (err) {
        // best effort
      }
    }

    __finish(commit, moveCaret) {
      if (!this.__editing) {
        return;
      }
      clearTimeout(this.__errorTimer);
      this.__compileQueued = false;
      this.__compileDeferred = false;
      this.__unbind.forEach((unbind) => unbind());
      this.__unbind = [];
      if (this.__panel) {
        this.__panel.remove();
        this.__panel = null;
      }

      if (commit) {
        const source = this.__sourceText();

        if (!source.trim()) {
          // An empty equation is only removed when the user deliberately
          // emptied it. Right after insertion (nothing typed yet), a blur
          // may fire spuriously while the editor settles its focus — keep
          // the element in that case, showing its placeholder.
          if (this.__dirty) {
            this.__editing = false;
            this.__releaseMirror();
            this.remove();
            this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
            return;
          }
        } else {
          this.dataset.typst = source;
          if (this.__lastGood && this.__lastGood.source === source) {
            this.__applyRender(this.__lastGood.html, true);
          } else {
            // No up-to-date render yet (e.g. blur immediately after typing):
            // keep showing the old render, then swap in the fresh one — or,
            // if the committed source does not compile, show it in red.
            compileTypst(source, this.isBlock, this.dataset.render, (res) => {
              if (!this.__editing && this.dataset.typst === source) {
                if (res.ok) {
                  this.__applyRender(res.html, true);
                } else {
                  this.__errorSource = source;
                  this.__showDisplay();
                }
              }
            });
          }
        }
      }
      this.__showDisplay();
      if (commit && moveCaret) {
        this.__flushCaret();
        this.__placeCaretOut("after");
      }
      this.__releaseMirror();
    }

    __sourceText() {
      // The source editor is a <textarea>; its value already serializes
      // line breaks literally.
      const raw =
        this.__srcBox.value !== undefined ? this.__srcBox.value : this.__srcBox.textContent;
      return (raw || "").replace(/\u00a0/g, " ");
    }
  }

  customElements.define("anki-typst", AnkiTypst);
})();
