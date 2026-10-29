import base64
import os
import re
import sys
import tempfile
from enum import Enum
from functools import partial
from pathlib import Path

from aqt import mw
from aqt.editor import Editor
from aqt.gui_hooks import editor_did_init_shortcuts
from aqt.utils import showInfo

from .anki_version_detection import anki_point_version
from .live_typst import is_new_editor
from .preamble_edit_dialog import PreambleEditDialog

addon_path = os.path.dirname(__file__)
sys.path.append(os.path.join(addon_path, "lib"))

import typst

config = mw.addonManager.getConfig(__name__) or {
    "render-type": "svg",
    "adaptive-color": True,
    "preamble": "user_files/preamble.typ",
}
preamble = Path(os.path.join(os.path.dirname(__file__), config["preamble"])).read_text()


# ----- Conversion utility: Typst -> MathML, Typst -> SVG, SVG -> Base64. ----- #


class Export(Enum):
    MATHML = 1
    SVG = 2


def gen_typst_math(typst_math: str, render_type: Export, display_math: bool) -> str:
    """Top-level function for generating the typst math rendering from the input string.

    Calls either the MathML export or the SVG compilation depending on `render_type`.
    """

    stripped = typst_math.strip()

    # The SVG export crops at the page rectangle, and with `page(height:
    # auto)` the page is only as tall as the *layout box* of the content:
    # - inline math `$x$` is laid out as a text line, so anything taller
    #   than the line box (fraction parts, script placement, big operators)
    #   is culled. Wrapping the inline-styled equation in a block equation
    #   instead (`#math.equation(math.inline(...), block: true)`) keeps the
    #   compact inline layout while sizing the page to the full ink.
    # - display math `$ x $` is a block whose layout box already contains
    #   all of its ink, so it needs no wrapper.
    if display_math:
        equation = f"$ {stripped} $"
    elif render_type == Export.SVG:
        equation = f"#math.equation(math.inline(${typst_math}$), block: true)"
    else:
        equation = f"${typst_math}$"
    final_code = preamble + "\n" + equation

    # Create temp file for typst code.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".typ") as tmp:
        tmp.write(final_code)
        tmp.flush()

        output = typst.compile(
            tmp.name, format="svg" if render_type == Export.SVG else "html"
        )

        if render_type == Export.SVG:
            return svg_to_base64_img(output, display_math)

        # Typst's HTML export wraps the MathML in a full HTML document
        # (<head>, meta tags, stylesheets); only the <math> element itself
        # belongs in the note field.
        mathml = re.search(r"<math\b.*</math>", output.decode(), re.DOTALL)
        return (
            mathml.group(0)
            if mathml
            else output.decode().replace("<p>", "").replace("</p>", "")
        )


# Injected into every baked SVG: the equation's color follows the theme of
# whichever client displays it — the same note renders dark text on a light
# theme and light text on a dark one, even without the addon installed.
# Browsers honor prefers-color-scheme inside <img>-embedded SVGs based on
# the embedding page's color-scheme, which Anki sets on all its webviews.
# Like MathML (which is colored by the browser via currentColor), the
# preamble's text color does not apply to baked equations.
SVG_THEME_STYLE = (
    "<style>"
    "*:not([fill=none]) { fill: #1e1e1e; }"
    "*[stroke]:not([stroke=none]) { stroke: #1e1e1e; }"
    "@media (prefers-color-scheme: dark) {"
    "*:not([fill=none]) { fill: #f2f2f2; }"
    "*[stroke]:not([stroke=none]) { stroke: #f2f2f2; }"
    "}"
    "</style>"
)


