"""Local course metadata and rebuildable progress, derived from session evidence."""

import json
import re
import time
import uuid

from .session import session_folder
from .storage import read_json, write_json


class Courses:
    def __init__(self, root):
        self.root = root
        self.folder = root / "learning" / "courses"

    def list(self):
        rows = []
        for path in self.folder.glob("*/course.json"):
            try:
                row = read_json(path, {})
            except ValueError:
                continue  # one damaged course must not hide all the others
            if row.get("id") == path.parent.name and isinstance(row.get("name"), str):
                rows.append(row)
        return sorted(rows, key=lambda row: row.get("created", 0))

    def get(self, course_id):
        folder = session_folder(self.root, self.root, course_id).parent
        data = read_json(folder / "course.json", {})
        if not data or data.get("id") != course_id:
            raise ValueError("Unknown course")
        return data

    @staticmethod
    def _name(name):
        name = " ".join(name.split())
        if not name or len(name) > 200:
            raise ValueError("Course name must contain 1–200 characters")
        return name

    def rename(self, course_id, name):
        row = self.get(course_id) | {"name": self._name(name)}
        write_json(self.folder / course_id / "course.json", row)
        return row

    def create(self, name):
        name = self._name(name)
        row = {"id": uuid.uuid4().hex, "name": name, "created": time.time()}
        write_json(self.folder / row["id"] / "course.json", row)
        return row

    def progress(self, course_id):
        folder = session_folder(self.root, self.root, course_id)
        paths = sorted(folder.glob("*.jsonl"))
        stamp = [[p.name, p.stat().st_mtime_ns, p.stat().st_size] for p in paths]
        cache_path = folder.parent / "progress.json"
        try:
            cached = read_json(cache_path, {})
        except ValueError:
            cached = {}
        if (cached.get("version") == 2 and cached.get("stamp") == stamp
                and isinstance(cached.get("observations"), list) and isinstance(cached.get("lessons"), list)):
            return cached
        observations, lessons = [], []
        for path in paths:
            source = ""
            goal = ""
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line)
                    kind = event["type"]
                    if kind == "header":
                        source = event["id"]
                    elif kind == "learning_plan":
                        goal = event["data"].get("goal") or goal
                    elif kind == "learning_transaction":
                        for operation in event["operations"]:
                            if operation["type"] == "learning_assessment":
                                observations.append(operation["data"] | {"session_id": source, "path": str(path),
                                                                         "time": event.get("time", 0)})
                            elif operation["type"] == "learning_plan":
                                goal = operation["data"].get("goal") or goal
                            elif operation["type"] == "learning_finished":
                                lessons.append(operation["data"] | {"session_id": source, "goal": goal,
                                                                    "time": event.get("time", 0)})
                    elif kind == "learning_assessment":
                        observations.append(event["data"] | {"session_id": source, "path": str(path),
                                                              "time": event.get("time", 0)})
                    elif kind == "learning_finished":
                        lessons.append(event["data"] | {"session_id": source, "goal": goal,
                                                        "time": event.get("time", 0)})
                except (ValueError, TypeError, KeyError):
                    continue
        result = {"version": 2, "stamp": stamp, "observations": observations, "lessons": lessons}
        write_json(cache_path, result)
        return result

    def memory(self, course_id, query, budget=6000, *, exclude_session=None):
        progress = self.progress(course_id)
        words = set(re.findall(r"\w{3,}", query.casefold()))
        replaced = {(o["session_id"], o["supersedes"]) for o in progress["observations"] if o.get("supersedes")}
        ranked = []
        for o in progress["observations"]:
            if o.get("session_id") == exclude_session:
                continue
            if (o["session_id"], o["id"]) in replaced:
                continue
            text = f"{o.get('topic_id', '')} {o.get('question', '')} {o.get('feedback', '')}"
            score = len(words & set(re.findall(r"\w{3,}", text.casefold())))
            if score:
                ranked.append((score, o.get("time", 0), o))
        rows, size = [], 0
        for lesson in sorted(progress["lessons"], key=lambda row: row["time"], reverse=True):
            if lesson.get("session_id") == exclude_session:
                continue
            words_in_lesson = set(re.findall(r"\w{3,}", json.dumps(lesson, ensure_ascii=False).casefold()))
            if words & words_in_lesson:
                encoded = json.dumps(lesson, ensure_ascii=False)
                if len(encoded) <= budget // 3:
                    rows.append(lesson)
                    size += len(encoded)
                    break
        for _, _, observation in sorted(ranked, key=lambda item: item[:2], reverse=True):
            row = {k: observation[k] for k in ("session_id", "source_message_id", "topic_id", "question",
                                              "outcome", "feedback", "used_hints") if k in observation}
            encoded = json.dumps(row, ensure_ascii=False)
            if size + len(encoded) > budget:
                continue
            rows.append(row)
            size += len(encoded)
        return rows
