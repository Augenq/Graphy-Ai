---
name: graphy-document-style
description: "Appearance (only) of every document Graphy produces (handouts, notes, worksheets, study sheets, reports, anything passed to present_file): Computer Modern, black on white, book-style theorem/definition/example environments, MathML formulas, A4 print. Load before writing any document file."
---

# Graphy document style ("Russian classic")

This skill changes only appearance. Never add titles, subtitles, section names, labels, boilerplate, or any text the learner's request and the topic do not call for; the structure and wording come from the user's request, not from this skill. Do not add a table of contents or title page unless asked/needed.

Look: Computer Modern 12/15, justified text with 1.5 em paragraph indents, black on white, no colour, hairline rules, bold run-in heads for theorem-like environments. Apply it to document-like files created for the learner (anything you present_file). Do not apply it when the learner asks for another look or format (spreadsheet, plain markdown, their own template; slides use the deck mode below), to chat replies, or to inline `show_widget` visuals.

Base directory of this skill = the "Base directory" printed with this text (call it `$SKILL`). It holds: `build.mjs`, `document.css`, `skeleton.html`, `fonts/`, `katex.min.cjs`.

## Workflow (HTML is the default format)

1. Write the document as an HTML fragment (only the content, no `<html>`, `<head>` or `<style>`) in the workspace, e.g. `notes.src.html`. `$SKILL/skeleton.html` is a bare markup reference (placeholders only); copy only the elements the document needs.
2. Build one self-contained file: `node "$SKILL/build.mjs" notes.src.html notes.html`. It adds the page shell, inlines `document.css` and the Computer Modern fonts (data: URIs, works offline), and converts LaTeX math `$...$`, `$$...$$` to MathML with KaTeX. Exit code 1 prints the broken formula; fix and rebuild.
3. `present_file` the built `notes.html`, never the `.src.html`. The viewer runs HTML in a sandbox without scripts or network, so everything must be inline: no CDN links, no external images (use inline `<svg>` or `data:` URIs), no JavaScript.
4. PDF: when the learner or teacher asks for a PDF (or something to print), deliver a REAL PDF. Never answer that there is no browser and never hand over only HTML in that case. Write the document in LaTeX, copy `$SKILL/preamble.tex` next to it and start with `\documentclass[12pt]{article}\input{preamble}` (it sets CMU Serif with Cyrillic, A4 margins 32/28/28/34 mm, 12/15 pt, theorem/definition/example environments in Russian); compile with `timeout 90 xelatex -interaction=nonstopmode -halt-on-error doc.tex` (twice when there are references), check the log for «Missing character» or errors and fix them, then `present_file` the PDF and say which file it is. `reportlab` is installed for generated sheets/tables; `pandoc x.md -o x.pdf --pdf-engine=xelatex -V mainfont='CMU Serif'` for plain text. The built HTML stays the default only when no PDF was requested; give both when both are useful.
5. If `node` is unavailable, write a full HTML file by hand: copy the contents of `document.css` into a `<style>` and write formulas as MathML or plain Unicode; fonts then fall back to the system serif.

## Slide decks (presentations)

A presentation is a self-contained HTML deck, never a hand-written .pptx. Write the source as top-level `<section>` elements, one per slide (16:9), in the workspace, e.g. `deck.src.html`, then `node "$SKILL/build.mjs" deck.src.html deck.html --slides`. The build reuses the document fonts and math (KaTeX to MathML) and adds `slides.css`: a slide scales with its width, shows its number bottom right, and printing to PDF gives exactly one slide per page (`@page` 13.333x7.5 in). Rules: one idea per slide; a title and 3-5 short lines or one formula, table or inline SVG figure; `<section class="title">` for the opening slide (it shows no number); `<h2>` the slide title; `class="big"` for one large statement; `<div class="display">$$…$$</div>` for a formula; `<div class="cols">` for two columns; no scrolling content, so split a slide that overflows. Add no slides the request did not call for (no agenda, thanks, answers or name/date slide unless asked). Present `deck.html`; for a PDF use the print command from the workflow step 4.

A document written as LaTeX (when the learner asks for .tex/PDF via TeX) follows the same design: XeLaTeX, CMU Serif / Latin Modern Math, 12/15 pt, A4 with inner 32 mm, outer 28 mm, top 28 mm, bottom 34 mm, `\parindent 1.5em`, KOMA-Script headings in bold, amsthm theorem styles matching the environments below.

## Page and typography

- Text: Computer Modern Serif, 12 pt on 15 pt (print), 17 px on 1.28 screen. Justified, `lang="ru"` hyphenation on, red-line indent 1.5 em, no blank space between paragraphs. Measure about 66 characters (the sheet is about 41 em wide with padding): never widen it, never make multi-column text.
- Colour: black text, white paper. Grey only for secondary figure elements. No coloured headings, highlighter boxes, cards, shadows inside the text, emoji or icons. The sheet sits on a light-grey desk in the viewer (same in light and dark theme: it stays paper).
- Print: A4, margins left 32 / right 28 / top 28 / bottom 34 mm, page number bottom centre, no header or footer text.
- Russian typography: guillemets «…», em dash — with a non-breaking space before it (`&nbsp;—`), decimal comma (`2,5`; in formulas `2{,}5`), non-breaking space between a number and its unit and after one-letter prepositions, `№` not `No`, ё where it is correct. Use real minus `−` in text, `×`, `…`.
- Emphasis: italic for defined terms and light emphasis, bold only in heads. No underlining, no ALL CAPS.

## Headings and numbering

