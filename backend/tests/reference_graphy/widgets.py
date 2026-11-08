"""Inline visuals: design guidelines on request and a display-only tool the interface draws in a sandbox."""

from importlib.resources import files

from .questions import TEXT, obj

MODULES = ("diagram", "chart", "interactive")
MAX_CODE = 60000
TOOLS = ("visualize_read_me", "show_widget")

READ_ME_SCHEMA = obj({"modules": {"type": "array", "minItems": 1, "maxItems": len(MODULES), "uniqueItems": True,
                                  "items": {"type": "string", "enum": list(MODULES)}}}, ["modules"])
SHOW_SCHEMA = obj({"title": TEXT | {"maxLength": 80, "description": "Short snake_case identifier, e.g. binary_search_steps"},
                   "widget_code": TEXT | {"maxLength": MAX_CODE}}, ["title", "widget_code"])

DESCRIPTIONS = {
    "visualize_read_me": "Design guidelines for show_widget (colors, SVG classes, Chart.js setup, interaction rules). "
                         "Call once before your first show_widget in a lesson, silently: never mention this call to the learner. "
                         "modules: diagram (flows, structures, geometry), chart (data, function plots), interactive (simulations, steppers, small tools); pick all that fit.",
    "show_widget": "Draw a visual inside the chat: an SVG diagram, a chart, an interactive HTML/JS explainer. Use it when a picture or a manipulable model teaches the idea faster than words. "
                   "widget_code is an HTML or SVG fragment (no DOCTYPE/html/head/body), only the visual, never explanatory prose: write the explanation in your reply. "
                   "Needs visualize_read_me read earlier in the lesson. The learner sees the result; you receive only a confirmation.",
}
DECLARATIONS = [
    {"name": "visualize_read_me", "description": DESCRIPTIONS["visualize_read_me"], "parameters": READ_ME_SCHEMA},
    {"name": "show_widget", "description": DESCRIPTIONS["show_widget"], "parameters": SHOW_SCHEMA},
]


def guidelines(modules):
    """The core rules followed by the requested modules, in a fixed order."""
    folder = files("graphy").joinpath("prompts", "widgets")
    names = ["core", *(m for m in MODULES if m in modules)]
    return "\n\n".join(folder.joinpath(f"{name}.md").read_text(encoding="utf-8").strip() for name in names)


def guidelines_read(messages):
    """Whether the guidelines are already in this lesson's history (a successful visualize_read_me result)."""
    return any(m.get("role") == "tool" and m.get("name") == "visualize_read_me" and not m.get("error") for m in messages)