def svg_to_base64_img(svg: bytes, display_math=False) -> str:
    """Returns an HTML img tag with the `svg` byte sequence encoded as base64 as the source."""

    svg_text = svg.decode()

    # Carry the SVG's intrinsic size over as width/height attributes: a
    # data-URI img has no dimensions until it has loaded, so it collapses
    # in the layout first and pops open later — visibly shifting the field
    # and e.g. making the source panel jump over the equation between
    # rerenders. With the attributes the layout is correct immediately.
    dims = ""
    m = re.search(r'width="([\d.]+)pt" height="([\d.]+)pt"', svg_text)
    if m:
        # CSS points -> pixels (1pt = 4/3px at the default 96dpi).
        w_px = round(float(m.group(1)) * 4 / 3, 3)
        h_px = round(float(m.group(2)) * 4 / 3, 3)
        dims = f' width="{w_px}" height="{h_px}"'

    # The theme-adaptive color style goes right inside the SVG root, so
    # it applies wherever the equation is displayed, with or without the
    # addon. Disabled via the "adaptive-color" config option, in which
    # case the compiled color (the preamble's) is kept.
    if config.get("adaptive-color", True):
        head_end = svg_text.index(">")
        svg_text = svg_text[: head_end + 1] + SVG_THEME_STYLE + svg_text[head_end + 1 :]

    svg_b64 = "data:image/svg+xml;base64," + base64.b64encode(svg_text.encode()).decode()
    return (
        f'<img style="vertical-align: middle;"{dims} src="{svg_b64}">'
        if not display_math
        else f'<img style="display: block; margin-left: auto; margin-right: auto;"{dims} src="{svg_b64}">'
    )


# ----- Editor input. ----- #


def insert_live_element_js(display_math: bool) -> str:
    """Returns the JS snippet inserting an empty `<anki-typst>` at the caret.

    No dialog is involved: the element upgrades right away and opens its
    floating source editor (`focusonmount`); the equation renders inline in
    the field while the source is typed. The current selection, if any,
    becomes the initial Typst source.

    The new editor (Anki 26.08+) keeps its editables inside shadow roots:
    `document.querySelector` cannot reach them, and the caret must be read
    from the shadow root's own Selection (the same approach as Anki's
    editor code). When the field has lost its caret — e.g. when triggered
    from the equations menu — the first rich-text field is focused and the
    caret placed at its end. In the new editor's plain-text mode there is
    no rich-text field to insert into; the native equations menu is
    disabled there as well, so insertion is skipped too.
    """

    render = str(config.get("render-type", "svg")).lower()
    block = "true" if display_math else "false"

    js_body = f"""
(async () => {{
    function selectionOf(node) {{
        const root = node.getRootNode();
        return root && root.getSelection ? root.getSelection() : window.getSelection();
    }}

    // The active editable, piercing the new editor's shadow roots.
    function activeEditable() {{
        const active = document.activeElement;
        const candidates =
            active && active.shadowRoot ? [active.shadowRoot.activeElement, active] : [active];
        for (const el of candidates) {{
            if (el && el.getAttribute && el.getAttribute("contenteditable") === "true") {{
                return el;
            }}
        }}
        return null;
    }}

    // Whether `el` belongs to one of the new editor's rich-text fields.
    // Falls back to true where the runtime package does not exist
    // (legacy editor and other stdHtml editors).
    async function isRichTextEditable(el) {{
        try {{
            const inputs = require("anki/RichTextInput").instances || [];
            for (const input of inputs) {{
                const editable = await input.element;
                if (editable && (editable === el || editable.contains(el))) {{
                    return true;
                }}
            }}
            return false;
        }} catch (err) {{
            return true;
        }}
    }}

    // First editable field, for the menu path where the caret was lost.
    async function firstEditable() {{
        const plain = document.querySelector("[contenteditable='true']");
        if (plain) {{
            return plain;
        }}
        try {{
            const inputs = require("anki/RichTextInput").instances || [];
            for (const input of inputs) {{
                const editable = await input.element;
                if (editable && editable.getAttribute("contenteditable") === "true") {{
                    return editable;
                }}
            }}
        }} catch (err) {{}}
        return null;
    }}

    let editable = activeEditable();
    let sel = editable ? selectionOf(editable) : window.getSelection();
    const hasCaret =
        editable && sel && sel.anchorNode && editable.contains(sel.anchorNode);
    if (!hasCaret) {{
        editable = await firstEditable();
        if (!editable) {{
            return;
        }}
        editable.focus();
        sel = selectionOf(editable);
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }}
    // Plain-text fields (the new editor's CodeMirror input) hold no
    // equations; the native menu is disabled there as well.
    if (!(await isRichTextEditable(editable))) {{
        return;
    }}

    const src = sel.toString().trim().replace(/^\\$+/, "").replace(/\\$+$/, "");
    const el = document.createElement("anki-typst");
    el.setAttribute("data-typst", src);
    el.setAttribute("data-render", "{render}");
    el.setAttribute("block", "{block}");
    el.setAttribute("focusonmount", "1");
    document.execCommand("insertHTML", false, el.outerHTML);
}})();
"""

    return (
        js_body
        if anki_point_version <= 49
        else f"setTimeout(() => {{ {js_body} }}, 50);"
    )


