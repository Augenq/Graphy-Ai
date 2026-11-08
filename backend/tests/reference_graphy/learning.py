"""Small event-folded lesson state; explanation is not proof of understanding."""

import copy
from dataclasses import dataclass, field

from .evidence import active_assessments

PHASES = ["diagnosis", "planning", "teaching", "practice", "review"]
PHASE_LABELS = dict(zip(PHASES, ["Диагностика", "Планирование", "Обучение", "Практика", "Итог"], strict=True))


@dataclass
class LearningState:
    goal: str = ""
    phase: str = "diagnosis"
    steps: list[dict] = field(default_factory=list)
    current_step: str = ""
    assessments: list[dict] = field(default_factory=list)
    summary: str = ""
    next_step: str = ""
    finished: bool = False
    skills: list[dict] = field(default_factory=list)
    plan_version: int = 0
    ignored_evidence: list[str] = field(default_factory=list)

    def apply(self, event):
        data = event.get("data", {})
        match event["type"]:
            case "learning_goal" | "learning_sources" | "learning_source_notes":
                pass  # legacy events of removed features: raw first message as goal, source search results
            case "learning_plan":
                self.plan_version += 1
                self.goal = data.get("goal") or self.goal
                self.steps = copy.deepcopy(data["steps"])
                if self.current_step not in {s["id"] for s in self.steps}:
                    self.current_step = ""
            case "learning_phase":
                self.phase, self.current_step = data["phase"], data.get("current_step", "")
                self.finished = False
            case "learning_assessment":
                previous = next((a for a in self.assessments if a["id"] == data["id"]), None)
                if previous is None:
                    self.assessments.append(copy.deepcopy(data))
            case "learning_evidence_ignored":
                self.ignored_evidence.extend(ref for ref in data["refs"] if ref not in self.ignored_evidence)
            case "learning_finished":
                self.summary, self.next_step = data["summary"], data["next_step"]
                self.phase, self.finished = "review", True
            case "learning_skill":
                previous = next((s for s in self.skills if s["name"] == data["name"]), None)
                if previous:
                    previous.update(copy.deepcopy(data))
                else:
                    self.skills.append(copy.deepcopy(data))

    def context(self):
        # Full learner answers remain in the transcript. Don't duplicate them in
        # the operational prompt, especially for long multi-step submissions.
        observations = [{k: a[k] for k in ("id", "evidence_ref", "topic_id", "outcome", "assistance") if k in a}
                        | {"feedback": a["feedback"][:300]} for a in active_assessments(self.assessments)[-6:]]
        values = {"goal": self.goal, "phase": self.phase, "plan_version": self.plan_version,
                  "plan": [s["title"] for s in self.steps],
                  "step": next((i for i, s in enumerate(self.steps, 1) if s["id"] == self.current_step), None),
                  "observations": observations, "summary": self.summary, "next_step": self.next_step,
                  "finished": self.finished, "loaded_skills": [s["name"] for s in self.skills]}
        return {key: value for key, value in values.items() if value not in ("", None, [], False)}
