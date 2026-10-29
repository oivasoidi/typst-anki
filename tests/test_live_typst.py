"""Functional test for the typst-anki prototype, run outside Anki with aqt stubbed."""
import json
import sys
import types
import time

# Stub aqt (including the Qt re-exports used by the addon) so the addon
# modules import outside Anki.
aqt = types.ModuleType("aqt")


class _AddonManager:
    @staticmethod
    def addonFromModule(name):
        return "typst-anki"

    @staticmethod
    def getConfig(name):
        return {"render-type": "svg", "preamble": "user_files/preamble.typ"}

    web_exports = {}

    @classmethod
    def setWebExports(cls, module, pattern):
        cls.web_exports[module] = pattern


class _MW:
    addonManager = _AddonManager


aqt.mw = _MW


class QAction:
    def __init__(self, *a, **k):
        self.triggered = _Signal()

    def setShortcutVisibleInContextMenu(self, v):
        pass

    def setShortcut(self, s):
        pass


class _Signal:
    def connect(self, fn):
        pass


class QMenu:
    def __init__(self, *a):
        pass

    def setContentsMargins(self, *a):
        pass

    def addSeparator(self):
        pass

    def addAction(self, a):
        pass

    def exec(self, *a):
        pass


class QCursor:
    @staticmethod
    def pos():
        return None


class QKeySequence:
    def __init__(self, *a):
        pass


for name in ["QAction", "QMenu", "QCursor", "QKeySequence"]:
    setattr(aqt, name, locals()[name])


class _Stub:
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        return _Stub()

    def __call__(self, *a, **k):
        return _Stub()


for _qt_name in [
    "QDialog",
    "QFontDatabase",
    "QPushButton",
    "QTextEdit",
    "QVBoxLayout",
    "QHBoxLayout",
    "QLineEdit",
    "QRadioButton",
    "Qt",
]:
    setattr(aqt, _qt_name, type(_qt_name, (_Stub,), {}))
aqt.showInfo = print

editor_mod = types.ModuleType("aqt.editor")
editor_mod.Editor = type("Editor", (), {})
utils_mod = types.ModuleType("aqt.utils")
utils_mod.showInfo = print
utils_mod.qconnect = lambda signal, fn: fn(True)
# The legacy editor module (Anki 26.08+); stubbed so tests are deterministic
# and do not depend on which aqt version is importable.
editor_legacy_mod = types.ModuleType("aqt.editor_legacy")
editor_legacy_mod.Editor = type("LegacyEditor", (), {})


# aqt.webview stub: enough of AnkiWebView for the hidden compiler webview.
class FakeAnkiWebViewKind:
    EDITOR = type("Kind", (), {"value": "editor"})
    DEFAULT = type("Kind", (), {"value": "default"})


class FakeAnkiWebView:
    instances = []

    def __init__(self, title="", kind=None):
        self.title = title
        self.kind = kind
        self.evals = []
        self.loaded = None
        self.bridge_command = None
        self.loadFinished = lambda: None
        FakeAnkiWebView.instances.append(self)

    def set_bridge_command(self, fn, ctx):
        self.bridge_command = (fn, ctx)

    # The compiler webview opts out of Anki's open-links-externally
    # interception (its /_addons/... page must load, not open in a browser).
    def set_open_links_externally(self, enable):
        self.open_links_externally = enable

    def load_url(self, url):
        self.loaded = url

    def eval(self, js):
        self.evals.append(js)


webview_mod = types.ModuleType("aqt.webview")
webview_mod.AnkiWebViewKind = FakeAnkiWebViewKind
webview_mod.AnkiWebView = FakeAnkiWebView

qt_mod = types.ModuleType("aqt.qt")


class FakeQUrl:
    def __init__(self, url):
        self.url = url


qt_mod.QUrl = FakeQUrl

# mw.serverURL stub for the compiler webview's page URL.
_MW.serverURL = staticmethod(lambda: "http://127.0.0.1:42731/")

sys.modules["aqt"] = aqt
sys.modules["aqt.editor"] = editor_mod
sys.modules["aqt.editor_legacy"] = editor_legacy_mod
sys.modules["aqt.utils"] = utils_mod
sys.modules["aqt.webview"] = webview_mod
sys.modules["aqt.qt"] = qt_mod
aqt.editor = editor_mod
aqt.editor_legacy = editor_legacy_mod
aqt.utils = utils_mod
aqt.webview = webview_mod
aqt.qt = qt_mod

