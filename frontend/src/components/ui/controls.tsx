import { Button as MaxButton, IconButton as MaxIconButton, Input, Textarea as MaxTextarea, MaxUI } from '@maxhub/max-ui';
import { Children, isValidElement, useId, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import '@maxhub/max-ui/styles.css';
import '../../styles/max-ui.css';

const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');

export function UIProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore((notify) => {
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  return <MaxUI colorScheme={theme} platform="android" resetBody={false} className="graphy-max-ui">{children}</MaxUI>;
}

export function Button({ className, variant = 'primary', size = 'xsmall', type = 'button', children, iconBefore, iconAfter, ...props }: ComponentProps<typeof MaxButton>) {
  const nodes = Children.toArray(children);
  const icons = nodes.filter(child => isValidElement<{ slot?: string }>(child) && child.props.slot === 'icon');
  const text = nodes.filter(child => !icons.includes(child));
  const first = icons[0];
  const before = first && nodes.indexOf(first) === 0 ? first : undefined;
  const after = icons.find(icon => icon !== before);
  return <MaxButton {...props} data-variant={variant} type={type} variant={variant} size={size}
    iconBefore={iconBefore ?? before} iconAfter={iconAfter ?? after}
    innerClassNames={{ ...props.innerClassNames, content: cx('ui-button-label', props.innerClassNames?.content) }}
    className={cx('ui-button', className)}>{text}</MaxButton>;
}

export function IconButton({ className, variant = 'ghost', size = 'xsmall', type = 'button', ...props }: ComponentProps<typeof MaxIconButton>) {
  return <MaxIconButton {...props} data-variant={variant} type={type} variant={variant} size={size} className={cx('ui-icon-button', className)} />;
}

/** Field labels and validation are shared: MAX inputs intentionally expose native input semantics. */
type Decoration = { label?: string; error?: boolean; errorText?: string; children?: ReactNode };
function leadingIcon(children: ReactNode) {
  return Children.toArray(children).find(child => isValidElement<{ slot?: string }>(child) && child.props.slot === 'leading-icon');
}
export function Field({ label, error, errorText, children, className, id: suppliedId, ...props }: ComponentProps<typeof Input> & Decoration) {
  const generated = useId();
  const id = suppliedId ?? generated;
  const hintId = `${id}-error`;
  const search = props.type === 'search' || /search-field|palette-search/.test(className ?? '');
  return <div className={cx('ui-field', search && 'ui-search-field', error && 'ui-field-error', className)}>
    {label && <label className={search ? "sr-only" : "ui-field-label"} htmlFor={id}>{label}</label>}
    <Input {...props} id={id} className="ui-field-control" placeholder={props.placeholder ?? (search ? label : undefined)} withClearButton={props.withClearButton ?? search} iconBefore={props.iconBefore ?? leadingIcon(children)} size="medium"
      aria-invalid={error || undefined} aria-describedby={[props['aria-describedby'], error && errorText ? hintId : ''].filter(Boolean).join(' ') || undefined}
      innerClassNames={{ ...props.innerClassNames, container: cx('ui-field-container', props.innerClassNames?.container), input: cx('ui-field-input', props.innerClassNames?.input) }} />
    {error && errorText && <span id={hintId} role="alert" className="ui-field-error-text">{errorText}</span>}
  </div>;
}

export function Textarea({ label, error, errorText, children: _children, className, id: suppliedId, ...props }: ComponentProps<typeof MaxTextarea> & Decoration) {
  const generated = useId();
  const id = suppliedId ?? generated;
  const hintId = `${id}-error`;
  return <div className={cx('ui-field ui-textarea', error && 'ui-field-error', className)}>
    {label && <label className="ui-field-label" htmlFor={id}>{label}</label>}
    <MaxTextarea {...props} id={id} aria-invalid={error || undefined}
      aria-describedby={[props['aria-describedby'], error && errorText ? hintId : ''].filter(Boolean).join(' ') || undefined}
      innerClassNames={{ textarea: 'ui-textarea-input' }} />
    {error && errorText && <span id={hintId} role="alert" className="ui-field-error-text">{errorText}</span>}
  </div>;
}
