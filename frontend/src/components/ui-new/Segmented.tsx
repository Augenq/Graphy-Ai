import { Segmented as MaxSegmented } from '@maxhub/max-ui';
import { useLayoutEffect, useRef } from 'react';

/** MAX UI Segmented with a named tablist (the MAX component takes no aria-label itself). */
export function Segmented<T extends string>({ items, value, onChange, label, className = '' }: {
  items: { id: T; title: string }[]; value: T; onChange: (id: T) => void; label: string; className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { root.current?.querySelector('[role="tablist"]')?.setAttribute('aria-label', label); });
  return <div ref={root} className={`ui-segmented ${className}`}>
    <MaxSegmented items={items} activeItem={value} onClick={id => onChange(id as T)} innerClassNames={{ list: 'ui-segmented-list', item: 'ui-segmented-item' }} />
  </div>;
}
