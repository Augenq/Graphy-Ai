# Interactive explainers and small interfaces
Use for simulations, parameter explorations, steppers through an algorithm, worked-example walkthroughs and tiny tools (a unit converter, a calculator for the formula being taught). The learner changes something and watches the result change; the point of the widget is the relationship, not the controls.

## Pattern
1. Controls on top or left (sliders with the current value shown next to them, buttons, a select). 2. A live result below: one SVG or canvas picture and, if needed, two or three metric cards. 3. A script that holds state in plain variables and one `render()` function that rewrites the picture and the numbers from that state.
- Metric card: `<div style="background: var(--color-background-secondary); border-radius: var(--border-radius-md); padding: 12px 14px;"><div style="font-size: 12px; color: var(--color-text-secondary);">Label</div><div style="font-size: 20px; font-weight: 500;">value</div></div>`, laid out with `display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px`.
- Slider row: `<label>` + `<input type="range">` + `<span>` with the value; `input` events call `render()`.
- Stepper: "Back" and "Next" buttons plus "Step 2 of 5"; every step shows all of its content stacked, then the script highlights the current one. Never hide the other steps from the first paint.
- Draw with inline SVG updated through attributes, or a `<canvas>` (use `devicePixelRatio`). Animations: `requestAnimationFrame`, stop them when the parameters stop changing; no infinite decorative motion.
- Fixed sensible ranges and defaults so the first paint already shows an interesting state. Round displayed numbers.
- Forms and mockups: use the pre-styled inputs, `border: 0.5px solid var(--color-border-tertiary)` cards, 12-16px padding, 8-12px gaps. A mockup of a UI shows realistic content, not lorem ipsum.
- When a click should make you explain something, call `sendPrompt('...')` with a complete, specific question ("Why does the period double when the length quadruples?"); never with generic text like "tell me more".
- Keep the script under ~120 lines; a widget that needs more is two widgets.
