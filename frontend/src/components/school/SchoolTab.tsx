import { t } from "../../lib/i18n";
import { useMax } from "../../lib/max";
import { TeacherSchool } from "./TeacherSchool";
import { StudentSchool } from "./StudentSchool";

/** The «Школа» tab: the teacher's workspace for teachers, assigned work for students. Hidden by the shell when there is no hub. */
export function SchoolTab() {
  const role = useMax().user?.role;
  return <section className="school-tab" aria-label={t("Школа")} data-school-tab>
    <div className="school-scroll scroll-y">{role === "teacher" ? <TeacherSchool /> : role === "student" ? <StudentSchool /> : null}</div>
  </section>;
}
