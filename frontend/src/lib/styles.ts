/** Stable backend IDs; instruction text lives in backend/graphy/prompts/style-*.md. */
export const EXPLANATION_STYLES = [
  { id: "structured_reference", label: "Объяснение", hint: "Понятное объяснение с примерами и обоснованием" },
  { id: "socratic", label: "Сократический диалог", hint: "Вопросы, которые подводят к выводу самому" },
] as const;
export type ExplanationStyle = (typeof EXPLANATION_STYLES)[number]["id"];

export const EXPLANATION_DEPTHS = [
  { id: "adaptive", label: "По ситуации" },
  { id: "brief", label: "Кратко" },
  { id: "detailed", label: "Подробно" },
] as const;
export const EXPLANATION_PRESENTATIONS = [
  { id: "adaptive", label: "По ситуации" },
  { id: "prose", label: "Связный текст" },
  { id: "structured", label: "Разделы и списки" },
] as const;
export type ExplanationDepth = (typeof EXPLANATION_DEPTHS)[number]["id"];
export type ExplanationPresentation = (typeof EXPLANATION_PRESENTATIONS)[number]["id"];