def typst_editor(editor: Editor, display_math=False):
    """Insert a live, re-editable `<anki-typst>` equation at the caret.

    Nothing is finalized and no window opens: the equation renders inline in
    the field right away, and its Typst source is edited in a small floating
    panel *inside* the editor webview (see `web/typst-element.js`). The
    equation can be re-entered and edited at any time — including after
    saving the card and reopening Anki.
    """

    if editor.web is None:
        showInfo("Web view of editor could not be initialized!")
        return

    editor.web.setFocus()
    editor.web.eval(insert_live_element_js(display_math))


def settings_cb():
    """Callback for opening the "Edit preamble" dialog."""

    global preamble

    # Parented to the main window: the dialog opens from a webview bridge
    # callback, and a parentless dialog can end up behind the Anki window
    # (or without focus) on some desktops — it looks like the click did
    # nothing.
    preamble_settings = PreambleEditDialog(mw, preamble=preamble)
    full_preamble_path = Path(
        os.path.join(os.path.dirname(__file__), config["preamble"])
    )

    if preamble_settings.exec():
        preamble = preamble_settings.input.toPlainText()
        with open(full_preamble_path, "w") as f:
            f.write(preamble)
            f.flush()

        # Propagate the edit to the incremental compiler webview (it
        # keeps its own copy of the preamble).
        try:
            from . import compiler_webview

            compiler_webview.set_preamble(preamble)
        except Exception:
            pass


# ----- Registration of GUI hooks for shortcuts. ----- #


def shortcut_hook(keys: list[tuple], editor: Editor):
    """Initialize and add shortcuts to the global shortcut hook.

    Legacy editor only: there, Qt chord shortcuts coexist with the native
    ones. The new editor (26.08+) handles shortcuts inside the webview — Qt
    chord shortcuts here would swallow the shared "Ctrl+M" prefix and break
    the native chords — so its shortcuts are registered by `live_typst`
    instead (see `web/typst-new-editor.js`).
    """

    if is_new_editor(editor):
        return

    keys.extend(
        [
            ("Ctrl+M, T", partial(typst_editor, editor)),
            ("Ctrl+M, B", partial(typst_editor, editor, True)),
        ]
    )


# All Typst entries live in the native "Equations" menu: appended to the
# new/legacy editor's in-webview equations popover by
# `web/typst-new-editor.js`, and to the legacy editor's QMenu by
# `live_typst._append_typst_menu_actions`.


editor_did_init_shortcuts.append(shortcut_hook)


# ----- Live `<anki-typst>` element: JS injection and Typst compile bridge. ----- #

try:
    addon_package = mw.addonManager.addonFromModule(__name__)
except Exception:
    # Fallback for exotic setups; the package directory is the addon's name.
    addon_package = "typst-anki"

try:
    # Serve web/typst-element.js to stdHtml editor pages (legacy editor,
    # previewer, card layout) via the media server. Without registered web
    # exports the /_addons/...js request 404s and the element never upgrades.
    mw.addonManager.setWebExports(__name__, r"web/.*")
except Exception:
    pass

from .live_typst import setup as setup_live_typst

setup_live_typst(
    addon_package,
    config,
    gen_typst_math,
    Export,
    insert_equation=typst_editor,
    edit_preamble=settings_cb,
)

from . import compiler_webview

compiler_webview.setup(addon_package, config, preamble)
