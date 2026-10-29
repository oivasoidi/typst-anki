"""The hidden incremental-compiler webview.

Editor pages run under a strict Content-Security-Policy that forbids
WebAssembly (`script-src` without `'wasm-unsafe-eval'`), so the Typst WASM
compiler cannot run inside them. Add-on-served files, however, carry no
CSP — so the addon loads its own `web/typst-compiler.html` in a hidden
`AnkiWebView`.

That webview shares the editors' browser profile (created with
`AnkiWebViewKind.EDITOR`, which maps to the same `QWebEngineProfile` as
all editor webviews) and their origin (`http://127.0.0.1:<port>`), which
puts both in the same storage partition — a `BroadcastChannel` therefore
connects them. Editor pages send their Typst compiles to the compiler
page over that channel; the incremental WASM compiler inside answers in
milliseconds, without Python in the loop. See `web/typst-compiler.html`
for the page-side protocol, and `web/typst-element.js` for the fallbacks:
if this webview is missing or fails to boot, compiles transparently go
through the Python bridge instead.

The preamble and config are pushed into the page after every load, so
preamble edits propagate without restarting Anki.
"""

import json

from aqt import mw
from aqt.qt import QUrl
from aqt.utils import qconnect
from aqt.webview import AnkiWebView, AnkiWebViewKind

_addon_package = ""
_config = {}
_preamble = ""
_view = None


def setup(addon_package: str, config: dict, preamble: str) -> None:
    """Initialize with the addon's package name, config and preamble."""

    global _addon_package, _config, _preamble
    _addon_package = addon_package
    _config = config
    _preamble = preamble


def set_preamble(preamble: str) -> None:
    """Update the preamble (e.g. after editing it in the settings dialog)."""

    global _preamble
    _preamble = preamble
    ensure_and_refresh()


def ensure_and_refresh() -> None:
    """Create the hidden compiler webview on first use, and push the
    current preamble and config into it."""

    global _view
    if not _addon_package or mw is None:
        return
    if _view is None:
        # `AnkiWebViewKind.EDITOR` maps to the same browser profile (and
        # thus storage partition) as the editor webviews, which is what
        # lets the BroadcastChannel reach them. The view is never shown;
        # a hidden QWebEngineView still loads and runs its page.
        view = AnkiWebView(title="typst-anki compiler", kind=AnkiWebViewKind.EDITOR)
        view.set_bridge_command(lambda *args: None, None)
        # Anki's `acceptNavigationRequest` only lets `/_anki/pages/`,
        # `/_anki/legacyPageData` and SvelteKit routes load in a view;
        # every other main-frame navigation is rejected and opened in the
        # system browser instead — including this `/_addons/...` page.
        # The page is a hidden worker with no links: it must simply load.
        view.set_open_links_externally(False)
        qconnect(view.loadFinished, lambda ok: _push())
        view.load_url(QUrl(f"{mw.serverURL()}_addons/{_addon_package}/web/typst-compiler.html"))
        _view = view
        # The preamble is pushed by the loadFinished hook above.
        return
    _push()


def _push() -> None:
    if _view is None:
        return
    config = json.dumps(_config)
    preamble = json.dumps(_preamble)
    _view.eval(
        f"window.__typstAnkiUpdate && window.__typstAnkiUpdate({preamble}, {config});"
    )
