# Diagrams (SVG)
Use for flows, structures, hierarchies, cycles, timelines, geometry, cross-sections and anything where position and connection carry the meaning.

## SVG setup
- `<svg width="100%" viewBox="0 0 680 H" role="img">` with a fixed 680px-wide coordinate space; choose H to fit the content plus ~24px of margin at the bottom. Add `<title>` and `<desc>` as the first children.
- Every `<text>` needs a class: `t` (14px primary), `ts` (12px secondary), `th` (14px, weight 500, headings of a box). Never leave text without a class and never set `fill="inherit"`.
- `text-anchor="middle"` and `dominant-baseline="central"` for text centered in a box.
- Boxes: `<g class="c-blue"><rect x y width height rx="4"/><text class="th" ...>Title</text><text class="ts" ...>Sub</text></g>`. The color classes fill the rect and recolor the texts inside automatically in both themes. Available ramps: `c-purple c-teal c-coral c-pink c-gray c-blue c-green c-amber c-red`. Neutral box: `class="box"`. Use a ramp for meaning, gray for the rest.
- Connectors: `<path class="arr" d="M x y L x y" marker-end="url(#arrow)"/>` with this in `<defs>`:
  `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>`
  Leader/dashed line: `class="leader"`. Clickable node: add `class="node"` to the `<g>` and `onclick="sendPrompt('Explain the Parser step')"`.
- Lines and curves without a class: `stroke="var(--color-border-secondary)"` and `fill="none"`. Filled shapes may use the semantic variables, e.g. `fill="var(--color-background-info)"`.

## Rules
- Box text fits its box: about 8px per character at 14px. A box subtitle is at most five words; more detail goes in your reply or in a click-through (`sendPrompt`).
- At most four boxes in a horizontal row at full width (about 140px each). Five or more: shrink to about 110px, wrap into two rows, or split into an overview and a detail picture.
- Leave 16px or more between a box and the next; arrows never cross text; route around boxes. Straight horizontal or vertical arrows where possible.
- One idea, one picture: a flow, or a structure, or a cross-section. Keep the number of nodes under ~12.
- Mathematical figures (geometry, coordinate axes, function graphs by hand): draw axes with `stroke="var(--color-border-primary)"`, labels with class `ts`, the curve with `stroke="var(--color-text-info)" stroke-width="2" fill="none"`. For a real function plot with many points prefer a chart.
