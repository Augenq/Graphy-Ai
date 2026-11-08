import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UIProvider } from './ui/controls';
import { isImeKey } from '../lib/ime';

const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"], md-switch, md-radio, md-checkbox, md-list-item[type="button"]';
let modalCount = 0;
let previousInert = false;

/** Portals share the body with MAX menus. Modal focus includes their floating panels. */
export function Modal({ label, onClose, children, className = '', top, size = 'standard' }: {
  label: string; onClose: () => void; children: ReactNode; className?: string;
  top?: boolean; size?: 'standard' | 'settings' | 'search' | 'visual';
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  const searchKind = useRef(size === 'search');
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const app = document.getElementById('root');
    if (modalCount++ === 0 && app) { previousInert = app.inert; app.inert = true; }
    const isTop = () => [...document.querySelectorAll('[data-ui-dialog]')].at(-1) === el;
    const controls = () => [...el.querySelectorAll<HTMLElement>(focusable), ...document.querySelectorAll<HTMLElement>('.ui-menu-content button:not(:disabled), .ui-menu-content input, .ui-menu-content [tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert]'));
    const firstFocus = () => (el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? controls()[0] ?? el).focus({ preventScroll: true });
    firstFocus();
    const key = (event: KeyboardEvent) => {
      if (!isTop()) return;
      const menuOpen = document.querySelector('.ui-menu-content');
      if (event.key === 'Escape' && isImeKey(event)) { event.preventDefault(); return; }
      if (event.key === 'Escape' && (event.target as Element | null)?.closest?.('[data-keeps-escape]')) return; // an open tooltip/toast inside owns this Escape
      if (event.key === 'Escape' && !menuOpen) {
        event.preventDefault(); event.stopImmediatePropagation(); closeHandler.current();
      } else if (event.key === 'Tab' && !menuOpen) {
        const nodes = controls();
        if (!nodes.length) { event.preventDefault(); el.focus(); }
        else if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === el)) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
      }
    };
    const focus = (event: FocusEvent) => {
      if (!isTop() || !(event.target instanceof Element)) return;
      if (!el.contains(event.target) && !event.target.closest('.ui-menu-content')) firstFocus();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('focusin', focus);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('focusin', focus);
      if (--modalCount === 0 && app) app.inert = previousInert;
      // the dimming outlives the dialog for one 150ms fade (a bare overlay: the card's DOM is gone, so nothing duplicates ids/roles)
      // only when no other dialog stays open (it would be painted over), and not for the palette, whose backdrop has no 150ms exit in Cursor
      if (modalCount === 0 && !searchKind.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const ghost = document.createElement('div');
        ghost.className = 'ui-dialog-ghost'; ghost.setAttribute('aria-hidden', 'true');
        document.body.append(ghost);
        setTimeout(() => ghost.remove(), 200);
      }
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<UIProvider><div className="ui-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) closeHandler.current(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-ui-dialog
      className={`graphy-dialog ui-dialog dialog-${size} ${top ? 'dialog-top' : ''}`}>
      <div className={`graphy-dialog-content ${className}`}>{children}</div>
    </div>
  </div></UIProvider>, document.body);
}
