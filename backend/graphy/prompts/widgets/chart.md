# Charts and data (Chart.js)
Use for numbers: comparisons, trends, distributions, function plots, proportions. If the numbers are few (under five) a sentence or a small table is better.

## Setup
```
<div style="position: relative; width: 100%; height: 320px;"><canvas id="c" role="img" aria-label="one-line description of the data"></canvas></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
new Chart(document.getElementById('c'), { type: 'line', data: {...}, options: { responsive: true, maintainAspectRatio: false, ... } });
</script>
```
- Set the height on the wrapper `div` (200-360px), never on the canvas; `maintainAspectRatio: false`.
- Canvas cannot read CSS variables. Read them once: `const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();` and pass `css('--color-text-secondary')` for tick colors and `css('--color-border-tertiary')` for grid lines. Do this inside the script, after the markup.
- Series colors: hard-coded hex that works on light and dark: blue `#378ADD`, teal `#1D9E75`, coral `#D85A30`, amber `#BA7517`, purple `#7F77DD`, green `#639922`, pink `#D4537E`, gray `#888780`. One series: one color. Use at most four colors; encode category with color only when it carries meaning.
- Turn off the built-in legend (`plugins: { legend: { display: false } }`) and write a small HTML legend above the chart (a colored 10px square + 12px label) when there is more than one series.
- Axes: `ticks: { color, font: { size: 12 } }`, grid `color` from the variable, no border lines on the value axis. Label axes with units in the tick callback or the axis title. Start bar charts at zero. Do not use 3D or pie charts with more than five slices.
- Function plots: compute 100-300 points in the script, `type: 'line'`, `pointRadius: 0`, `tension: 0`, `parsing` default; axes of a scatter-type line use `type: 'linear'`.
- Add a slider or toggle only if it teaches something (see the interactive module); recompute with `chart.data.datasets[0].data = ...; chart.update('none')`.
- Numbers shown to the learner use the language's formatting (`toLocaleString`).
