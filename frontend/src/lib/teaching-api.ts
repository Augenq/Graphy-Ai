/** Client of the teacher / student role (a local setting kept by the backend). */
import { useSyncExternalStore } from "react";
import { get, put } from "./api";

// ---- role (a local setting kept by the backend) ----
let teacher = false;
const listeners = new Set<() => void>();
export const setTeacherLocal = (value: boolean) => { teacher = value; listeners.forEach((l) => l()); };
export const useTeacherMode = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => teacher);
export const refreshRole = () => get<{ teacher: boolean }>("/teaching/role").then((r) => setTeacherLocal(r.teacher), () => undefined);
export const setTeacherMode = async (on: boolean) => { setTeacherLocal((await put<{ teacher: boolean }>("/teaching/role", { teacher: on })).teacher); };
