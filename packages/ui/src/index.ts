/**
 * Package entrypoint for the future `@openlup/ui` package.
 *
 * Re-exports the neutral token, primitive, and accessibility contracts. This is
 * a STAGED, INERT scaffold: it is not wired into the monorepo build, test, or
 * workspace resolution yet. See README.md for the activation contract.
 */

export type { UiTheme, UiColorScale, UiScale } from "./tokens.js";
export { defaultTheme } from "./tokens.js";

export type { A11yProps } from "./a11y.js";
export { focusRingClassName, toAriaAttributes } from "./a11y.js";

export type { PrimitiveProps, PrimitiveDescriptor } from "./primitives.js";
