import { X } from '@phosphor-icons/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { IconButton } from './controls';

export function ChipSet({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="group" className={`ui-chip-set ${className}`} />;
}

type ChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'onClick'> & {
  label: string; selected?: boolean; onClick?: () => void; onRemove?: () => void; removeLabel?: string; children?: ReactNode;
};
export function Chip({ label, selected, onClick, onRemove, removeLabel, children, className = '', ...props }: ChipProps) {
  if (onRemove) return <span {...props} className={`ui-chip ${className}`}>
    {children}<span className="ui-chip-label">{label}</span>
    <IconButton aria-label={removeLabel} onClick={onRemove} className="ui-chip-remove"><X aria-hidden="true" /></IconButton>
  </span>;
  return <button {...props} type="button" aria-pressed={selected} onClick={onClick} className={`ui-chip ${className}`}>
    {children}<span className="ui-chip-label">{label}</span>
  </button>;
}
