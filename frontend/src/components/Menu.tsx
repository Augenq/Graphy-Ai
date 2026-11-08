import { ContextMenu, Select as MaxSelect } from '@maxhub/max-ui';
import { Check, SlidersHorizontal } from '@phosphor-icons/react';
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { t } from '../lib/i18n';

export interface MenuItem { id: string; label: ReactNode; icon?: ReactNode; hint?: string; checked?: boolean; disabled?: boolean; }
type ContentApi = { query: string; close: () => void };
interface Props {
  label: string; items: MenuItem[]; onSelect: (id: string) => void;
  /** `auto` opens below the trigger and flips upward when there is more room above (and not enough below) */
  side?: 'top' | 'bottom' | 'auto'; align?: 'start' | 'end'; width?: number; maxHeight?: string; className?: string;
  searchPlaceholder?: string; heading?: string; title?: string; content?: ReactNode | ((api: ContentApi) => ReactNode); fitViewport?: boolean;
  /** rows of 52-60px: icon, title, a description that wraps, a mark for the chosen one */
  rich?: boolean;
  /** titles of the rows wrap to two lines instead of being cut (long names) */
  wrap?: boolean;
  /** custom panel: what the closed control shows (default: the «tune» icon) */
  valueLabel?: ReactNode;
  /** custom panel: the combobox name */
  fieldLabel?: string;
  /** custom panel: how much room the panel needs, to choose the side in `auto` */
  approxHeight?: number;
  trigger: (p: { id: string; onClick: () => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; 'aria-controls'?: string }) => ReactNode;
}

/** Action menus use ContextMenu; searchable/custom panels use MAX Select's documented API. */
export function Menu({ label, items, onSelect, side = 'bottom', align = 'start', width = 240, maxHeight, className = '', searchPlaceholder, heading, title, content, trigger, fitViewport = false, rich = false, wrap = false, valueLabel, fieldLabel, approxHeight }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<'top' | 'bottom'>(side === 'top' ? 'top' : 'bottom');
  const anchor = useRef<HTMLSpanElement>(null);
  const [availableHeight, setAvailableHeight] = useState<number>();
  const fit = fitViewport || rich || side === 'auto';
  // `auto`: choose the side when the menu opens, from the room the trigger has above and below it
  const choose = () => {
    if (side !== 'auto') return setResolved(side);
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const need = approxHeight ?? (content ? 320 : Math.min(360, items.length * (rich ? 58 : 34) + 16 + (heading ? 28 : 0)));
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    setResolved(below >= need || below >= above ? 'bottom' : 'top');
  };
  useLayoutEffect(() => {
    if (!open || !fit) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setAvailableHeight(Math.max(0, (resolved === 'top' ? rect.top : window.innerHeight - rect.bottom) - 20));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new ResizeObserver(update);
    if (anchor.current) observer.observe(anchor.current);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); observer.disconnect(); };
  }, [open, fit, resolved]);
  const onOpenChange = (next: boolean) => { if (next) choose(); setOpen(next); };
  const placement = `${resolved}-${align}` as const;
  const popupClass = `ui-popup-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const contentClass = `ui-menu-content ${popupClass}${rich ? ' ui-menu-rich' : ''}${wrap ? ' ui-menu-wrap' : ''}`;
  const style = { '--ui-menu-width': `${width}px` } as CSSProperties;
  const popupStyle = <style>{`.${popupClass}{min-width:min(${width}px,calc(100vw - 24px));max-height:${fit && availableHeight !== undefined ? `${availableHeight}px` : maxHeight ?? 'min(360px, 60vh)'};--ui-menu-available:${fit && availableHeight !== undefined ? `${availableHeight}px` : '60dvh'};}`}</style>;
  if (searchPlaceholder || content) return <span ref={anchor} className={`ui-menu-anchor relative inline-flex ${className}`} style={style}>
    {popupStyle}<MaxSelect options={valueLabel ? [{ value: '__value', label: valueLabel }] : items.map(item => ({ value: item.id, label: item.label, before: item.icon, disabled: item.disabled, hint: item.hint }))}
      value={valueLabel ? '__value' : items.find(item => item.checked)?.id ?? ''} onValueChange={value => { if (!valueLabel) onSelect(value); }} placeholder={content ? ' ' : label} iconBefore={content && !valueLabel ? <SlidersHorizontal aria-hidden="true" className="size-5" /> : undefined}
      open={open} onOpenChange={onOpenChange} placement={placement} dropdownWidth="auto" searchable={!!searchPlaceholder} searchPlaceholder={searchPlaceholder}
      aria-label={fieldLabel ?? label} size="medium" customDropdownMenu={content}
      innerClassNames={{ container: `ui-select ${content && !valueLabel ? 'ui-options-select' : 'ui-toolbar-select'}`, field: 'ui-select-field', content: contentClass, list: 'ui-menu-list', option: 'ui-menu-option', search: 'ui-menu-search', chevron: content && !valueLabel ? 'ui-options-chevron' : 'ui-select-chevron', value: content && !valueLabel ? 'ui-options-value' : 'ui-select-value' }} />
  </span>;
  return <span ref={anchor} className={`ui-menu-anchor relative inline-flex ${className}`} style={style}>
    {popupStyle}<ContextMenu asChild items={[...(heading ? [{ id: "menu-heading", label: <span className="ui-menu-heading" role="heading" aria-level={3}>{heading}</span>, disabled: true }] : []), ...items.map(item => ({ id: item.id, label: <span className="ui-menu-copy"><span className="ui-menu-title">{item.label}{item.checked && <span className="sr-only">{`, ${t('выбрано')}`}</span>}</span>{item.hint && !/^(Ctrl|Alt|Shift|⌘)/.test(item.hint) && <span className="ui-menu-description">{item.hint}</span>}</span>, before: item.icon, hint: item.checked ? <Check aria-hidden="true" className="ui-menu-check" weight="bold" /> : item.hint && /^(Ctrl|Alt|Shift|⌘)/.test(item.hint) ? item.hint : undefined, disabled: item.disabled, onClick: () => onSelect(item.id) }))]}
      placement={placement} open={open} onOpenChange={onOpenChange}
      innerClassNames={{ content: contentClass, row: 'ui-menu-option', label: 'ui-menu-label' }}>
      {trigger({ id, onClick: () => {}, 'aria-haspopup': 'menu', 'aria-expanded': open })}
    </ContextMenu>
    {title && <span className="sr-only">{title}</span>}
  </span>;
}
