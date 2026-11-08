"""Public v2 tool contracts. Internal journal records are validated separately."""

from .learning import PHASES
from .native import invoke
from .questions import obj

S = {"type": "string"}
QUESTION_MARKDOWN = (
    "Markdown with KaTeX math is rendered in question prompts and option labels, including the review. "
    "Use $...$ for inline math and $$...$$ on separate lines for display math. "
    "Markdown emphasis, lists, tables and fenced code blocks are supported. "
    "Do not wrap math in code backticks; do not use HTML or full LaTeX documents. "
    "Escape every LaTeX backslash in JSON (e.g. \\frac must be encoded with two backslashes), "
    "and encode newlines as JSON newline escapes."
)
MAX_PLAN_STEPS = 30  # a route "from scratch" to a real goal needs its prerequisites as steps
OUTCOMES = ["independent", "with_hints", "gap", "uncertain", "skipped"]
ASSISTANCE = ["none", "hints", "solution", "unknown"]

PUBLIC = {
    "set_learning_plan": obj({
        "goal": S,
        "steps": {"type": "array", "minItems": 1, "maxItems": MAX_PLAN_STEPS, "uniqueItems": True, "items": S},
    }, ["goal", "steps"]),
    "set_learning_phase": obj({
        "phase": {"type": "string", "enum": PHASES},
        "step": {"type": "integer", "minimum": 1},
    }, ["phase"]),
    "record_assessment": obj({
        "items": {"type": "array", "minItems": 0, "maxItems": 8, "items": obj({
            "evidence_ref": S,
            "outcome": {"type": "string", "enum": OUTCOMES},
            "assistance": {"type": "string", "enum": ASSISTANCE,
                           "description": "Help received BEFORE this attempt, not feedback now given."},
            "feedback": S,
            "correction": {"type": "boolean"},
        }, ["evidence_ref", "outcome", "assistance", "feedback"])},
        "ignore_refs": {"type": "array", "maxItems": 8, "uniqueItems": True, "items": S},
    }, ["items"]),
    "ask_questions": obj({
        "title": S | {"description": "Short plain-text title, without Markdown or math."},
        "questions": {"type": "array", "minItems": 3, "maxItems": 8, "items": obj({
            "prompt": S | {"description": QUESTION_MARKDOWN},
            "type": {"type": "string", "enum": ["free_text", "single_choice", "multiple_choice"]},
            "options": {"type": "array", "minItems": 2, "maxItems": 8, "uniqueItems": True, "items": S | {"description": QUESTION_MARKDOWN}},
            "correct": {"type": "array", "minItems": 1, "maxItems": 8, "uniqueItems": True,
                        "items": {"type": "integer", "minimum": 1, "maximum": 8}},
            "rubric": S,
        }, ["prompt", "type"])},
    }, ["title", "questions"]),
    "finish_lesson": obj({"summary": S, "next_step": {"type": "string"}}, ["summary", "next_step"]),
}

DESCRIPTIONS = {
    "set_learning_plan": "Only for a large route or an explicit request to plan, never for a single topic. Save the learner's concrete goal (your own words) and the complete ordered topics, prerequisites included, that this goal needs, skipping what they already know, with no closing exam or recap step; the first plan activates step 1. Teaching the first topic starts in the same turn.",
    "set_learning_phase": "Change phase; step is a 1-based plan position. review does not finish the lesson.",
    "record_assessment": "Save judgments: ONE evidence_ref per item. A mixed answer with any error is gap; with_hints needs assistance=hints|solution given BEFORE the attempt. Record help even for errors. correction=true revises the SAME answer. Non-attempt: items=[], ignore_refs=[ref].",
    "ask_questions": "Open 3–8 test questions and pause for a requested test or agreed assessment, not as an automatic ending to an explanation. Call alone WITHOUT prose; never reveal answers before submission. options: texts; correct: 1-based option numbers. free_text has neither. correct/rubric = your answer key, committed now and hidden: it cannot be revised after the answer; omit for ungraded questions. The learner may answer \"I don't know\" (a gap). " + QUESTION_MARKDOWN,
    "finish_lesson": "Internal record at a real ending (all planned topics done, or the learner ends): what was explained versus demonstrated, remaining gaps, the next step (empty if none). Not a prompt to print a recap or give a final test; do that only if the learner asks.",
}

WEB_PUBLIC = {
    "web_search": obj({"query": S}, ["query"]),
    "web_read": obj({"url": S, "offset": {"type": "integer", "minimum": 1},
                     "column": {"type": "integer", "minimum": 1},
                     "limit": {"type": "integer", "minimum": 1, "maximum": 300}}, ["url"]),
}

SKILL_PUBLIC = obj({"name": S}, ["name"])


def heal_member(value, members):
    """Recover copied enum syntax, leaving unknown values for validation to reject."""
    return invoke("context.heal_member", {"value": value, "members": members})


def normalize_optional(schema, value):
    """Normalize complete JSON containers and strict optional nulls, never partial JSON."""
    return invoke("context.normalize_optional", {"schema": schema, "value": value})
