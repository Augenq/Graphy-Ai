import { Select as MaxSelect } from '@maxhub/max-ui';

export interface SelectOption<T extends string> { id: T; label: string }

export function Select<T extends string>({ value, options, onChange, label, block = false, width = 128 }: {
  value: T; options: SelectOption<T>[]; onChange: (value: T) => void; label: string; block?: boolean; width?: number;
}) {
  return <MaxSelect value={value} options={options.map(option => ({ value: option.id, label: option.label }))}
    onValueChange={next => onChange(next as T)} aria-label={label} size="medium"
    innerClassNames={{ container: `ui-select ${block ? 'w-full' : ''}`, field: 'ui-select-field', content: 'ui-menu-content', option: 'ui-menu-option' }}
    style={{ minWidth: width }} />;
}
