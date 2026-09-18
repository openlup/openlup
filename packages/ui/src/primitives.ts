/**
 * Neutral UI primitive contracts for the future `@openlup/ui` package.
 *
 * This scaffold defines *prop shapes only* — no rendering, no framework import,
 * no brand copy. Concrete components arrive during the go/no-go activation step.
 */

import type { UiTheme } from "./tokens.js";
import type { A11yProps } from "./a11y.js";

/** Base props every primitive accepts: an injected theme plus a11y attributes. */
export interface PrimitiveProps extends A11yProps {
  readonly theme?: UiTheme;
  readonly className?: string;
}

/**
 * Placeholder primitive descriptor. Documents that primitives are theme-driven
 * and receive all copy/tokens from the caller. Real primitives replace this.
 */
export interface PrimitiveDescriptor {
  readonly name: string;
  readonly props: PrimitiveProps;
}