- `<h1>` document title (if the document has one), left-aligned, bold, large.
- `<h2>` sections are numbered automatically (`1.`, `2.`), `<h3>` subsections `1.1.`; `<h4>` is an unnumbered bold minor head. `class="nonum"` gives an unnumbered `h2`/`h3`; `class="plain"` on `h3` a small unnumbered head. At most three levels. Headings never end with a period and are never alone at the bottom of a page (CSS).
- Counters of environments, figures, tables and equations restart in each `<h2>` and print as `section.number` (Теорема 2.3). A document with no `<h2>` at all: build with `--flat` (`node "$SKILL/build.mjs" in.html out.html --flat`), numbers print plainly (Теорема 1, (1)); a document with `<h2>` must not use `--flat`.
- Table of contents: `<nav class="toc">` (see skeleton), links to `id`s, no page numbers; only when requested or clearly needed.

## Environments

Markup `<div class="KIND"><p><span class="head">(title)</span> text</p></div>`. `span.head` prints the label and number itself: leave it empty for no title, or put the title in it (it adds the parentheses/period). Do not type "Теорема 1" by hand. Use an environment only where the document's own content calls for it; plain explanation stays plain paragraphs.

| class | auto label | look |
|---|---|---|
| `definition` | Определение 1.1 | bold head, upright text |
| `theorem` / `lemma` / `corollary` / `proposition` | Теорема / Лемма / Следствие / Предложение 1.2 | bold head, whole statement in italic |
| `remark` | Замечание 1.3 | bold head, upright text |
| `proof` | Доказательство | italic head, upright text, closing □ after the last word |
| `example` | Пример 1.1 | bold head, upright text, closing ◊ at the right margin |
| `note` | none; text comes from `data-label` on `span.head` | italic head, text between two thin black rules |

`note` markup: `<div class="note"><p><span class="head" data-label="…"></span> …</p></div>`; without `data-label` it is just a ruled paragraph. No coloured or filled boxes, side bars, icons or banners.

## Math

- Write LaTeX in `$…$` (inline) and `$$…$$` (display); `build.mjs` converts it. Display formulas go on their own and are centred. A numbered display formula: `<div class="eq">$$…$$</div>` prints `(1.1)` at the right margin; number only the formulas you refer to, and refer as "формула (1.1)".
- A display formula is a block: never write `$$…$$` inside a `<p>` (the browser closes the paragraph and leaves a stray empty one). End the paragraph, put `<div>$$…$$</div>` (or `<div class="eq">`) after it, and continue with a new `<p>`; the paragraph after a display is automatically not indented.
- Punctuation belongs to the formula sentence: put the comma or period inside the `$$`: `$$x=1,$$`. Do not start a sentence with a symbol.
- Inline math is for short expressions; anything with fractions, sums or tall structure goes to display. Inline fractions: `\tfrac`. Intervals `[a;\,b]` (semicolon, thin space), decimals `2{,}5`, set builder `\{x \mid x>0\}`, functions `\sin`, `\lim`, `\operatorname{dist}`, vectors `\vec a`, number sets `\mathbb R`, `\le`/`\ge` (not `\leq`), `\varepsilon`, `\varphi`, absolute value `|x|`.
- Rules for this converter: write `&lt;`/`&gt;` or `\lt`/`\gt` if a bare `<` confuses you (normally `a<b` inside `$…$` is fine); a minus right after `|` must be braced: `|{-5}|`; wide alignments use `\begin{aligned}…\end{aligned}` or `cases`; text inside formulas `\text{если }x>0`. A literal dollar sign in prose is `&#36;` (or `<code>$</code>`).
- Never mix: no images of formulas, no unicode fake math (`x²`) in running text for anything beyond trivial exponents like m², no raw LaTeX left in text.

## Tables

`<table>` with `<thead>` and `<tbody>`: heavy rule above and below, one thin rule under the header, no vertical lines, no zebra stripes, no coloured header. Cells are centred; first text column left (`class="l"`); numbers align right (`class="r"`) when they have different lengths. Header cells are not bold (the CSS handles it). Optional `<caption>` prints "Таблица 1.1." above. A table must be introduced in the text ("см. таблицу"). Use `class="rules"` on the table to get hair rules between rows for long tables. Keep tables narrower than the text block; more than 7 columns is a sign to restructure.

## Figures

`<figure>` + `<figcaption>` (small, justified, bold label "Рис. 1.1." added automatically). Draw with inline SVG: black strokes 1–1.2 px, grey `#737373` for secondary elements, light grid `#d9d9d9`, no fills except white/black/very light grey, text inside the SVG in serif (inherited) at about the size of the body text, labels in italic for variables. Axes with arrowheads, ticks labelled. Always mention the figure in the text first. The caption says what is shown and what the figure does **not** prove. Photographs and raster images: only if the learner gave them; embed as `data:` URI.

## Lists, code, quotes, footnotes

- `<ol>` numbered `1.`, `<ol class="alpha">` gives `а)`, `б)`, `в)`, `<ul>` bullets; items are short, non-bulleted prose is preferred over long nested lists. At most two nesting levels.
- Code in `<pre><code>`: monospace (CM Typewriter), framed with a thin black rule, never coloured syntax highlighting.
- Quotes: `<blockquote>` italic, indented. Footnotes: `<sup class="fnref"><a id="r1" href="#fn1">1</a></sup>` and a final `<div class="footnotes"><ol><li id="fn1">…</li></ol></div>`; use sparingly, only for side remarks and sources.
- Links: plain black text for internal references; external URLs underlined; never "click here".

## Checklist before present_file

Built through `build.mjs` (not the `.src.html`); no text added that the request did not call for; all formulas rendered (no stray `$`); environments have the right class; no colour; Russian punctuation; justified single column; file is self-contained (no http links to scripts, fonts, images).
