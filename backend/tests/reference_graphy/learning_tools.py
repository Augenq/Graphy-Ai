"""Sequential teaching tools, document processing, research and local skills."""

import copy
import hashlib
import json

from . import widgets
from .context import chat_exchange, is_acknowledgement
from .contracts import DESCRIPTIONS, MAX_PLAN_STEPS, PUBLIC, SKILL_PUBLIC, WEB_PUBLIC, normalize_optional
from .evidence import active_assessments, assessment_evidence, candidate_attempt, normalized_task, pending
from .learning import PHASES
from .questions import ASK_SCHEMA, ID, TEXT, obj, validate_schema
from .skills import Skills
from .tools import Tools
from .web import DEFINITIONS as WEB_DEFINITIONS
from .web import WebResearch

SKILL_SCHEMA = obj({"name": TEXT | {"maxLength": 64}}, ["name"])

DEFINITIONS = {
    "ask_questions": (
        DESCRIPTIONS["ask_questions"], ASK_SCHEMA),
    "set_learning_plan": (
        f"Save the lesson plan (up to {MAX_PLAN_STEPS} steps) and goal: the learner's aim in one sentence of your own words, never a copy of their message.",
        obj({"goal": TEXT | {"maxLength": 300},
             "steps": {"type": "array", "minItems": 1, "maxItems": MAX_PLAN_STEPS,
                       "items": obj({"id": ID, "title": TEXT | {"maxLength": 240}}, ["id", "title"])}}, ["steps"])),
    "set_learning_phase": (
        "Change phase and current step (step: its number in the plan or its title).",
        obj({"phase": {"type": "string", "enum": PHASES}, "current_step": {"type": "string", "maxLength": 100}}, ["phase"])),
    "record_assessment": (
        "Record evidence from the learner's own answer. For a form question give batch_id + question_id; for a chat reply give neither. outcome: independent (correct, no help), with_hints, gap (wrong), uncertain, skipped. Never for self-reports or a bare 'yes'.",
        obj({"id": ID, "batch_id": {"type": "string", "maxLength": 100}, "question_id": {"type": "string", "maxLength": 100},
             "question": TEXT, "answer": {"type": ["string", "object"], "maxLength": 4000},
             "topic_id": {"type": "string", "maxLength": 100},
             "outcome": {"type": "string", "enum": ["independent", "with_hints", "gap", "uncertain", "skipped"]},
             "feedback": TEXT, "used_hints": {"type": "boolean"}, "supersedes": ID},
            ["id", "outcome", "feedback", "used_hints"])),
    "finish_lesson": (
        "Save the lesson summary and next step (a record, not a printed recap).",
        obj({"summary": TEXT, "next_step": {"type": "string", "maxLength": 8000}}, ["summary", "next_step"])),
}


