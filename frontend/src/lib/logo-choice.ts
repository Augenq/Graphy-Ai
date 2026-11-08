import { ATLAS } from "./logo-candidates";

/** A traced logo shape (filled path, drawn with currentColor). */
export type LogoShape = { id: string; name: string; viewBox: string; transform: string; d: string };

/** The Graphy mark is fixed: logo «ATLAS». The tab icon is public/favicon.svg (the same shape, light ink on a dark browser theme). */
export const useLogoChoice = (): LogoShape => ATLAS;
