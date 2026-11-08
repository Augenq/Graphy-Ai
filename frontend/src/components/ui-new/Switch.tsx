import { Switch as MaxSwitch } from '@maxhub/max-ui';

/** MAX UI Switch at Graphy's compact density; the label is the accessible name (there is no visible text in the control). */
export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <MaxSwitch className="ui-switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />;
}
