"""Deeper Typst integration: shortcuts, "Equations" menu entries, and the
`<anki-typst>` custom element.

This module wires the addon into every editor:

- The `<anki-typst>` element definition (web/typst-element.js) is injected
  into every editor webview, both `stdHtml`-based ones (legacy editor, and
  the editors inside the previewer/card layout designer) and the
  SvelteKit-based new editor of Anki 26.08+.
- The element sends Typst compile requests over Anki's JS bridge (`pycmd`),
  which are answered here by running the Typst compiler and returning the
  baked SVG/MathML render.

Shortcuts and the native "Equations" menu:

- New editor (26.08+): all editor shortcuts — including the native MathJax
  chords — are handled *inside the webview*. Registering Qt-level chord
  shortcuts there (what `editor_did_init_shortcuts` produces) swallows the
  shared "Ctrl+M" prefix key event and breaks the native chords. The Typst
  shortcuts are therefore registered with Anki's own webview shortcut module
  (`anki/shortcuts`, see web/typst-new-editor.js), and the messages they
  send are dispatched here. The same script appends Typst entries to the
  native "Equations" toolbar menu (which has no add-on API).
- Legacy editor (<= 26.07, and the deprecated one in 26.08+): Qt chord
  shortcuts coexist natively there, and the "Equations" menu is a QMenu
  built by `Editor.onAdvanced`, which is patched below to append Typst
  entries.

The `<anki-typst>` element itself stores the Typst source *and* a baked
render in the note field's HTML, so cards keep displaying correctly on
AnkiDroid, AnkiWeb and desktop Anki without the addon; the addon only adds
editability.
"""

import functools
import importlib
import json
import threading
from importlib.util import find_spec
from pathlib import Path

from aqt import gui_hooks

# The element sends: BRIDGE_PREFIX + json({source, block, render, id}).
BRIDGE_PREFIX = "typst-anki:compile:"
# Shortcut/menu entries send one of these via pycmd; handled in
# _on_bridge_message, where the bridge context is the Editor instance.
SHORTCUT_INLINE = "typst-anki:shortcut:inline"
SHORTCUT_BLOCK = "typst-anki:shortcut:block"
# The equations menu entry "Edit preamble...": opens the preamble dialog.
SHORTCUT_PREAMBLE = "typst-anki:shortcut:preamble"
# `AnkiWebViewKind.EDITOR.value`; used to identify the new editor's webview,
# which is a SvelteKit page that `webview_will_set_content` never sees.
EDITOR_WEBVIEW_KIND = "editor"

_ELEMENT_JS_PATH = Path(__file__).parent / "web" / "typst-element.js"
_NEW_EDITOR_JS_PATH = Path(__file__).parent / "web" / "typst-new-editor.js"

_addon_package = "typst-anki"
_config = {}
_gen_typst_math = None
_Export = None
_element_js = ""
_new_editor_js = ""
_insert_equation = None
_edit_preamble = None
_editor_classes_cache: list | None = None


def setup(
    addon_package: str,
    config: dict,
    gen_typst_math,
    Export,
    insert_equation,
    edit_preamble=None,
) -> None:
    """Initialize the integration. Called once from the addon's `__init__`."""

    global _addon_package, _config, _gen_typst_math, _Export, _element_js
    global _new_editor_js, _insert_equation, _edit_preamble

    _addon_package = addon_package
    _config = config
    _gen_typst_math = gen_typst_math
    _Export = Export
    _element_js = _ELEMENT_JS_PATH.read_text(encoding="utf-8")
    _new_editor_js = _NEW_EDITOR_JS_PATH.read_text(encoding="utf-8")
    _insert_equation = insert_equation
    _edit_preamble = edit_preamble

    gui_hooks.webview_will_set_content.append(_inject_into_stdhtml_page)
    gui_hooks.webview_did_inject_style_into_page.append(_inject_into_new_editor_page)
    # Belt and braces for the new editor: this hook fires when the editor
    # webview is created; the queued evals run once the page is ready.
    if hasattr(gui_hooks, "editor_web_view_did_init"):
        gui_hooks.editor_web_view_did_init.append(_inject_into_new_editor_page)
    gui_hooks.webview_did_receive_js_message.append(_on_bridge_message)

    _patch_legacy_equations_menu()


def is_new_editor(editor) -> bool:
    """Whether `editor` is the new (SvelteKit-based) editor of Anki 26.08+.

    There, shortcuts must be registered inside the webview (see module
    docstring); Qt chord shortcuts would break the native "Ctrl+M" chords.
    """

    try:
        if find_spec("aqt.editor_legacy") is None:
            # Up to Anki 26.07, aqt.editor.Editor is the legacy editor and
            # Qt chord shortcuts coexist with the native ones.
            return False
    except Exception:
        return False
    return type(editor).__module__ == "aqt.editor"