gui_hooks = types.ModuleType("aqt.gui_hooks")


class _Hook:
    def __init__(self):
        self.hooks = []

    def append(self, fn):
        self.hooks.append(fn)


_HOOK_NAMES = [
    "editor_did_init_buttons",
    "editor_did_init_shortcuts",
    "webview_will_set_content",
    "webview_did_inject_style_into_page",
    "webview_did_receive_js_message",
]
for h in _HOOK_NAMES:
    setattr(gui_hooks, h, _Hook())
sys.modules["aqt.gui_hooks"] = gui_hooks
aqt.gui_hooks = gui_hooks

# Import the addon like Anki does: the package dir name contains a dash, so
# it must be imported through importlib with the *parent* dir on sys.path.
sys.path.insert(0, "src")
sys.path.insert(0, "src/typst-anki/lib")
import importlib

ta = importlib.import_module("typst-anki")
print("== addon imported OK, hooks registered ==")

# 0. Web exports must be registered, otherwise the media server 404s the
#    /_addons/... script tags that carry the element into legacy editor pages.
assert _AddonManager.web_exports.get("typst-anki") == r"web/.*", _AddonManager.web_exports
print("web exports registered: OK")

# 1. SVG + MathML compile timing.
t0 = time.perf_counter()
svg = ta.gen_typst_math("x^2 + 1/(1+x)", ta.Export.SVG, False)
t1 = time.perf_counter()
mathml = ta.gen_typst_math("x^2 + 1/(1+x)", ta.Export.MATHML, False)
t2 = time.perf_counter()
assert svg.startswith('<img style="vertical-align: middle;"'), svg[:80]
assert 'src="data:image/svg+xml;base64,' in svg, svg[:120]
assert "<math" in mathml, mathml[:200]
assert "<meta" not in mathml and "<style" not in mathml, mathml[:200]
assert mathml.startswith("<math"), mathml[:60]
print(f"SVG compile:    {(t1 - t0) * 1000:.0f} ms, {len(svg)} chars")
print(f"MathML compile: {(t2 - t1) * 1000:.0f} ms, {len(mathml)} chars")
assert (t1 - t0) < 2.0 and (t2 - t1) < 2.0, "compile too slow for live preview"

# 1b. SVG equations must not be culled: with `page(height: auto)` an inline
# equation `$x$` is laid out as a text line, so the page is only as tall as
# the line box and taller ink (fractions, scripts, big operators) is cut
# off at the page rectangle. Inline equations are therefore compiled as
# `#math.equation(math.inline(...), block: true)`, and block equations as
# display math, both of which size the page to the full ink.
import base64 as _base64
import re as _re


def _viewbox(html):
    raw_b64 = _re.search(r'base64,([^"]+)"', html).group(1)
    raw = _base64.b64decode(raw_b64).decode()
    return tuple(
        float(v) for v in _re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', raw).groups()
    )


# The section-1 source contains a fraction: its ink must fit the page
# (the culled version was ~10.9pt tall — shorter than the 16pt text size).
w_frac, h_frac = _viewbox(svg)
assert h_frac > 15.0, f"inline SVG is culled: {w_frac}x{h_frac}pt"

# The img carries the SVG's intrinsic size as width/height attributes, so
# its layout does not depend on the data URI having loaded (a loading img
# collapses, then pops open and shifts surrounding content — e.g. making
# the source panel jump over the equation between rerenders).
_m = _re.search(r' width="([\d.]+)" height="([\d.]+)"', svg)
assert _m, "SVG img is missing explicit dimensions: " + svg[:120]
assert abs(float(_m.group(1)) - w_frac * 4 / 3) < 0.01, svg[:200]
assert abs(float(_m.group(2)) - h_frac * 4 / 3) < 0.01, svg[:200]
print("svg img dimensions: OK", _m.group(1), "x", _m.group(2))

