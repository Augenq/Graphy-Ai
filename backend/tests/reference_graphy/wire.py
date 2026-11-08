"""JSON projections of session state for the local API.

Everything a client receives goes through here. Answer keys and rubrics never leave the process (the agent
commits them when it asks, the learner must not see them), provider-native payloads stay internal, and the
durable lesson transactions are turned into small `ui` records so a reloaded history looks like a live one.
"""

import json

from .evidence import active_assessments
from .learning import PHASE_LABELS
from .questions import public_block

SECRET_QUESTION_FIELDS = ("correct", "rubric", "grading")
INTERNAL_MESSAGE_FIELDS = ("native", "context_measurement", "images", "display", "attachments")


def public_arguments(name, arguments):
    """Arguments of a call as the learner may see them: the test form without its answer key."""
    if name != "ask_questions" or not isinstance(arguments, dict):
        return arguments
    questions = arguments.get("questions")
    if not isinstance(questions, list):
        return arguments
    return arguments | {"questions": [
        {k: v for k, v in q.items() if k not in SECRET_QUESTION_FIELDS} if isinstance(q, dict) else q
        for q in questions]}


def public_call(call):
    row = {"id": call["id"], "name": call["name"], "arguments": public_arguments(call["name"], call.get("arguments"))}
    if call.get("argument_error"):
        row["argument_error"] = call["argument_error"]
    return row


def public_result(call, result):
    """A tool result for the transcript. Test results keep the learner's own answers, never the verdicts."""
    content = result.get("content", "") if isinstance(result, dict) else str(result)
    if call.get("name") == "ask_questions":
        content = ask_result(content)
    row: dict = {"content": content if isinstance(content, str) else str(content)}
    if isinstance(result, dict):
        if result.get("error"):
            row["error"] = True
        if result.get("images"):
            row["images"] = len(result["images"])
    return row


def ask_result(content):
    try:
        payload = json.loads(content)
    except (ValueError, TypeError):
        return content
    if not isinstance(payload, dict) or "status" not in payload:
        return content
    keep = {k: payload[k] for k in ("batch_id", "status", "answers") if k in payload}
    return json.dumps(keep, ensure_ascii=False)


def public_question(block):
    """An open or resolved question block without grading; drafts and the current step stay."""
    return public_block(block)


def transaction_index(session):
    return {e["source_call"]: e for e in session.events
            if e["type"] == "learning_transaction" and e.get("source_call")}


def tool_ui(session, call_id, index=None):
    """Lesson records a tool call produced, derived from the durable transaction (None if nothing changed)."""
    if index is None:
        event = next((e for e in reversed(session.events)
                      if e["type"] == "learning_transaction" and e.get("source_call") == call_id), None)
    else:
        event = index.get(call_id)
    if event is None:
        return None
    steps = []
    plan = None
    for operation in event["operations"]:
        data = operation["data"]
        match operation["type"]:
            case "learning_plan":
                plan = data
                steps.append({"kind": "plan", "goal": data.get("goal", ""),
                              "steps": [s["title"] for s in data["steps"]]})
            case "learning_phase":
                known = plan["steps"] if plan else session.learning.steps
                number = next((i for i, s in enumerate(known, 1) if s["id"] == data.get("current_step")), None)
                steps.append({"kind": "phase", "phase": data["phase"], "step": number})
            case "learning_assessment":
                if steps and steps[-1]["kind"] == "assessment":
                    steps[-1]["items"].append(assessment_row(data))
                else:
                    steps.append({"kind": "assessment", "items": [assessment_row(data)]})
            case "learning_finished":
                steps.append({"kind": "finished", "summary": data["summary"], "next_step": data["next_step"]})
    return steps or None


def assessment_row(data):
    return {"id": data["id"], "question": data.get("task") or data.get("question", ""),
            "outcome": data["outcome"], "feedback": data.get("feedback", ""),
            "used_hints": bool(data.get("used_hints")), "topic_id": data.get("topic_id", ""),
            "supersedes": data.get("supersedes", "")}


def public_message(session, message, *, at=None, index=None):
    role = message.get("role")
    row = {"id": message.get("id", ""), "role": role}
    if at is not None:
        row["at"] = at
    if role == "user":
        row["content"] = message.get("display", message.get("content", ""))
        if message.get("attachments"):
            row["attachments"] = message["attachments"]
        if message.get("images"):
            row["images"] = len(message["images"])
        return row
    if role == "assistant":
        row.update(content=message.get("content", ""), thinking=message.get("thinking", ""),
                   calls=[public_call(c) for c in message.get("calls", [])],
                   stop=message.get("stop", "stop"), provider=message.get("provider", ""),
                   model=message.get("model", ""))
        if message.get("usage"):
            row["usage"] = message["usage"]
        if message.get("thinking_ms") is not None:
            row["thinking_ms"] = message["thinking_ms"]
        return row
    # tool result
    call = {"name": message.get("name", "")}
    row.update(call_id=message.get("call_id", ""), name=call["name"], **public_result(call, message))
    if message.get("ms") is not None:
        row["ms"] = message["ms"]
    ui = tool_ui(session, message.get("call_id", ""), index) if message.get("name", "") in LESSON_TOOLS else None
    if ui:
        row["ui"] = ui
    return row


LESSON_TOOLS = ("set_learning_plan", "set_learning_phase", "record_assessment", "finish_lesson")


def message_times(session):
    return {id(e["message"]): e.get("time") for e in session.events
            if e["type"] in ("message", "question_resolved") and "message" in e}


def history(session):
    index = transaction_index(session)
    times = message_times(session)
    return [public_message(session, m, at=times.get(id(m)), index=index) for m in session.messages]


def learning_projection(session):
    state = session.learning
    if state is None:
        return None
    current = next((i for i, s in enumerate(state.steps, 1) if s["id"] == state.current_step), None)
    return {
        "goal": state.goal, "phase": state.phase, "phase_label": PHASE_LABELS[state.phase],
        "steps": [{"id": s["id"], "title": s["title"]} for s in state.steps],
        "current_step": state.current_step, "current_index": current,
        "finished": state.finished, "summary": state.summary, "next_step": state.next_step,
        "assessments": [assessment_row(a) for a in active_assessments(state.assessments)],
    }


def resolved_questions(session):
    rows = {}
    for batch_id, resolved in session.resolved_questions.items():
        block = resolved["block"]
        if not block:
            continue
        payload = resolved["payload"]
        rows[batch_id] = {"block": public_question(block), "status": payload["status"],
                          "answers": payload["answers"], "message_id": resolved["message_id"]}
    return rows