# ----- JavaScript injection ----- #


def _editor_classes() -> list:
    """Editor classes across Anki versions (legacy and new editor)."""

    global _editor_classes_cache

    if _editor_classes_cache is None:
        classes = []
        try:
            from aqt.editor import Editor

            classes.append(Editor)
        except ImportError:
            pass
        try:
            from aqt.editor_legacy import Editor as LegacyEditor

            classes.append(LegacyEditor)
        except ImportError:
            pass
        _editor_classes_cache = classes
    return _editor_classes_cache


def _is_editor_context(context) -> bool:
    return bool(_editor_classes()) and isinstance(context, tuple(_editor_classes()))


def _inject_into_stdhtml_page(web_content, context) -> None:
    """Inject the element into legacy-editor-style pages via the media server.

    `webview_will_set_content` fires for every `stdHtml` webview: the legacy
    editor, the previewer's editor, the card layout editor, the reviewer, etc.
    Only the editors need the script; the reviewer displays the baked render
    without any JavaScript.
    """

    if _is_editor_context(context):
        web_content.js.append(f"/_addons/{_addon_package}/web/typst-element.js")
        # The equations-menu augmentation also here: Anki 26.08+ runs the
        # *legacy* editor inside the same SvelteKit app as the new one (with
        # `require`, `pycmd` and the equations popover), so the Typst
        # entries — including "Edit preamble..." — are appended to its
        # popover the same way. Older pages (< 26.08) have neither `require`
        # nor the Svelte popover; the script degrades gracefully there (the
        # entries live in the QMenu that `_append_typst_menu_actions`
        # appends to below).
        web_content.js.append(f"/_addons/{_addon_package}/web/typst-new-editor.js")
        _spawn_compiler_webview()


def _inject_into_new_editor_page(webview) -> None:
    """Inject the element into SvelteKit-based pages (new editor, 26.08+).

    The new editor does not go through `stdHtml`, so it is never seen by
    `webview_will_set_content`. This hook fires on its page load instead,
    also registering the webview-level Typst shortcuts and equations-menu
    entries (see web/typst-new-editor.js).
    """

    kind = getattr(getattr(webview, "kind", None), "value", None)
    if kind == EDITOR_WEBVIEW_KIND:
        # The scripts are evaluated as *statements*: wrapping their content in
        # parentheses (an expression) is a syntax error, since the files end
        # in `})();`, and the error would be silently swallowed here.
        for script in (_element_js, _new_editor_js):
            webview.eval(
                f"try{{{script}}}catch(err){{console.error('typst-anki:', err);}}"
            )
        _spawn_compiler_webview()


def _spawn_compiler_webview() -> None:
    """Make sure the hidden incremental-compiler webview exists (see
    compiler_webview.py). Called whenever an editor page is set up; the
    compiler webview is created once and outlives the editors."""

    try:
        from . import compiler_webview

        compiler_webview.ensure_and_refresh()
    except Exception as exc:
        print(f"typst-anki: could not start the compiler webview: {exc}")


# ----- Legacy "Equations" menu (QMenu built by `Editor.onAdvanced`) ----- #


def _patch_legacy_equations_menu() -> None:
    """Append Typst entries to the legacy editor's "Equations" menu.

    The menu (Mathjax Inline, Mathjax Block, ..., Latex Math Env) is built
    and exec'd inside `Editor.onAdvanced`. `qtMenuShortcutWorkaround(menu)`
    is called on the finished menu right before `m.exec()`, so the wrapper
    below intercepts it with the editor instance in scope and adds the Typst
    actions first. Covers `aqt.editor` (up to 26.07) and `aqt.editor_legacy`
    (26.08+); skipped where `onAdvanced` does not exist (the new editor).
    """

    for module_name in ("aqt.editor", "aqt.editor_legacy"):
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue

        editor_class = getattr(module, "Editor", None)
        if editor_class is None or not hasattr(editor_class, "onAdvanced"):
            continue
        if not hasattr(module, "qtMenuShortcutWorkaround"):
            # The interception point is missing; menu entries can not be added.
            continue
        if getattr(editor_class, "_typst_anki_menu_patched", False):
            continue

        original = editor_class.onAdvanced

        @functools.wraps(original)
        def patched(self, _original=original, _module=module):
            original_workaround = _module.qtMenuShortcutWorkaround

            def workaround_with_typst(menu):
                _append_typst_menu_actions(menu, self)
                original_workaround(menu)

            _module.qtMenuShortcutWorkaround = workaround_with_typst
            try:
                _original(self)
            finally:
                _module.qtMenuShortcutWorkaround = original_workaround

        editor_class.onAdvanced = patched
        editor_class._typst_anki_menu_patched = True