# The baked SVG carries a theme-adaptive stylesheet: the equation follows
# the client's color scheme (dark text on light themes, light text on dark
# ones), even on clients without the addon. It must stay well-formed XML
# and live inside the SVG root.
import xml.etree.ElementTree as _ET

_svg_text = _base64.b64decode(_re.search(r'base64,([^"]+)"', svg).group(1)).decode()
_ET.fromstring(_svg_text)  # raises if the injection broke the document
assert "@media (prefers-color-scheme: dark)" in _svg_text, _svg_text[:200]
assert "*:not([fill=none]) { fill: #1e1e1e; }" in _svg_text, _svg_text[:200]
assert _svg_text.index("<style>") < _svg_text.index("<g "), _svg_text[:200]
print("svg theme-adaptive colors: OK")

# The adaptive colors are configurable: with "adaptive-color": false the
# baked SVG keeps its compiled color instead.
ta.config["adaptive-color"] = False
try:
    _svg_fixed = ta.gen_typst_math("x", ta.Export.SVG, False)
finally:
    del ta.config["adaptive-color"]
_svg_fixed_text = _base64.b64decode(_re.search(r'base64,([^"]+)"', _svg_fixed).group(1)).decode()
assert "prefers-color-scheme" not in _svg_fixed_text, _svg_fixed_text[:200]
assert 'fill="#ffffff"' in _svg_fixed_text  # compiled color kept
print("adaptive-color config option: OK")

# Inline equations keep their compact inline layout (limits beside the
# operator), while block equations are display math (limits stacked).
w_in, h_in = _viewbox(ta.gen_typst_math("sum_(k=1)^oo k", ta.Export.SVG, False))
w_blk, h_blk = _viewbox(ta.gen_typst_math("sum_(k=1)^oo k", ta.Export.SVG, True))
assert h_in > 15.0 and h_blk > 30.0, f"culling: inline {w_in}x{h_in}, block {w_blk}x{h_blk}"
assert w_in > w_blk and h_in < h_blk, f"inline/block styles swapped: {w_in}x{h_in} vs {w_blk}x{h_blk}"
print(f"svg culling regression: OK (inline {w_in}x{h_in}pt, block {w_blk}x{h_blk}pt)")

# Empty sources must still compile on every path (freshly inserted
# equations hit them).
for _rt in (ta.Export.SVG, ta.Export.MATHML):
    for _disp in (False, True):
        assert "<img" in ta.gen_typst_math("", _rt, _disp) or "<math" in ta.gen_typst_math(
            "", _rt, _disp
        ), (_rt, _disp)
print("empty-source compiles: OK")

# 3. Bridge handler: what JS would receive.
from importlib import import_module as _im

live_typst = _im("typst-anki.live_typst")

insert_calls = []
preamble_calls = []
live_typst.setup(
    "typst-anki",
    ta.config,
    ta.gen_typst_math,
    ta.Export,
    insert_equation=lambda editor, block: insert_calls.append((editor, block)),
    edit_preamble=lambda: preamble_calls.append(1),
)
msg = live_typst.BRIDGE_PREFIX + json.dumps({"source": "y = f(x)", "block": True, "render": "svg"})
handled, result = live_typst._on_bridge_message((False, None), msg, None)
assert handled and result["ok"], result
assert result["html"].startswith("<img"), result["html"][:60]
print("bridge compile: OK ->", result["html"][:55], "...")

# 3b. Default render type from config when the element doesn't specify one.
msg2 = live_typst.BRIDGE_PREFIX + json.dumps({"source": "z", "block": False})
handled, result2 = live_typst._on_bridge_message((False, None), msg2, None)
assert handled and result2["ok"] and "<img" in result2["html"], result2
print("bridge default render-type (svg): OK")

# 3c. Live compiling: requests carrying an id and an editor context are
#     compiled off the main thread and delivered asynchronously through
#     window.__typstAnkiResolve(id, result); the pycmd callback only gets
#     a pending placeholder. Without an id (or editor) the handler answers
#     synchronously, like before.
class FakeBridgeWeb:
    def __init__(self):
        self.evals = []

    def eval(self, js):
        self.evals.append(js)


class FakeBridgeEditor:
    def __init__(self):
        self.web = FakeBridgeWeb()


