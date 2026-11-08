"""Stable identifiers for the explanation instructions shipped with Graphy."""

DEFAULT_STYLE = "deep_dive"
EXPLANATION_STYLES = ("deep_dive", "quick_take", "conversational_mentor", "socratic", "structured_reference")
STYLE_HEADING = "# EXPLANATION STYLE:"
DEPTHS = {
    "adaptive": "",
    "brief": "Depth: keep the answer compact; include the essential reason and conditions. Expand only when needed for correctness or explicitly requested.",
    "detailed": "Depth: explain the requested idea thoroughly: develop difficult transitions, conditions and useful examples so the learner can follow the reasoning. Expand within the requested scope, and respect a request for a short answer or to work one step at a time.",
}
PRESENTATIONS = {
    "adaptive": "",
    "prose": "Presentation: develop the explanation in connected paragraphs, with at most one topic heading. Avoid subsection headings and routine bullet lists; keep necessary formulas readable.",
    "structured": "Presentation: separate a multi-part explanation into short, descriptively named sections for its distinct functions (such as the idea, reasoning or example, and practice). A single title over uninterrupted prose is not this layout. Use lists for independent items and tables for real comparisons. Short answers need no sections.",
}


# Global agent settings (store.prefs) -> the style line each non-adaptive choice replaces.
PREFERENCES = {"explanation_depth": ("Depth:", DEPTHS), "explanation_presentation": ("Presentation:", PRESENTATIONS)}


def validate_preference(key, value):
    choices = PREFERENCES[key][1]
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{key} must be one of " + ", ".join(choices))
    return value


def validate_style(value):
    if not isinstance(value, str) or value not in EXPLANATION_STYLES:
        raise ValueError("explanation_style must be one of " + ", ".join(EXPLANATION_STYLES))
    return value
