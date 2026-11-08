import { Button, IconButton } from "./ui/index";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { t, useLanguage } from "../lib/i18n";
import { Tip } from "./Tip";

export function CopyButton({ text, label, variant = "text" }: { text: string; label: string; variant?: "text" | "outlined" | "icon" | "action" }) {
  useLanguage();
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    setState(await copyText(text) ? "copied" : "error");
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  const title = state === "copied" ? t("Скопировано") : state === "error" ? t("Не удалось скопировать") : label;
  const icon = state === "copied" ? "check" : state === "error" ? "error" : "content_copy";
  if (variant === "action") return <Tip label={title}><button type="button" className="msg-act" aria-label={title} onClick={() => void copy()}><md-icon aria-hidden="true">{icon}</md-icon></button></Tip>;
  if (variant === "icon") return <Tip label={title}><IconButton variant="ghost" type="button" aria-label={title} onClick={() => void copy()} className="copy-action"><md-icon aria-hidden="true">{icon}</md-icon></IconButton></Tip>;
  const content = <><md-icon slot="icon" aria-hidden="true">{icon}</md-icon>{state === "idle" ? t("Копировать") : title}</>;
  return variant === "outlined"
    ? <Button variant="secondary" type="button" aria-label={title} onClick={() => void copy()} className="copy-action">{content}</Button>
    : <Button variant="ghost" type="button" aria-label={title} onClick={() => void copy()} className="copy-action">{content}</Button>;
}
