// Dependency-free so scripts/contrast-check.mjs can import it in plain node.
/** Graphy's light/dark surface hierarchy, with strictly neutral colors. */
export const graphyPalettes = {
  light: {
    paper: '#fafafa', rail: '#f3f3f3', sheet: '#ffffff', wash: '#ededed',
    rule: '#dcdcdc', 'rule-2': '#c5c5c5', outline: 'rgb(31 31 31 / 0.15)', control: '#858585',
    ink: '#141414', 'ink-2': '#3a3a3a', 'ink-3': '#626262',
    accent: '#1f1f1f', 'accent-foreground': '#ffffff',
    warn: '#626262', 'warn-wash': '#eeeeee', danger: '#3d3d3d',
    bubble: '#ededed', 'plan-bg': '#ffffff', 'shadow-rgb': '0 0 0',
    'course-english': '#888888', 'course-algebra': '#555555',
  },
  dark: {
    paper: '#151515', rail: '#1b1b1b', sheet: '#1c1c1c', wash: '#2a2a2a',
    rule: '#2f2f2f', 'rule-2': '#3f3f3f', outline: 'rgb(220 220 220 / 0.17)', control: '#898989',
    ink: '#f0f0f0', 'ink-2': '#cecece', 'ink-3': '#979797',
    accent: '#e0e0e0', 'accent-foreground': '#151515',
    warn: '#b4b4b4', 'warn-wash': '#292929', danger: '#c0c0c0',
    bubble: '#262626', 'plan-bg': '#222222', 'shadow-rgb': '0 0 0',
    'course-english': '#aaaaaa', 'course-algebra': '#dddddd',
  },
} as const;

export type ColorPalette = 'graphy' | 'max';

/** MAX's palette, adapted to Graphy's roles: the working area and the fields are #f1f2f4, the panels and the
 *  cards are white, hovers and secondary surfaces take the mid grey, the accent is MAX blue. The native MAX
 *  tokens the provider and the menus read are set to the same values in styles/max-palette.css. */
export const maxPalettes = {
  light: {
    paper: '#f1f2f4', rail: '#ffffff', sheet: '#ffffff', wash: '#e6e7ea',
    rule: '#d7d9df', 'rule-2': '#c3c6ce', outline: 'rgb(14 14 17 / 0.16)', control: '#7d818c',
    ink: '#0e0e11', 'ink-2': '#454851', 'ink-3': '#7d818c',
    accent: '#0077ff', 'accent-foreground': '#ffffff',
    warn: '#5c606a', 'warn-wash': '#e6e7ea', danger: '#ff3b30',
    bubble: '#ffffff', 'plan-bg': '#ffffff', 'shadow-rgb': '20 24 40',
    'course-english': '#0077ff', 'course-algebra': '#454851',
  },
  dark: {
    paper: '#121216', rail: '#1b1b20', sheet: '#222228', wash: '#26262d',
    rule: '#2c2c34', 'rule-2': '#3a3a42', outline: 'rgb(255 255 255 / 0.16)', control: '#8f909b',
    ink: '#ffffff', 'ink-2': '#c6c7cd', 'ink-3': '#8f909b',
    accent: '#1a85ff', 'accent-foreground': '#ffffff',
    warn: '#8f909b', 'warn-wash': '#26262d', danger: '#ff3b30',
    bubble: '#222228', 'plan-bg': '#222228', 'shadow-rgb': '0 0 0',
    'course-english': '#1a85ff', 'course-algebra': '#c6c7cd',
  },
} as const;

export function paletteFor(dark: boolean, colorPalette: ColorPalette = 'graphy'): Record<keyof typeof graphyPalettes.light, string> {
  const base = colorPalette === 'max' ? maxPalettes[dark ? 'dark' : 'light'] : graphyPalettes[dark ? 'dark' : 'light'];
  return { ...base };
}
