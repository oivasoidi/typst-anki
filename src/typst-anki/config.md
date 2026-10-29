# Typst Math for Anki

### `"render-type"`: `"svg"` (default) or `"mathml"`
  
- Whether this add-on should invoke the Typst compiler to generate an SVG image (crisp, consistent rendering everywhere) or export to MathML (selectable text, colored by the client). Affects newly inserted equations and the replacing functionality; existing equations keep their stored format.

### `"adaptive-color"`: `true` (default) or `false`

- Only relevant for `"render-type": "svg"` (the default). When true, baked equations follow the color scheme of whichever client displays them — dark text on light themes, light text on dark ones, on AnkiDroid, AnkiWeb and desktop Anki alike. When false, the equation keeps the color it was compiled with (the preamble's `#set text(...)`).

### `"preamble"`: `"user_files/preamble.typ"` (default)

- The path to a custom preamble typst file for specifying custom functions, page dimensions or text size and color. Default is inside the `user_files` folder in the root folder of this add-on.