bridge_editor = FakeBridgeEditor()
msg3 = live_typst.BRIDGE_PREFIX + json.dumps(
    {"source": "a + b", "block": False, "render": "svg", "id": 42}
)
# Make the background hop deterministic for the test.
real_run = live_typst._run_compilation
live_typst._run_compilation = lambda func, deliver: deliver(func())
try:
    handled, result3 = live_typst._on_bridge_message((False, None), msg3, bridge_editor)
finally:
    live_typst._run_compilation = real_run
assert handled and result3 == live_typst.PENDING_RESPONSE, result3
assert len(bridge_editor.web.evals) == 1, bridge_editor.web.evals
eval_js = bridge_editor.web.evals[0]
assert "__typstAnkiResolve(42, " in eval_js, eval_js
assert '"ok": true' in eval_js and "base64" in eval_js, eval_js
assert eval_js.startswith("try{") and eval_js.endswith("}catch(err){}"), eval_js
print("background compile delivery: OK ->", eval_js[:70], "...")

# Without an id the very same request is still answered synchronously.
msg3b = live_typst.BRIDGE_PREFIX + json.dumps(
    {"source": "a + b", "block": False, "render": "svg"}
)
handled, result3b = live_typst._on_bridge_message((False, None), msg3b, bridge_editor)
assert handled and result3b["ok"], result3b
print("synchronous fallback (no id): OK")

# 4. Bridge error path (invalid typst) must not raise.
msg_bad = live_typst.BRIDGE_PREFIX + json.dumps({"source": "$unbalanced", "block": False})
handled, result3 = live_typst._on_bridge_message((False, None), msg_bad, None)
assert handled and not result3["ok"]
print("bridge error path: OK ->", (result3.get("error") or "")[:70])

# 5. Pass-through for unrelated messages (must stay unhandled).
handled, result4 = live_typst._on_bridge_message((False, None), "editor:edit:5", None)
assert handled is False
print("unrelated message pass-through: OK")

# 6. Editor-context detection and stdHtml injection.
class FakeWebContent:
    def __init__(self):
        self.js = []


ctx = editor_mod.Editor()
assert live_typst._is_editor_context(ctx)
wc = FakeWebContent()
live_typst._inject_into_stdhtml_page(wc, ctx)
# Editor pages get both the element and the equations-menu augmentation
# (which also serves the 26.08+ legacy editor's SvelteKit page).
assert wc.js == [
    "/_addons/typst-anki/web/typst-element.js",
    "/_addons/typst-anki/web/typst-new-editor.js",
], wc.js
# Non-editor contexts (e.g. the reviewer) must not get the script.
wc2 = FakeWebContent()
live_typst._inject_into_stdhtml_page(wc2, None)
assert wc2.js == []
print("editor-context detection + stdHtml injection: OK")

# 7. New-editor (SvelteKit) injection: only for editor-kind webviews.
class FakeWebView:
    class kind:
        value = "editor"

    def __init__(self):
        self.evals = []

    def eval(self, js):
        self.evals.append(js)


wv = FakeWebView()
live_typst._inject_into_new_editor_page(wv)
assert len(wv.evals) == 2, wv.evals
assert "anki-typst" in wv.evals[0] and "try{" in wv.evals[0]
assert "anki/shortcuts" in wv.evals[1] and "try{" in wv.evals[1]
wv2 = FakeWebView()
wv2.kind = None
live_typst._inject_into_new_editor_page(wv2)
assert len(wv2.evals) == 0
print("sveltekit editor injection (element + shortcuts/menu): OK")

# 8. Dialog-free insertion: Ctrl+M, T must eval JS that inserts the element
#    and opens the floating editor — no QDialog anywhere in the flow.
class FakeEditorWeb:
    def __init__(self):
        self.evals = []
        self.focused = False

    def setFocus(self):
        self.focused = True

    def eval(self, js):
        self.evals.append(js)


class FakeEditor:
    def __init__(self):
        self.web = FakeEditorWeb()


ed = FakeEditor()
ta.typst_editor(ed, display_math=False)
assert ed.web.focused and len(ed.web.evals) == 1, "typst_editor must eval one insert snippet"
js = ed.web.evals[0]
for needle in [
    'document.createElement("anki-typst")',
    'focusonmount',
    'execCommand("insertHTML"',
    'data-render',
    'window.getSelection()',
    "block",
]:
    assert needle in js, f"missing {needle!r} in insertion JS"
