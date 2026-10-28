import base64
import json
import os
import re
import sys
import tempfile
from enum import Enum
from functools import partial
from pathlib import Path

from aqt import QAction, QCursor, QKeySequence, QMenu, mw
from aqt.editor import Editor
from aqt.gui_hooks import (
    editor_did_init_buttons,
    editor_did_init_shortcuts,
)
from aqt.utils import showInfo

from .anki_version_detection import anki_point_version
from .preamble_edit_dialog import PreambleEditDialog
from .typst_input_dialog import TypstInputDialog

addon_path = os.path.dirname(__file__)
sys.path.append(os.path.join(addon_path, "lib"))

import typst

config = mw.addonManager.getConfig(__name__) or {
    "render-type": "mathml",
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

    # Pre-amble for inline typst math (TODO: handle display math better!).
    typst_math = (
        " " + typst_math + " "
        if display_math and render_type == Export.MATHML
        else typst_math.strip()
    )
    final_code = preamble + "\n" + f"${typst_math}$"

    # Create temp file for typst code.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".typ") as tmp:
        tmp.write(final_code)
        tmp.flush()

        output = typst.compile(
            tmp.name, format="svg" if render_type == Export.SVG else "html"
        )

        return (
            output.decode().replace("<p>", "").replace("</p>", "")
            if render_type == Export.MATHML
            else svg_to_base64_img(output, display_math)
        )


def svg_to_base64_img(svg: bytes, display_math=False) -> str:
    """Returns an HTML img tag with the `svg` byte sequence encoded as base64 as the source."""
    svg_b64 = "data:image/svg+xml;base64," + base64.b64encode(svg).decode()
    return (
        f'<img style="vertical-align: middle;" src="{svg_b64}">'
        if not display_math
        else f'<img style="display: block; margin-left: auto; margin-right: auto;" src="{svg_b64}">'
    )


# ----- Replace functionality, editor input and callback definition for the context menu. ----- #


def current_editor_note(editor: Editor):
    """Returns the note currently edited by `editor`, or None.

    The legacy editor (up to Anki 26.07) exposes the note directly via `.note`,
    while the new editor (Anki 26.08+) only stores the note id in `.nid`.
    """

    note = getattr(editor, "note", None)
    if note is not None:
        return note

    nid = getattr(editor, "nid", None)
    return mw.col.get_note(nid) if nid else None


def current_field_index(editor: Editor) -> int | None:
    """Returns the index of the field currently focused in `editor`.

    `currentField` is reset to None when the field loses focus, in which case
    the last focused field (`.last_field_index`) is used as a fallback.
    """

    index = editor.currentField
    if index is None:
        index = getattr(editor, "last_field_index", None)
    return index


def replace_in_current_field(editor: Editor):
    """Collects all text between dollar signs and converts it to MathML or SVG in-place."""

    note = current_editor_note(editor)
    if note is None:
        showInfo("Select a text field or save the note first!")
        return

    field_index = current_field_index(editor)
    field_names = [f["name"] for f in note.col.models.get(note.mid)["flds"]]
    if field_index is None or field_index >= len(field_names):
        showInfo("Select a text field!")
        return
    current_field = field_names[field_index]

    new_note_text = re.sub(
        r"\$(.*?)\$",
        lambda match: gen_typst_math(
            match.group(1),
            Export[config["render-type"].upper()],
            match.group(1).startswith(" ") and match.group(1).endswith(" "),
        ),
        note[current_field],
    )

    note[current_field] = new_note_text

    if getattr(editor, "note", None) is not None:
        # Legacy editor: it owns the note object and persists it itself.
        editor.setNote(editor.note)
    else:
        # New editor: the note was fetched from the collection and thus needs
        # to be written back to it, then the editor reloaded from the database.
        mw.col.update_note(note)
        if hasattr(editor, "reload_note"):
            editor.reload_note()
        else:
            editor.setNote(note)


def collect_and_replace(editor: Editor):
    """Entry point for the "Typst Math replace" action."""

    if editor.currentField is None and getattr(editor, "last_field_index", None) is None:
        showInfo("Select a text field or note!")
        return

    if getattr(editor, "note", None) is None and hasattr(
        editor, "call_after_note_saved"
    ):
        # New editor: flush pending changes from the webview into the note
        # before modifying it behind the editor's back.
        editor.call_after_note_saved(
            partial(replace_in_current_field, editor), keepFocus=True
        )
    else:
        replace_in_current_field(editor)


def typst_editor(editor: Editor, display_math=False):
    """Open an input dialog for Typst input, convert and append to note.

    - If the option checkbox is set to MathML, Typst's MathML export is used.
    - If the option checkbox is set to SVG, Typst's SVG export is used.

    Calls `EditorWebView::eval` to append MathML/SVG with `insertHTML` via Javascript.
    """

    if editor.web is None:
        showInfo("Web view of editor could not be initialized!")
        return

    input_dialog = TypstInputDialog(display_math=display_math, config=config)
    input_dialog.input.setFocus()
    input_dialog.button.setDefault(True)

    # Get front or back side and insert SVG/MathML.
    if input_dialog.exec():
        input_text, option = input_dialog.text_and_option()

        # Generate Typst math code either as base64-encoded SVG in an <img> tag or as MathML.
        output_text = gen_typst_math(
            input_text,
            Export.SVG if option.startswith("Typst SVG") else Export.MATHML,
            display_math,
        )

        # see: https://github.com/ijgnd/anki__editor_add_table/commit/f236029d43ae8f65fa93a684ba13ea1bdfe64852.
        js_insert_html = (
            f"document.execCommand('insertHTML', false, {json.dumps(output_text)});"
            if anki_point_version <= 49
            else f"setTimeout(() => {{ document.execCommand('insertHTML', false, {json.dumps(output_text)}); }}, 50);"
        )

        # Give the web view focus back after the input dialog closed so that
        # the caret is in the current field when the HTML is inserted.
        editor.web.setFocus()
        editor.web.eval(js_insert_html)


def settings_cb():
    """Callback for opening the "Edit preamble" dialog."""

    preamble_settings = PreambleEditDialog(preamble=preamble)
    full_preamble_path = Path(
        os.path.join(os.path.dirname(__file__), config["preamble"])
    )

    if preamble_settings.exec():
        input = preamble_settings.input.toPlainText()
        with open(full_preamble_path, "w") as f:
            f.write(input)
            f.flush()


def typst_menu_cb(editor: Editor):
    """Callback for the context menu of the dedicated "Typst" button.

    Shows a menu similar to the native "Equations" menu with the following items:
    - Typst Math inline (opens the editor and uses inline math),
    - Typst Math block (opens the editor and uses display math),
    - Typst Math replace (replaces all instances of typst math between dollar signs with rendered math),
    - Edit preamble (opens a settings menu for modifying the preamble)
    """

    menu = QMenu(editor.mw)
    menu.setContentsMargins(5, 5, 5, 5)

    menu_and_action = [
        ("Typst Math inline", "Ctrl+M, T", partial(typst_editor, editor)),
        ("Typst Math block", "Ctrl+M, B", partial(typst_editor, editor, True)),
        ("Typst Math replace", "Ctrl+M, R", partial(collect_and_replace, editor)),
        ("---", None, None),
        ("Edit preamble...", QKeySequence(), settings_cb),
    ]

    for action, shortcut, cmd in menu_and_action:
        if action == "---":
            menu.addSeparator()
        else:
            act = QAction(action, menu)
            act.setShortcutVisibleInContextMenu(True)
            act.setShortcut(shortcut)

            if cmd is not None:
                act.triggered.connect(cmd)

            menu.addAction(act)

    # NOTE: QMenu.exec expects a cursor position; passing a list of actions
    # (as Qt 5 allowed) raises a TypeError with PyQt 6.
    menu.exec(QCursor.pos())


# ----- Registration of GUI hooks for shortcuts and buttons. ----- #


def shortcut_hook(keys: list[tuple], editor: Editor):
    """Initialize and add shortcuts to global shortcut hook."""

    keys.extend(
        [
            ("Ctrl+M, T", partial(typst_editor, editor)),
            ("Ctrl+M, B", partial(typst_editor, editor, True)),
            ("Ctrl+M, R", partial(collect_and_replace, editor)),
        ]
    )


def typst_button_hook(buttons, editor: Editor):
    """Appends the `Typst` button opening a context menu with all the options."""

    typst_menu = editor.addButton(
        icon=None,
        cmd="typst_menu",
        func=typst_menu_cb,
        tip="Equations (Typst)",
        label="Typst",
    )

    buttons.append(typst_menu)


editor_did_init_buttons.append(typst_button_hook)
editor_did_init_shortcuts.append(shortcut_hook)
