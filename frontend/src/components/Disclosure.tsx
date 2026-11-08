import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { prefersReducedMotion } from "../lib/motion-pref";

/** Keep content mounted through closing; measure its natural height without a fixed limit. */
export function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = useReducedMotion() || prefersReducedMotion();
  return <AnimatePresence initial={false}>
    {open && <motion.div
      key="content"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      style={{ overflow: "hidden" }}
    >{children}</motion.div>}
  </AnimatePresence>;
}
