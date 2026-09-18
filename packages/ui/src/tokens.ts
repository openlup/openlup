/**
 * Neutral design-token contracts for the future `@openlup/ui` package.
 *
 * Tokens here describe *shape only*. Concrete color, spacing, and typography
 * values arrive at runtime via a caller-supplied theme (props/context). No
 * brand palette, seller name, locale, currency, or timezone literal may live in
 * this package.
 */

/** Semantic color slots a consumer theme must fill. Values are opaque strings. */
export interface UiColorScale {
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
  readonly muted: string;
  readonly border: string;
}

/** Spacing/radius scale, expressed as opaque CSS length strings. */
export interface UiScale {
  readonly radius: string;
  readonly gap: string;
}

/** The theme contract a host application injects into UI primitives. */
export interface UiTheme {
  readonly colors: UiColorScale;
  readonly scale: UiScale;
}

/**
 * Placeholder theme. Deliberately generic, brand-free values so the scaffold
 * typechecks and documents the contract shape. Real consumers override every
 * field via their own theme provider.
 */
export const defaultTheme: UiTheme = {
  colors: {
    background: "transparent",
    foreground: "currentColor",
    accent: "currentColor",
    muted: "transparent",
    border: "currentColor",
  },
  scale: {
    radius: "0",
    gap: "0",
  },
};
