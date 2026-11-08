import { useId } from "react";
import { useLogoChoice, type LogoShape } from "../lib/logo-choice";

const LOGO_GRADIENT = [
  ["0%", "#111DCD"],
  ["45%", "#5719CE"],
  ["100%", "#B014CC"],
] as const;

function LogoDefs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0%" y1="100%" x2="100%" y2="0%" gradientUnits="objectBoundingBox">
        {LOGO_GRADIENT.map(([offset, stopColor]) => <stop key={offset} offset={offset} stopColor={stopColor} />)}
      </linearGradient>
    </defs>
  );
}

/** One logo drawn with the brand gradient: a traced shape, or the clean ROUTE (logo 16: an open round route with a tail at the lower right) when `shape` is null. */
export function MarkGlyph({ shape, size = 24, className, title }: { shape: LogoShape | null; size?: number; className?: string; title?: string }) {
  const gid = `graphy-logo-gradient-${useId().replace(/:/g, "")}`;
  const paint = `url(#${gid})`;
  const common = {
    width: size, height: size, className: `graphy-mark${className ? ` ${className}` : ""}`,
    role: title ? "img" : undefined, "aria-label": title, "aria-hidden": title ? undefined : true, focusable: "false",
  } as const;
  if (shape) return (
    <svg viewBox={shape.viewBox} fill={paint} {...common}>
      <LogoDefs id={gid} />
      <g transform={shape.transform}><path d={shape.d} /></g>
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={paint} strokeWidth={2.196} strokeLinecap="round" {...common}>
      <LogoDefs id={gid} />
      <path d="M18.52 3.75A9.341 9.341 0 1 0 20.644 6.899M21.341 10.439V22.902" />
    </svg>
  );
}

/** The Graphy mark (logo ATLAS, fixed). */
export function GraphyMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return <MarkGlyph shape={useLogoChoice()} size={size} className={className} title={title} />;
}
