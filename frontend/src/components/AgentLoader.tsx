/** Animated agent/network loader: orbiting rings, pulsing links, traveling signals, breathing core. No logo. */
// Remembers that a boot/sign-in gate was already on screen, so the next gate does not replay its fade-in (that read as a blink).
let gateSeen = typeof document !== "undefined" && !!document.querySelector(".boot"); // the static boot screen in index.html counts
export const gateWasSeen = () => gateSeen;
export const markGateSeen = () => { gateSeen = true; };

export function AgentLoader({ size = 168, label }: { size?: number; label?: string }) {
  const C = 90;
  const outer = [
    [90, 24], [148, 58], [148, 118], [90, 156], [32, 118], [32, 58],
  ] as const;
  const links: [number, number, number][] = [
    [90,24,.0],[148,58,.2],[148,118,.4],[90,156,.6],[32,118,.8],[32,58,1],
    [90,24,.3],[148,58,.5],[148,118,.7],[90,156,.9],[32,118,1.1],[32,58,1.3],
  ];
  // each "to core" link uses first 6, each ring link uses last 6 with from/to coords
  const coreLinks = outer.map(([x,y],i) => ({ x1:C, y1:C, x2:x, y2:y, d:i*0.18 }));
  const ringLinks = outer.map(([x,y],i) => {
    const n = outer[(i+1)%outer.length];
    return { x1:x, y1:y, x2:n[0], y2:n[1], d:i*0.18+0.25 };
  });
  const travel = [
    { tx: 0, ty: -66, dur: 2.6, delay: 0 },
    { tx: 58, ty: 28, dur: 3.1, delay: .86 },
    { tx: -58, ty: 28, dur: 2.8, delay: 1.72 },
  ];
  return (
    <div className="agent-loader" style={{ width: size, height: size }} role={label ? "status" : "img"} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg className="agent-loader-svg" viewBox="0 0 180 180" aria-hidden="true">
        <circle cx={C} cy={C} r="72" className="al-orb" />
        <circle cx={C} cy={C} r="72" className="al-orb al-orb-a" />
        <ellipse cx={C} cy={C} rx="48" ry="72" className="al-orb al-orb-b" />
        {[0, .93, 1.86].map((d,i) => <circle key={i} cx={C} cy={C} r="10" className="al-wave" style={{ animationDelay: `${d}s` }} />)}
        {[...coreLinks, ...ringLinks].map((l,i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="al-link" style={{ animationDelay: `${l.d}s` }} />
        ))}
        {travel.map((t,i) => (
          <circle key={i} cx={C} cy={C} r="2.6" className="al-trav"
            style={{ ["--tx" as any]: `${t.tx}px`, ["--ty" as any]: `${t.ty}px`, animationDuration: `${t.dur}s`, animationDelay: `${t.delay}s` }} />
        ))}
        {outer.map(([x,y],i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={i%2?8:8.8} className="al-halo" style={{ animationDelay: `${i*0.18}s` }} />
            <circle cx={x} cy={y} r={i%2?3.8:4.2} className="al-node" style={{ animationDelay: `${i*0.18}s` }} />
          </g>
        ))}
        <circle cx={C} cy={C} r="13" className="al-core-ring" />
        <circle cx={C} cy={C} r="7.5" className="al-core" />
      </svg>
    </div>
  );
}
