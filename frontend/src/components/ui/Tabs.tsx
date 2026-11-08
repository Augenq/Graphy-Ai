import { Tabs as MaxTabs } from '@maxhub/max-ui';
import { Children, isValidElement, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

type TabProps = { children: ReactNode; active?: boolean; id?: string; 'aria-controls'?: string };
/** Screen-facing composition; the MAX component receives its documented items API. */
export function Tab(_props: TabProps) { return null; }
function labelOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? labelOf(child.props.children) : String(child)).join('');
}
function counterOf(node: ReactNode): number | undefined {
  const span = Children.toArray(node).find(child => isValidElement<{ className?: string }>(child) && child.props.className === 'skills-count');
  return isValidElement<{ children?: ReactNode }>(span) ? Number(span.props.children) : undefined;
}
export function Tabs({ children, selectedIndex, onSelect, className = '', ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> & {
  selectedIndex: number; onSelect: (index: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const tabs = Children.toArray(children).filter(isValidElement<TabProps>);
  useLayoutEffect(() => {
    const list = root.current?.querySelector('[role="tablist"]');
    if (props['aria-label']) list?.setAttribute('aria-label', props['aria-label']);
    root.current?.querySelectorAll('[role="tab"]').forEach((el, index) => {
      const tab = tabs[index];
      if (tab?.props.id) el.id = tab.props.id;
      if (tab?.props['aria-controls']) el.setAttribute('aria-controls', tab.props['aria-controls']);
    });
  });
  return <div ref={root} {...props} className={`ui-tabs ${className}`}>
    <MaxTabs items={tabs.map((tab, index) => ({ id: String(index),
      title: labelOf(Children.toArray(tab.props.children).filter(child => !isValidElement<{ className?: string }>(child) || child.props.className !== 'skills-count')),
      indicator: counterOf(tab.props.children) }))}
      activeItem={String(selectedIndex)} onClick={id => onSelect(Number(id))} innerClassNames={{ list: 'ui-tab-list', item: 'ui-tab', indicator: 'ui-tab-counter' }} />
  </div>;
}