def _append_typst_menu_actions(menu, editor) -> None:
    """Add the Typst entries to `menu` if it is the legacy equations menu."""

    try:
        from aqt import QKeySequence, tr
        from aqt.utils import qconnect
    except ImportError:
        return

    # Only augment the equations menu; `qtMenuShortcutWorkaround` is used for
    # other menus as well. Shortcut display is handled by the wrapped
    # `qtMenuShortcutWorkaround` call after this returns.
    if tr.editing_mathjax_inline() not in [action.text() for action in menu.actions()]:
        return

    entries = (
        ("Typst Math", "Ctrl+M, T", functools.partial(_insert_equation, editor, False)),
        ("Typst Math block", "Ctrl+M, B", functools.partial(_insert_equation, editor, True)),
    )

    menu.addSeparator()
    for text, keys, handler in entries:
        action = menu.addAction(text)
        qconnect(action.triggered, handler)
        action.setShortcut(QKeySequence(keys))

    # The equations menu also hosts the preamble editor entry (the Typst
    # toolbar button that used to hold it is gone).
    action = menu.addAction("Edit preamble...")
    qconnect(action.triggered, _edit_preamble)


# ----- JS bridge: shortcut dispatch and Typst compile requests ----- #


# Answered to the pycmd callback while a compile is still running; the real
# result is delivered asynchronously via `window.__typstAnkiResolve(...)`.
PENDING_RESPONSE = {"__pending": True}

# Compiles are serialized: the typst binding is not guaranteed to be safe
# for concurrent calls, and requests arriving faster than they are compiled
# (live, per-keystroke compiling) would only pile up.
_compile_lock = threading.Lock()


def _compile(source, render, block):
    """Compile Typst source to a render; never raises."""
    with _compile_lock:
        try:
            export = _Export.MATHML if str(render).lower() == "mathml" else _Export.SVG
            return {"ok": True, "html": _gen_typst_math(source, export, block)}
        except Exception as exc:  # typst compile errors and the like
            return {"ok": False, "error": str(exc)}


def _run_compilation(func, deliver):
    """Run `func` off the main thread, `deliver`ing its result on main.

    The Typst compile takes tens of milliseconds; with live, per-keystroke
    compiling it must not block the main thread on every keystroke.
    """
    try:
        from aqt import mw

        taskman = mw.taskman
    except Exception:
        taskman = None
    if taskman is None:
        # No task manager (tests, exotic hosts): compile synchronously.
        deliver(func())
        return

    def on_done(future):
        try:
            deliver(future.result())
        except Exception as exc:  # a failed future must still reach the JS
            deliver({"ok": False, "error": str(exc)})

    taskman.run_in_background(func, on_done=on_done, uses_collection=False)


def _on_bridge_message(handled, message, context):
    # Shortcuts and equations-menu entries from
    # the new editor's webview; the bridge context is the Editor instance
    # the webview belongs to.
    if message == SHORTCUT_PREAMBLE:
        # The "Edit preamble..." entry: no editor context needed.
        if _edit_preamble:
            _edit_preamble()
        return (True, None)

    if message in (SHORTCUT_INLINE, SHORTCUT_BLOCK):
        if context is None:
            return (True, None)
        _insert_equation(context, message == SHORTCUT_BLOCK)
        return (True, None)

    if not message.startswith(BRIDGE_PREFIX):
        return handled

    try:
        payload = json.loads(message[len(BRIDGE_PREFIX) :])
    except json.JSONDecodeError as exc:
        return (True, {"ok": False, "error": f"malformed request: {exc}"})

    source = payload.get("source", "")
    block = bool(payload.get("block"))
    render = payload.get("render") or _config.get("render-type", "svg")
    request_id = payload.get("id")
    webview = getattr(context, "web", None) if context is not None else None

    if request_id is None or webview is None:
        # Older element scripts, or no editor webview: answer synchronously.
        return (True, _compile(source, render, block))

    def deliver(result):
        data = json.dumps(result)
        try:
            webview.eval(
                f"try{{window.__typstAnkiResolve({request_id}, {data});}}catch(err){{}}"
            )
        except Exception:
            pass  # the editor was closed while the compile was running

    _run_compilation(functools.partial(_compile, source, render, block), deliver)
    return (True, PENDING_RESPONSE)
