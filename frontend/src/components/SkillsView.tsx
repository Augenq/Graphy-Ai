import { useCallback, useEffect, useState } from "react";
import { Avatar, Spinner } from "@maxhub/max-ui";
import { Button } from "./ui/index";
import { describe } from "../lib/api";
import { t } from "../lib/i18n";
import { listProjectSkills } from "../lib/skills-api";

type ProjectSkill = { name: string; description: string; path: string };

export function SkillsView({ onOpenLesson: _onOpenLesson }: { onOpenLesson: (id: string) => void }) {
  const [skills, setSkills] = useState<ProjectSkill[] | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await listProjectSkills();
      setSkills(result.skills);
      setWarnings(result.warnings);
    } catch (e) { setError(describe(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <section className="skills-view" aria-label={t("Навыки")} data-skills-view>
    <header className="skills-head">
      <p className="skills-sub">{t("Навыки из .graphy/skills подключаются, когда они нужны")}</p>
    </header>
    <div className="skills-scroll scroll-y">
      {error && <div className="skills-error" role="alert"><span>{error}</span><Button variant="ghost" onClick={() => void load()}>{t("Повторить")}</Button></div>}
      {warnings.length > 0 && <div className="skills-error" role="status">{warnings.join("\n")}</div>}
      {skills === null && !error && <div className="skills-loading" role="status"><Spinner size={20} aria-hidden="true" />{t("Загрузка навыков")}</div>}
      {skills?.length === 0 && <div className="skills-empty" data-empty>
        <h2 className="skills-empty-title">{t("Навыков пока нет")}</h2>
        <p className="skills-empty-text">{t("Добавьте папку с файлом SKILL.md в .graphy/skills.")}</p>
      </div>}
      {!!skills?.length && <div className="skills-grid" role="list" aria-label={t("Список навыков")}>
        {skills.map((skill) => <article className="skill-card" role="listitem" data-skill={skill.name} key={skill.path}>
          <div className="skill-card-head">
            <Avatar.Container size={40} form="squircle" className="skill-mono" aria-hidden="true"><Avatar.Text gradient="blue">{(skill.name.match(/[a-zа-я0-9]/i)?.[0] ?? "?").toUpperCase()}</Avatar.Text></Avatar.Container>
            <h2 className="skill-name">{skill.name}</h2>
          </div>
          <p className="skill-desc">{skill.description}</p>
        </article>)}
      </div>}
    </div>
  </section>;
}
