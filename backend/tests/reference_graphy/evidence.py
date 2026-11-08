"""Stable references to original learner submissions; no model-generated answers."""

import hashlib
import re
import unicodedata

from .native import invoke


def normalized_task(text):
    text = unicodedata.normalize("NFKC", text).casefold().replace("`", "").replace("**", "")
    return re.sub(r"\s+", "", text).strip(".?!:;")


def reference(message_id, question_id=""):
    return "E" + hashlib.sha256(f"{message_id}:{question_id}".encode()).hexdigest()[:10]


def active_assessments(rows):
    replaced = {row["supersedes"] for row in rows if row.get("supersedes")}
    return [row for row in rows if row["id"] not in replaced]


def collect(session):
    result = {}
    previous = None
    for message in session.messages:
        if message["role"] == "assistant" and message.get("content", "").strip():
            previous = message
        elif message["role"] == "user":
            text = message.get("content", "")
            if previous and text.strip() and not text.lstrip().startswith("/"):
                ref = reference(message["id"])
                result[ref] = {"evidence_ref": ref, "source_message_id": message["id"],
                               "question": previous["content"], "answer": {"status": "answered", "text": text,
                               "selected_option_ids": [], "reasoning": ""}, "batch_id": "", "question_id": "",
                               "topic_id": "", "candidate": True}
            previous = None
    for batch_id, resolved in session.resolved_questions.items():
        if resolved["payload"]["status"] != "submitted":
            continue
        for question, answer in zip(resolved["block"]["questions"], resolved["payload"]["answers"], strict=True):
            ref = reference(resolved["message_id"], question["id"])
            result[ref] = {"evidence_ref": ref, "source_message_id": resolved["message_id"],
                           "question": question["prompt"], "answer": answer, "batch_id": batch_id,
                           "question_id": question["id"], "topic_id": question.get("topic_id", "")}
    return result


def assessment_evidence(row):
    return row.get("evidence_ref") or reference(row.get("source_message_id", ""), row.get("question_id", ""))


def candidate_attempt(source):
    """Recognize a learner attempt, excluding acknowledgements and unrelated requests."""
    source = {key: source[key] for key in ("candidate", "question", "answer") if key in source}
    return invoke("context.candidate_attempt", {"source": source})


def pending(session):
    assessed = {assessment_evidence(row) for row in active_assessments(session.learning.assessments)}
    return [ref for ref, source in session.evidence.items() if ref not in assessed
            and ref not in session.learning.ignored_evidence and candidate_attempt(source)]
