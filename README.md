# typst-anki

Type `Typst` math directly in the Anki editor and get **live, re-editable equations** — no dialogs, no finalized renders. Press <kbd>Ctrl + M, T</kbd> (<kbd>Ctrl+M, B</kbd> for a block equation) or pick `Typst Math` from the editor's `Equations` menu: an equation is inserted at the caret and a small floating source editor opens *inside* the editor webview. While you type, the equation is rendered live as SVG/MathML inline in the field (as a centered block in block mode). <kbd>Enter</kbd> commits, <kbd>Esc</kbd> reverts; click the equation any time — even after saving the card and reopening Anki — to re-open its source.

Add custom functions inside [`preamble.typ`](src/typst-anki/user_files/preamble.typ)—make sure to change your text color according to your system theme!

Compatible with Anki 24.11 through 26.09+, including the new editor introduced in Anki 26.08.

<p align="center">
    <img src="images/image-2.png", width=30%>
    <img src="images/image-4.png", width=30%>
    <img src="images/image-3.png", width=30%>
</p>

## Installation

```sh
git clone git@github.com:xkevio/typst-anki.git
cd typst-anki/src/typst-anki

mkdir lib # <- this stores external dependencies for Anki.
pip install typst -t ./lib/
zip -r typst-anki.zip ./*
```

Then, open Anki > Tools > Addons > Install from file > `typst_anki.zip`.
Or, if you wish, use [`just`](https://github.com/casey/just).

## Features

- [x] **Live equations, no dialogs**: `Ctrl+M, T` / `Ctrl+M, B` insert a `<anki-typst>` element at the caret (wrapping the current selection, if any). The equation renders inline in the field while its Typst source is edited in a small floating panel inside the editor webview. Click an equation — or move the caret into it with the arrow keys — to re-edit it; <kbd>Enter</kbd> commits, <kbd>Esc</kbd> reverts, committing an empty equation deletes it.
- [x] **Native menu integration**: the Typst entries also appear in the editor's "Equations" menu (Mathjax Inline, Mathjax Block, ..., Latex Math Env) and can be clicked there instead of using the shortcuts. In the new editor (26.08+), where all editor shortcuts are handled inside the webview, the Typst shortcuts are registered the same way — so the native MathJax/Latex chords keep working.
- [x] `Ctrl+M, R` converts raw `$...$` code in the current field into the same re-editable equations — non-destructively, keeping the Typst source.
- [x] Use Typst HTML export to utilize MathML (since Typst v0.15.0), or Typst SVG export to ensure the same visual look everywhere.
- [x] **Instant live preview via an embedded incremental compiler**: the addon bundles the Typst WASM compiler (typst.ts, same Typst 0.15 as the Python binding) and runs it in a hidden webview that shares the editors' browser profile. Because editor pages' Content-Security-Policy forbids WebAssembly, they send their compiles to that page over a `BroadcastChannel`, which answers in milliseconds — no Python in the compile loop. If the page is unavailable, compiles transparently fall back to the Python bridge (compiled off the main thread); MathML renders always use the bridge, since the WASM compiler does not expose Typst's HTML export. This adds roughly 40 MB to the addon (compiler + fonts, bundled under `web/vendor/`).

### Live equations & portability

The `<anki-typst>` element stores the Typst source (`data-typst`, the source of truth) *together with a baked render* in the note field:

```html
<anki-typst data-typst="x^2 + 1" data-render="svg"><img src="data:image/svg+xml;base64,..."></anki-typst>
```

Because the render is baked in, cards display identically on **AnkiDroid, AnkiWeb and desktop Anki without the addon** — they simply show the baked SVG/MathML. Installing the addon turns the element back into a click-to-edit equation. A `data-render-src` hash lets the element silently recompile stale renders (e.g. after editing the source via the HTML editor).

Caveats of the prototype: compile requests run on the main thread (~100 ms per equation); cloze deletions inside an equation are not hidden on clients without the addon; deleting an equation is a single <kbd>Backspace</kbd>.
