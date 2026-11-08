import { Spinner } from '@maxhub/max-ui';
import type { HTMLAttributes } from 'react';

type Props = HTMLAttributes<HTMLSpanElement> & { value?: number; indeterminate?: boolean; circular?: boolean; size?: number };
export function Progress({ value = 0, indeterminate, circular, size = 20, className = '', style, ...props }: Props) {
  const ratio = Math.min(1, Math.max(0, value));
  const accessible = { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': indeterminate ? undefined : Math.round(ratio * 100) };
  if (circular && indeterminate) return <span {...props} {...accessible} className={`ui-progress ui-progress-spinner ${className}`} style={{ width: size, height: size, minWidth: size, ...style }}><Spinner size={size} /></span>;
  return <span {...props} {...accessible} className={`ui-progress ${circular ? 'ui-progress-ring' : 'ui-progress-line'} ${indeterminate ? 'is-indeterminate' : ''} ${className}`} style={style}>
    {circular ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="ui-progress-track" cx="12" cy="12" r="9" /><circle className="ui-progress-value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${ratio * 100} 100`} /></svg>
      : <span className="ui-progress-value" style={{ width: indeterminate ? '40%' : `${ratio * 100}%` }} />}
  </span>;
}
