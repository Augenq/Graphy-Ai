import type { HTMLAttributes, Ref, Key } from 'react';
import '@material/web/all.js';

type ElementEvent<T> = Event & { readonly target: T; readonly currentTarget: T };
type MaterialProps<T extends HTMLElement> = Omit<HTMLAttributes<T>, 'onChange'> &
  Partial<Omit<T, keyof HTMLAttributes<T> | 'children' | 'style' | 'shadowRoot' | 'onchange' | 'onclose' | 'oncancel'>> & {
    ref?: Ref<T>;
    key?: Key;
    onChange?: (event: ElementEvent<T>) => void;
    onchange?: (event: ElementEvent<T>) => void;
    onremove?: (event: Event) => void;
    onclosed?: (event: Event) => void;
    onopened?: (event: Event) => void;
    onclose?: (event: Event) => void;
    oncancel?: (event: Event) => void;
  };
type MaterialElements = {
  [K in keyof HTMLElementTagNameMap as K extends `md-${string}` ? K : never]: MaterialProps<HTMLElementTagNameMap[K]>;
};
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements extends MaterialElements {}
  }
}
