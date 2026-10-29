/*
 * typst-anki: webview-level integration for the editor pages of Anki 26.08+.
 *
 * This runs in the editors' SvelteKit pages (the new editor, and the legacy
 * one that Anki 26.08+ runs inside the same Svelte app), loaded as a script
 * by live_typst.py.
 *
 * Why not Qt shortcuts (`editor_did_init_shortcuts`)? The new editor
 * handles all editor shortcuts *inside the webview* via the
 * "anki/shortcuts" module — that is how the native MathJax chords like
 * "Ctrl+M, M" work. Registering Qt-level chord shortcuts (e.g. "Ctrl+M, T")
 * on the editor widget swallows the shared "Ctrl+M" prefix key event before
 * the webview ever sees it, which breaks the native chords. So the Typst
 * shortcuts are registered with the same webview module the native
 * commands use; the bridge messages they send are answered by live_typst.py.
 *
 * The native "Equations" toolbar menu has no add-on API (it is rendered by
 * Anki's Svelte app). A MutationObserver detects when the equations popover
 * opens and appends matching Typst entries — the math actions and "Edit
 * preamble..." — that look and behave like the native ones.
 */
(() => {
  "use strict";
  if (window.__typstAnkiNewEditorHooks) {
    return;
  }
  window.__typstAnkiNewEditorHooks = true;

  let shortcuts = null;
  try {
    shortcuts = require("anki/shortcuts");
  } catch (err) {
    console.error("typst-anki: anki/shortcuts module unavailable:", err);
  }

  // [key combination, bridge message, label] — the shortcuts and the
  // equations menu entries all dispatch through these messages.
  const ACTIONS = [
    ["Control+M, T", "typst-anki:shortcut:inline", "Typst Math"],
    ["Control+M, B", "typst-anki:shortcut:block", "Typst Math block"],
  ];
  const PREAMBLE_MESSAGE = "typst-anki:shortcut:preamble";

  function platformString(combination) {
    try {
      return shortcuts ? shortcuts.getPlatformString(combination) : combination;
    } catch (err) {
      return combination;
    }
  }

  // ----- shortcuts ----- //
  if (shortcuts) {
    for (const [combination, message] of ACTIONS) {
      shortcuts.registerShortcut(
        (event) => {
          event.preventDefault();
          pycmd(message);
        },
        combination
      );
    }
  }


  // ----- native "Equations" toolbar menu entries ----- //

  // Identify the equations popover by its "Mathjax Inline" entry; shortcut
  // strings are not localized, labels are.
  function isEquationsMenu(buttons) {
    let mathjaxInline;
    try {
      mathjaxInline = shortcuts.getPlatformString("Control+M, M");
    } catch (err) {
      return false;
    }
    return buttons.some(
      (button) =>
        button.querySelector(".shortcut") &&
        button.querySelector(".shortcut").textContent.trim() === mathjaxInline
    );
  }

  // One appended entry: a clone of a native entry (label + shortcut hint),
  // dispatching `message` through the bridge. `combination` null leaves the
  // entry without a shortcut hint (e.g. "Edit preamble...").
  function menuEntry(template, combination, message, label) {
    const item = template.cloneNode(true);
    item.removeAttribute("id");
    item.removeAttribute("disabled");
    item.setAttribute("data-typst-menu", message);
    item.querySelector("span:not(.shortcut)").textContent = label;
    if (combination) {
      item.querySelector(".shortcut").textContent = platformString(combination);
    } else {
      item.querySelector(".shortcut").remove();
    }
    // Native entries (DropdownItem) prevent the default action of mousedown.
    // Without this, the mousedown moves focus out of the field, the editor
    // sets $focusedInput to null (on:focusout), the equations button's
    // reactive `if (disabled) showFloating = false` unmounts the popover
    // before the mouse button is released — and a click event is never
    // dispatched on the detached entry, so nothing would happen at all.
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => pycmd(message));
    return item;
  }

  function augmentEquationsMenu(popover) {
    if (popover.getAttribute("data-typst-menu") !== null) {
      return;
    }
    const items = Array.from(popover.querySelectorAll("button")).filter((button) =>
      button.querySelector(".shortcut")
    );
    if (!items.length || !isEquationsMenu(items)) {
      return;
    }
    popover.setAttribute("data-typst-menu", "1");

    const list = items[0].parentElement;
    for (const [combination, message, label] of ACTIONS) {
      list.appendChild(menuEntry(items[0], combination, message, label));
    }
    list.appendChild(
      menuEntry(items[0], null, PREAMBLE_MESSAGE, "Edit preamble...")
    );
  }

  if (shortcuts) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            augmentEquationsMenu(node);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
