/**
 * Neutral accessibility helpers for the future `@openlup/ui` package.
 *
 * These are framework-agnostic constants and pure helpers. They carry no brand
 * copy, no locale strings, and read no environment. Any user-facing label is
 * supplied by the caller.
 */

/**
 * Utility class name applied to focusable primitives so a host stylesheet can
 * attach a visible focus ring. The concrete ring style is defined by the
 * consumer's CSS, not by this package.
 */
export const focusRingClassName = "openlup-ui-focus-ring";

/** Attribute contract a primitive expects for its accessible name/state. */
export interface A11yProps {
  /** Caller-supplied accessible label. Never defaulted to brand copy here. */
  readonly ariaLabel?: string;
  /** Whether the control is currently disabled for assistive tech. */
  readonly disabled?: boolean;
}

/**
 * Pure helper that maps an {@link A11yProps} bag to DOM-ready aria-* attributes.
 * Returns a plain object so any renderer (React, Solid, plain DOM) can spread it.
 */
export function toAriaAttributes(props: A11yProps): Record<string, string | boolean> {
  const attributes: Record<string, string | boolean> = {};
  if (props.ariaLabel !== undefined) {
    attributes["aria-label"] = props.ariaLabel;
  }
  if (props.disabled !== undefined) {
    attributes["aria-disabled"] = props.disabled;
  }
  return attributes;
}