assert "QDialog" not in js and "showInfo" not in js
assert js.lstrip().startswith("setTimeout"), "modern editors need the delayed execCommand"
print("dialog-free insertion JS: OK ->", js.strip().splitlines()[0], "...")

# 9. Insertion respects block mode and the configured render type.
ed2 = FakeEditor()
ta.typst_editor(ed2, display_math=True)
assert 'block", "true"' in ed2.web.evals[0], ed2.web.evals[0]
assert 'data-render", "svg"' in ed2.web.evals[0], ed2.web.evals[0]
print("block + render-type attributes: OK")

# 10. Shortcut dispatch from the new editor's webview (context = Editor):
#     the messages registered by web/typst-new-editor.js.
ctx = object()
handled, result = live_typst._on_bridge_message(
    (False, None), live_typst.SHORTCUT_INLINE, ctx
)
assert handled and insert_calls == [(ctx, False)], insert_calls
handled, result = live_typst._on_bridge_message(
    (False, None), live_typst.SHORTCUT_BLOCK, ctx
)
assert handled and insert_calls == [(ctx, False), (ctx, True)], insert_calls
# Without an editor context (bridge not bound to an editor), do nothing.
handled, result = live_typst._on_bridge_message(
    (False, None), live_typst.SHORTCUT_INLINE, None
)
assert handled and len(insert_calls) == 2
# The "Edit preamble..." equations menu entry opens the preamble dialog —
# with or without an editor context.
handled, result = live_typst._on_bridge_message(
    (False, None), live_typst.SHORTCUT_PREAMBLE, ctx
)
assert handled and result is None and preamble_calls == [1]
handled, result = live_typst._on_bridge_message(
    (False, None), live_typst.SHORTCUT_PREAMBLE, None
)
assert handled and preamble_calls == [1, 1]
print("shortcut bridge dispatch: OK")

# 11. Editor-version detection: the new editor (26.08+) must NOT get Qt
#     chord shortcuts (they break the native Ctrl+M chords).
real_find_spec = live_typst.find_spec
try:
    live_typst.find_spec = lambda name: (object() if name == "aqt.editor_legacy" else None)
    NewEditor = type("Editor", (), {"__module__": "aqt.editor"})
    LegacyEditor = type("Editor", (), {"__module__": "aqt.editor_legacy"})
    assert live_typst.is_new_editor(NewEditor())
    assert not live_typst.is_new_editor(LegacyEditor())
    # Up to 26.07 there is no aqt.editor_legacy module at all.
    live_typst.find_spec = lambda name: None
    assert not live_typst.is_new_editor(NewEditor())
finally:
    live_typst.find_spec = real_find_spec
print("new-editor detection: OK")

# 12. The hidden incremental-compiler webview: created once when the first
#     editor is set up (the section-6 injection above already did), sharing
#     the editors' profile kind and loading the add-on-served compiler
#     page (no CSP there, so WebAssembly is allowed). Preamble edits are
#     pushed into it; no second webview is ever created.
compiler_webview = _im("typst-anki.compiler_webview")
views = FakeAnkiWebView.instances
assert len(views) == 1, views
cwv = views[0]
assert cwv.kind is FakeAnkiWebViewKind.EDITOR, "must share the editors' profile"
assert cwv.open_links_externally is False, (
    "the /_addons/ page must not be rejected + opened in the system browser"
)
assert "typst-compiler.html" in cwv.loaded.url and "_addons/typst-anki/" in cwv.loaded.url, cwv.loaded.url
assert cwv.bridge_command is not None
assert any("__typstAnkiUpdate" in js for js in cwv.evals), cwv.evals
# A second ensure only re-pushes; no second webview is created.
compiler_webview.ensure_and_refresh()
assert len(FakeAnkiWebView.instances) == 1
assert len(cwv.evals) >= 2
# Preamble edits propagate.
compiler_webview.set_preamble("#let bb = $b$")
assert any("#let bb = $b$" in js for js in cwv.evals), cwv.evals
print("compiler webview: OK ->", cwv.loaded.url)

print("ALL TESTS PASSED")