class LearningTools(Tools):
    def __init__(self, cwd, session, enabled=None, *, store=None, web=None, skills=None):
        allowed = ["read", "bash", *WEB_DEFINITIONS, "load_skill"]
        super().__init__(cwd, allowed if enabled is None else [name for name in enabled if name in allowed])
        self.session = session
        self.store = store
        self.web = web or WebResearch(store, cache_dir=session.path.parent / (session.path.stem + ".web"))
        self.skills = skills or Skills(session.root, cwd)
        self.memory: list[dict] = []

    @property
    def skills_enabled(self):
        return "load_skill" in self.enabled and (self.store is None or self.store.prefs.get("skills_enabled", True))

    async def close(self):
        await self.web.close()

    def read_file(self, args, stop):
        path = self.path(args["path"])
        resolution = ""
        # A model can incorrectly apply a skill's support directory to a learner's material.
        # Resolve only an existing, explicitly learner-mentioned cwd file, never an arbitrary missing path.
        if not path.exists() and path.is_absolute():
            roots = [self.path(skill["path"]).parent for skill in self.session.learning.skills]
            user_text = "\n".join(m.get("content", "") for m in self.session.messages if m["role"] == "user")
            candidate = self.cwd / path.name
            if (any(path.is_relative_to(root) for root in roots) and candidate.is_file()
                    and path.name in user_text and str(path) not in user_text):
                resolution = f"Resolved learner material {path.name} relative to the working directory.\n"
                path = candidate
                args = args | {"path": str(candidate)}
        if path.suffix.lower() in (".pdf", ".doc", ".docx", ".epub", ".zip"):
            raise ValueError("Этот формат пока не поддерживается. Используйте текст, Markdown или изображение.")
        if path.is_file() and path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
            with path.open("rb") as stream:
                if b"\0" in stream.read(4096):
                    raise ValueError("Бинарный файл нельзя прочитать как учебный текст")
        result = super().read_file(args, stop)
        if not result.get("images"):
            result["content"] = resolution + f"Source: {self.path(args['path'])}, line {args.get('offset', 1)}\n" + result["content"]
        return result

    @property
    def declarations(self):
        return super().declarations + [
            {"name": name, "description": DESCRIPTIONS[name], "parameters": copy.deepcopy(PUBLIC[name])}
            for name, (desc, schema) in DEFINITIONS.items()] + [
            {"name": name, "description": desc, "parameters": copy.deepcopy(WEB_PUBLIC[name])}
            for name, (desc, schema) in WEB_DEFINITIONS.items() if name in self.enabled] + ([
                {"name": "load_skill", "description": "Load a listed local skill (SKILL.md); never runs scripts.",
                 "parameters": copy.deepcopy(SKILL_PUBLIC)}
            ] if self.skills_enabled and self.skills.list() else []) + copy.deepcopy(widgets.DECLARATIONS)

    def prepare(self, name, data):
        """Fill what the model should not have to invent: ids, flags, links between records."""
        state = self.session.learning
        if not isinstance(data, dict) or state is None:
            return data
        data = dict(data)
        if name == "set_learning_plan":
            steps, used = [], set()
            for number, step in enumerate(data.get("steps") or [], 1):
                step = {"title": step} if isinstance(step, str) else dict(step) if isinstance(step, dict) else step
                if isinstance(step, dict) and not step.get("id"):
                    title = str(step.get("title", "")).strip().casefold()
                    same = next((s["id"] for s in state.steps if s["title"].strip().casefold() == title), None)
                    fresh = number
                    while f"s{fresh}" in used or any(s["id"] == f"s{fresh}" for s in state.steps):
                        fresh += 1
                    step["id"] = same if same and same not in used else f"s{fresh}"
                if isinstance(step, dict):
                    used.add(step["id"])
                steps.append(step)
            data["steps"] = steps
        elif name == "set_learning_phase":
            step = data.pop("step", None)
            wanted = str(data.get("current_step") or step or "").strip()
            if wanted:
                title = wanted.casefold()
                by_id = next((s["id"] for s in state.steps if s["id"] == wanted), None)
                by_number = state.steps[int(wanted) - 1]["id"] if wanted.isdigit() and 0 < int(wanted) <= len(state.steps) else None
                by_title = next((s["id"] for s in state.steps if s["title"].strip().casefold() == title), None)
                data["current_step"] = by_id or by_number or by_title or wanted
            elif data.get("phase") in ("teaching", "practice") and state.current_step:
                data["current_step"] = state.current_step
        elif name == "record_assessment":
            data.setdefault("used_hints", data.get("outcome") == "with_hints")
            if not data.get("id"):
                n = len(state.assessments) + 1
                while any(a["id"] == f"a{n}" for a in state.assessments):
                    n += 1
                data["id"] = f"a{n}"
            if data.get("batch_id") and data.get("question_id") and not data.get("supersedes"):
                earlier = [a for a in state.assessments if (a.get("batch_id"), a.get("question_id")) ==
                           (data["batch_id"], data["question_id"])]
                if earlier:
                    data["supersedes"] = earlier[-1]["id"]  # a second record of the same answer is a correction
        return data

    async def execute(self, call, update=None):
        """Protect preparation as well as execution; never turn a failed save into success."""
        try:
            if call.get("argument_error"):
                raise ValueError(call["argument_error"])
            name, args = call["name"], call.get("arguments", {})
            if name in PUBLIC:
                args = normalize_optional(PUBLIC[name], args)
            elif name in WEB_PUBLIC:
                args = normalize_optional(WEB_PUBLIC[name], args)
            if call.get("id") in self.session.operation_results:
                return {"content": json.dumps(self.session.operation_results[call["id"]], ensure_ascii=False, separators=(",", ":"))}
            if name in widgets.TOOLS:
                return self._widget_call(name, args)
            if name in PUBLIC and name != "ask_questions":
                # Old typed arguments remain readable for resumed v1 sessions and integrations.
                legacy = (name == "record_assessment" and isinstance(args, dict) and "items" not in args
                          or name == "set_learning_plan" and isinstance(args, dict)
                          and isinstance(args.get("steps"), list) and args["steps"] and isinstance(args["steps"][0], dict)
                          or name == "set_learning_phase" and isinstance(args, dict)
                          and ("current_step" in args or isinstance(args.get("step"), str)))
                if not legacy:
                    validate_schema(PUBLIC[name], args)
                    result = self._lesson_call(name, args, call["id"])
                    return {"content": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}
            if name in WEB_PUBLIC:
                if name not in self.enabled:
                    raise ValueError(f"Tool disabled: {name}")
                if self.session.pending_question:
                    raise ValueError("Resolve the open question first")
                validate_schema(WEB_PUBLIC[name], args)
                result = await (self.web.search(**args) if name == "web_search" else self.web.read(**args))
                return {"content": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}
            return await self._execute_legacy(call | {"arguments": args}, update)
        except Exception as exc:
            message = str(exc)
            if self.store:
                message = self.store.redact(message)
            return {"content": json.dumps({"error": "storage_error" if isinstance(exc, OSError) else "invalid_argument",
                                           "message": message[:1200]}, ensure_ascii=False), "error": True}

    def _widget_call(self, name, args):
        if self.session.pending_question:
            raise ValueError("Resolve the open question first")
        if name == "visualize_read_me":
            args = normalize_optional(widgets.READ_ME_SCHEMA, args)
            validate_schema(widgets.READ_ME_SCHEMA, args)
            return {"content": widgets.guidelines(args["modules"])}
        validate_schema(widgets.SHOW_SCHEMA, args)
        if not widgets.guidelines_read(self.session.messages[self.session.boundary:]):
            raise ValueError("Call visualize_read_me first (silently), then repeat show_widget")
        return {"content": f'Widget "{args["title"]}" is shown to the learner. Continue in text; do not describe it line by line.'}

    def _lesson_call(self, name, args, operation_id):
        state = self.session.learning
        if state is None or self.session.pending_question:
            raise ValueError("Resolve the open question first")
        operations = []
        result = {}
        if name == "set_learning_plan":
            validate_schema({"type": "string", "maxLength": 300}, args["goal"])
            if any(len(title) > 240 for title in args["steps"]):
                raise ValueError("Each step title must be at most 240 characters")
            titles = [title.strip() for title in args["steps"]]
            if any(not title for title in titles) or len(set(t.casefold() for t in titles)) != len(titles):
                raise ValueError("Use distinct nonempty step titles")
            if state.goal == args["goal"] and [s["title"] for s in state.steps] == titles:
                return {"recorded": "unchanged", "step": state.current_step}
            used = {s["id"] for s in state.steps}
            for event in self.session.events:
                for entry in event.get("operations", [event]):
                    if entry["type"] == "learning_plan":
                        used.update(s["id"] for s in entry["data"]["steps"])
            steps = []
            for title in titles:
                old = next((s for s in state.steps if s["title"] == title and state.goal == args["goal"]), None)
                number = 1
                while f"s{number}" in used:
                    number += 1
                identifier = old["id"] if old else f"s{number}"
                used.add(identifier)
                steps.append({"id": identifier, "title": title})
            current = state.current_step if state.current_step in {s["id"] for s in steps} else steps[0]["id"]
            phase = "teaching" if state.phase in ("diagnosis", "planning", "review") else state.phase
            operations = [{"type": "learning_plan", "data": {"goal": args["goal"], "steps": steps}},
                          {"type": "learning_phase", "data": {"phase": phase, "current_step": current}}]
            result = {"recorded": "learning_plan", "step": next(i for i, s in enumerate(steps, 1) if s["id"] == current),
                      "next": "Plan saved. Now write this step's explanation in this turn."}
        elif name == "set_learning_phase":
            step = args.get("step")
            if step is not None and step > len(state.steps):
                raise ValueError(f"step must be from 1 to {len(state.steps)}")
            if args["phase"] in ("teaching", "practice") and not state.steps:
                raise ValueError("Save a plan before teaching or practice")
            data = {"phase": args["phase"], "current_step": state.steps[step - 1]["id"] if step else state.current_step}
            if data == {"phase": state.phase, "current_step": state.current_step} and not state.finished:
                return {"recorded": "unchanged"}
            operations = [{"type": "learning_phase", "data": data}]
            result = {"recorded": "learning_phase"}
        elif name == "record_assessment":
            ignored = args.get("ignore_refs", [])
            if not args["items"] and not ignored:
                if pending(self.session):
                    raise ValueError("Provide actual assessment items or ignore_refs for pending non-attempt chat replies")
                return {"saved": [], "unassessed": [], "note": "No pending attempts; no assessment was created."}
            if set(ignored) & {item["evidence_ref"] for item in args["items"]}:
                raise ValueError("An answer cannot be both assessed and ignored")
            operations, result = self._assess(args["items"])
            if ignored:
                operations.append({"type": "learning_evidence_ignored", "data": {"refs": ignored}})
                result["unassessed"] = [ref for ref in result["unassessed"] if ref not in ignored]
        else:
            if state.finished and state.summary == args["summary"] and state.next_step == args["next_step"]:
                return {"recorded": "unchanged"}
            operations = [{"type": "learning_finished", "data": args}]
            result = {"recorded": "learning_finished"}
        return self.session.transact(operations, operation_id, result)

    def _assess(self, items):
        state = self.session.learning
        evidence = self.session.evidence
        active = active_assessments(state.assessments)
        operations, saved, seen, ignored = [], [], set(), []
        for item in items:
            source = evidence.get(item["evidence_ref"])
            if source is None:
                raise ValueError("Use ONE supplied evidence_ref per item; never join references. Available: "
                                 + ", ".join(pending(self.session)[-8:]))
            if source.get("candidate") and not candidate_attempt(source):
                ignored.append(item["evidence_ref"])
                continue
            question = source["question"]
            task = item.get("task", "")
            task_source = None
            if task:
                sources = []
                if source.get("candidate"):
                    for message in self.session.messages:
                        if message.get("id") == source["source_message_id"]:
                            break
                        if message["role"] in ("user", "assistant"):
                            sources.append(message)
                else:
                    sources = [{"content": question, "id": source["source_message_id"]}]
                task_source = next((m["id"] for m in reversed(sources)
                                    if normalized_task(task) in normalized_task(m.get("content", ""))), None)
                if task_source is None:
                    raise ValueError("Omit task for a single-task reply; otherwise quote the original task without paraphrasing")
            if task:
                question = task
            key = (item["evidence_ref"], normalized_task(task))
            if key in seen:
                raise ValueError("Duplicate evidence/task in one assessment batch")
            seen.add(key)
            outcome, assistance = item["outcome"], item["assistance"]
            if outcome == "independent" and assistance != "none":
                raise ValueError("independent requires assistance=none")
            if outcome == "with_hints" and assistance not in ("hints", "solution"):
                raise ValueError("with_hints requires assistance=hints or solution")
            if not source.get("candidate") and ((source["answer"]["status"] == "skipped") != (outcome == "skipped")):
                raise ValueError("Skipped submissions require outcome=skipped")
            if not source.get("candidate"):
                self._check_commitment(source, outcome)
            previous = next((a for a in active if assessment_evidence(a) == item["evidence_ref"]
                             and normalized_task(a.get("task", "")) == normalized_task(task)), None)
            same_ref = [a for a in active if assessment_evidence(a) == item["evidence_ref"]]
            if previous is None and not task and len(same_ref) == 1:
                previous = same_ref[0]
                task = previous.get("task", "")
            content = {"outcome": outcome, "assistance": assistance, "feedback": item["feedback"]}
            if previous and all(previous.get(k) == v for k, v in content.items()):
                saved.append(previous["id"])
                continue
            if previous and not item.get("correction"):
                raise ValueError("Assessment already exists. Set correction=true to deliberately revise this same original attempt")
            identifier = "A" + hashlib.sha256(json.dumps([key, content, previous["id"] if previous else None], sort_keys=True).encode()).hexdigest()[:10]
            answer = copy.deepcopy(source["answer"])
            if source.get("candidate") and outcome == "skipped":
                answer["status"] = "skipped"
            data = {k: source[k] for k in ("source_message_id", "batch_id", "question_id", "topic_id")}
            data.update(id=identifier, evidence_ref=item["evidence_ref"], question=question, answer=answer,
                        task=task, used_hints=assistance in ("hints", "solution"), **content)
            if previous:
                data["supersedes"] = previous["id"]
            if task_source:
                data["task_source_message_id"] = task_source
            operations.append({"type": "learning_assessment", "data": data})
            saved.append(identifier)
        if ignored:
            operations.append({"type": "learning_evidence_ignored", "data": {"refs": list(dict.fromkeys(ignored))}})
        remaining = [ref for ref in pending(self.session) if ref not in {i["evidence_ref"] for i in items}]
        result: dict = {"saved": saved, "unassessed": remaining[-8:]}
        if ignored:
            result["ignored"] = ignored
            result["note"] = "These messages are requests or acknowledgements, not skipped exercises or assessed skill."
        return operations, result

    def _check_commitment(self, source, outcome):
        """A submitted form answer is judged against the key committed when the question was asked."""
        if source["answer"]["status"] == "dont_know":
            if outcome != "gap":
                raise ValueError("\"I don't know\" is a declared gap: use outcome=gap")
            return
        resolved = self.session.resolved_questions.get(source.get("batch_id"))
        if not resolved:
            return
        for question, verdict in zip(resolved["block"]["questions"], resolved["payload"]["formal_results"], strict=False):
            if question["id"] != source.get("question_id") or verdict["correct"] is None:
                continue
            if verdict["correct"] and outcome == "gap" or not verdict["correct"] and outcome in ("independent", "with_hints"):
                raise ValueError(
                    f"The key you committed marks this answer {'correct' if verdict['correct'] else 'incorrect'}; "
                    f"outcome={outcome} contradicts it. Keys are not revised after seeing the answer. "
                    "If the key itself was wrong, say so in feedback and use outcome=uncertain")

    async def _execute_legacy(self, call, update=None):
        name = call["name"]
        data = self.prepare(name, call.get("arguments", {}))
        if name in WEB_DEFINITIONS or name == "load_skill":
            try:
                if name not in self.enabled:
                    raise ValueError(f"Tool disabled: {name}")
                if self.session.pending_question:
                    raise ValueError("Resolve the open question first")
                if name == "load_skill":
                    if not self.skills_enabled:
                        raise ValueError("Skills are disabled in Settings")
                    validate_schema(SKILL_SCHEMA, data)
                    skill = self.skills.load(data["name"])
                    self.session.append("learning_skill", data={"name": skill["name"], "path": skill["path"],
                                                                "instructions": skill["instructions"]})
                    skill = skill | {"working_directory": str(self.cwd),
                                     "path_rule": "Learner material paths use working_directory; skill support files use base_directory."}
                    return {"content": json.dumps(skill, ensure_ascii=False)}
                validate_schema(WEB_DEFINITIONS[name][1], data)
                result = await (self.web.search(**data) if name == "web_search" else self.web.read(data["url"]))
                return {"content": json.dumps(result, ensure_ascii=False)}
            except Exception as exc:
                return {"content": self.web._error(exc), "error": True}
        if name not in DEFINITIONS:
            return await super().execute(call, update)
        try:
            validate_schema(DEFINITIONS[name][1], data)
            state = self.session.learning
            if state is None:
                raise ValueError("Not a learning session")
            if self.session.pending_question:
                raise ValueError("Resolve the open question first")
            if name == "ask_questions":
                raise ValueError("ask_questions must be handled as a pausing call by the agent loop")
            if any(e.get("source_call") == call["id"] for e in self.session.events):
                return {"content": "Already recorded"}
            if name == "set_learning_plan":
                ids = [s["id"] for s in data["steps"]]
                if len(set(ids)) != len(ids):
                    raise ValueError("Plan step IDs must be unique")
                kind = "learning_plan"
            elif name == "set_learning_phase":
                if data.get("current_step") and data["current_step"] not in {s["id"] for s in state.steps}:
                    raise ValueError("Unknown current_step")
                if data["phase"] in ("teaching", "practice") and not state.steps:
                    raise ValueError("Create a short plan first")
                kind = "learning_phase"
            elif name == "record_assessment" and not data.get("batch_id"):
                # Evidence from a plain-chat exchange; there is no form behind it.
                # A stray question_id (models copy it from the form variant of this tool) is meaningless here.
                data = {k: v for k, v in data.items() if k != "question_id"}
                # The chat itself knows what was asked and what the learner replied; the model may omit both.
                asked, replied, message_id, answers_the_agent, tail = chat_exchange(self.session)
                # What the learner said is a fact of the chat, never taken from the model's arguments.
                data = data | {"question": data.get("question") or asked or tail, "answer": replied}
                if not answers_the_agent:
                    raise ValueError("The learner has not answered anything of yours yet: their last message is not "
                                     "a reply to you. Record nothing now. Teach, then ask ONE check question and "
                                     "record only the answer they actually give")
                if is_acknowledgement(data["answer"]) and data["outcome"] in ("independent", "with_hints"):
                    raise ValueError("A bare 'yes/ok/understood' is not evidence of a skill. Do not record it; give a "
                                     "concrete task (predict an output, fix a line, explain in own words) instead")
                if not data["question"] or not isinstance(data["answer"], str) or not data["answer"]:
                    raise ValueError("Nothing to record: there is no learner reply to attach this evidence to")
                if data["used_hints"] and data["outcome"] == "independent":
                    raise ValueError("An answer with hints cannot be independent")
                if any(a["id"] == data["id"] for a in state.assessments):
                    raise ValueError("Assessment ID already exists; use supersedes for a correction")
                if data.get("supersedes") and not any(a["id"] == data["supersedes"] for a in state.assessments):
                    # Models fill this field out of habit (even with their own new id). Nothing to correct: ignore.
                    data = {k: v for k, v in data.items() if k != "supersedes"}
                data = {k: v for k, v in data.items() if k != "answer"} | {
                    "batch_id": "", "question_id": "", "topic_id": data.get("topic_id", ""),
                    "answer": {"status": "skipped" if data["outcome"] == "skipped" else "answered",
                               "text": data["answer"], "selected_option_ids": [], "reasoning": ""},
                    "source_message_id": message_id}
                kind = "learning_assessment"
            elif name == "record_assessment":
                resolved = self.session.resolved_questions.get(data["batch_id"])
                if not resolved or resolved["payload"]["status"] != "submitted":
                    raise ValueError("Assessment requires a submitted question block")
                question = next((q for q in resolved["block"]["questions"] if q["id"] == data["question_id"]), None)
                if question is None:
                    raise ValueError("Unknown question_id")
                answer = next(a for a in resolved["payload"]["answers"] if a["question_id"] == question["id"])
                if (answer["status"] == "skipped") != (data["outcome"] == "skipped"):
                    raise ValueError("A skipped answer must have the skipped outcome, and vice versa")
                if data["used_hints"] and data["outcome"] == "independent":
                    raise ValueError("An answer with hints cannot be independent")
                previous = next((a for a in state.assessments if a["id"] == data["id"]), None)
                if previous:
                    raise ValueError("Assessment ID already exists; use supersedes for a correction")
                if data.get("supersedes"):
                    target = next((a for a in state.assessments if a["id"] == data["supersedes"]), None)
                    if target is None:  # same habit as above: nothing to correct
                        data = {k: v for k, v in data.items() if k != "supersedes"}
                    elif (target["batch_id"], target["question_id"]) != (data["batch_id"], question["id"]):
                        raise ValueError("A correction must reference an assessment of the same answer")
                data = data | {"topic_id": question.get("topic_id", ""),
                               "question": question["prompt"], "answer": answer,
                               "source_message_id": resolved["message_id"]}
                kind = "learning_assessment"
            else:
                kind = "learning_finished"
            self.session.append(kind, data=data, source_call=call["id"])
            result = {"recorded": kind}
            # Small models tend to stop right after a bookkeeping call; the result says what must follow.
            if kind == "learning_plan":
                if state.phase in ("diagnosis", "planning"):
                    # The first plan always starts teaching; the model need not (and often forgets to) say so.
                    self.session.append("learning_phase", data={"phase": "teaching", "current_step": data["steps"][0]["id"]})
                result["next"] = "Plan saved, step 1 started. Now write its lesson in this turn."
            elif kind == "learning_phase" and data.get("phase") in ("teaching", "practice"):
                result["next"] = "Phase saved. Now write this step's lesson in this turn."
            return {"content": json.dumps(result, ensure_ascii=False)}
        except ValueError as exc:
            return {"content": str(exc), "error": True}
