import { hexFromArgb, TonalPalette } from '@material/material-color-utilities';
import { paletteFor } from './palette';
export { graphyPalettes, paletteFor } from './palette';
import { graphyPalettes } from './palette';
import type { ColorPalette } from './palette';

const neutral = TonalPalette.fromHueAndChroma(0, 0);
export function applyMaterialTheme(dark: boolean, colorPalette: ColorPalette = 'graphy') {
  const target = document.documentElement;
  const palette = paletteFor(dark, colorPalette);
  const roles: Record<string, string> = {
    primary: palette.accent,
    'on-primary': palette['accent-foreground'],
    'primary-container': palette.wash,
    'on-primary-container': palette.ink,
    secondary: palette['ink-2'],
    'on-secondary': palette.paper,
    'secondary-container': palette.wash,
    'on-secondary-container': palette.ink,
    tertiary: palette.warn,
    'on-tertiary': palette.paper,
    'tertiary-container': palette['warn-wash'],
    'on-tertiary-container': palette.warn,
    error: palette.danger,
    'on-error': palette.paper,
    'error-container': palette['warn-wash'],
    'on-error-container': palette.ink,
    background: palette.paper,
    'on-background': palette.ink,
    surface: palette.paper,
    'on-surface': palette.ink,
    'surface-variant': palette.wash,
    'on-surface-variant': palette['ink-3'],
    'surface-dim': dark ? palette.paper : palette.rail,
    'surface-bright': dark ? palette.wash : palette.sheet,
    'surface-container-lowest': palette.sheet,
    'surface-container-low': palette.rail,
    'surface-container': palette['plan-bg'],
    'surface-container-high': palette.wash,
    'surface-container-highest': palette.bubble,
    outline: palette.control,
    'outline-variant': palette.rule,
    'inverse-surface': palette.ink,
    'inverse-on-surface': palette.paper,
    'inverse-primary': colorPalette === 'max' ? palette.accent : graphyPalettes[dark ? 'light' : 'dark'].accent,
    'surface-tint': palette.accent,
    shadow: '#000000',
    scrim: '#000000',
  };
  for (const family of ['primary', 'secondary', 'tertiary']) {
    for (const [suffix, tone] of Object.entries({ fixed: 90, 'fixed-dim': 80, 'on-fixed': 10, 'on-fixed-variant': 30 })) {
      const role = suffix.startsWith('on-') ? `on-${family}-${suffix.slice(3)}` : `${family}-${suffix}`;
      roles[role] = colorPalette === 'max'
        ? (suffix.startsWith('on-') ? palette.ink : palette.wash)
        : hexFromArgb(neutral.tone(tone));
    }
  }
  for (const [role, value] of Object.entries(roles)) target.style.setProperty(`--md-sys-color-${role}`, value);
  for (const [name, value] of Object.entries(palette)) target.style.setProperty(`--${name}`, value);
  target.style.colorScheme = dark ? 'dark' : 'light';
}
