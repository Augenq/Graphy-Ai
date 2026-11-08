import type { ReactNode, SVGProps } from "react";

/**
 * Graphy's own small icon family, drawn on a 24px grid.
 * One system: a thin outline (1.6), a body washed with currentColor at 16% opacity so the silhouette reads at 20px,
 * and one small dense detail (solid currentColor) that tells what the icon is about.
 * They only use currentColor: the row around them decides the tone (muted at rest, ink when selected).
 */
type Props = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function Base({ size = 20, children, className, ...rest }: Props & { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" className={`graphy-icon${className ? ` ${className}` : ""}`} {...rest}>{children}</svg>;
}
const wash = { fill: "currentColor", fillOpacity: 0.16 } as const;
const solid = { fill: "currentColor", stroke: "none" } as const;

/** «Учиться»: an open book; two pages, a spine and a few lines of text on the left page. */
export function IconLearn(props: Props) {
  return <Base {...props}>
    <path d="M12 6.6C10.2 5.3 7.5 4.7 3.9 5v12.1c3.6-.3 6.3.2 8.1 1.5 1.8-1.3 4.5-1.8 8.1-1.5V5c-3.6-.3-6.3.3-8.1 1.6z" {...wash} />
    <path d="M12 6.6v12" />
    <path d="M6.9 9.1h2.4M6.9 11.9h2.4" strokeWidth={1.4} />
    <circle cx="15.6" cy="10.3" r="1.2" {...solid} />
  </Base>;
}

/** «Проверить себя»: a sheet with answers: two ticked rows and one still open. */
export function IconCheck(props: Props) {
  return <Base {...props}>
    <rect x="4.5" y="3" width="15" height="18" rx="2.5" {...wash} />
    <path d="M7.8 8.1l1.15 1.15 2.1-2.3M7.8 13.1l1.15 1.15 2.1-2.3" />
    <path d="M13.6 8.2h2.8M13.6 13.2h2.8" strokeWidth={1.4} />
    <circle cx="9.4" cy="17.2" r="1.2" {...solid} />
    <path d="M13.6 17.2h2.8" strokeWidth={1.4} />
  </Base>;
}

// edge between two nodes, stopping at their outlines
const edge = (a: readonly [number, number], b: readonly [number, number], ra: number, rb: number) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  const [ux, uy] = [dx / len, dy / len];
  const f = (n: number) => n.toFixed(2);
  return `M${f(a[0] + ux * ra)} ${f(a[1] + uy * ra)}L${f(b[0] - ux * rb)} ${f(b[1] - uy * rb)}`;
};
const NODES = { hub: [11.6, 12.6], a: [5.4, 7.2], b: [18.4, 8], c: [13, 19.4] } as const;

/** The knowledge map: topics as nodes, linked to each other; the dense one is the topic the learner is on. */
export function IconMap(props: Props) {
  const { hub, a, b, c } = NODES;
  return <Base {...props}>
    <path d={`${edge(hub, a, 1.9, 2.4)}${edge(hub, b, 1.9, 2.4)}${edge(hub, c, 1.9, 2.4)}${edge(a, b, 2.4, 2.4)}`} />
    <circle cx={a[0]} cy={a[1]} r="2.4" {...wash} />
    <circle cx={b[0]} cy={b[1]} r="2.4" {...wash} />
    <circle cx={c[0]} cy={c[1]} r="2.4" {...wash} />
    <circle cx={hub[0]} cy={hub[1]} r="1.9" {...solid} />
  </Base>;
}

/** Model: a small chip; the dot is the core. */
export function IconModel(props: Props) {
  return <Base {...props}>
    <rect x="5" y="5" width="14" height="14" rx="3.2" {...wash} />
    <path d="M9 2.8v2.2M15 2.8v2.2M9 19v2.2M15 19v2.2M2.8 9h2.2M2.8 15h2.2M19 9h2.2M19 15h2.2" strokeWidth={1.4} />
    <circle cx="12" cy="12" r="2" {...solid} />
  </Base>;
}

export function IconMaterials(props: Props) {
  return <Base {...props}>
    <path d="M6 3h8l4 4v12.5A1.5 1.5 0 0 1 16.5 21h-10A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z" {...wash} />
    <path d="M14 3v4h4" />
    <path d="M8.5 11.5h7M8.5 14.5h7M8.5 17.5h4" strokeWidth={1.4} />
  </Base>;
}

/** «Обычный» режим: средний уровень — три ступени. */
export function IconQualityBalanced(props: Props) {
  return <Base {...props}>
    <rect x="4.5" y="13.5" width="4" height="6" rx="1.4" {...wash} />
    <rect x="4.5" y="13.5" width="4" height="6" rx="1.4" />
    <rect x="10" y="9.5" width="4" height="10" rx="1.4" {...wash} />
    <rect x="10" y="9.5" width="4" height="10" rx="1.4" />
    <rect x="15.5" y="5.5" width="4" height="14" rx="1.4" {...wash} />
    <rect x="15.5" y="5.5" width="4" height="14" rx="1.4" />
  </Base>;
}

export const MODE_ICON = { explain: IconLearn, check: IconCheck, materials: IconMaterials } as const;
