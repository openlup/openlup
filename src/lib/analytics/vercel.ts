import { pageview, track } from "@vercel/analytics";
import type { AnalyticsPort } from "../../domains/platform-runtime/ports.js";

/**
 * Vercel Analytics adapter for the `AnalyticsPort` (the `vercel-supabase`
 * default). Page views map onto `@vercel/analytics`'s `pageview`; custom events
 * onto `track`. Vercel only accepts scalar property values, so nested/complex
 * values are dropped here rather than forwarded.
 */

type AllowedPropertyValue = string | number | boolean | null;

function isAllowedPropertyValue(value: unknown): value is AllowedPropertyValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function toAllowedProperties(
  properties?: Record<string, unknown>,
): Record<string, AllowedPropertyValue> | undefined {
  if (!properties) return undefined;
  const out: Record<string, AllowedPropertyValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isAllowedPropertyValue(value)) {
      out[key] = value;
    }
  }
  return out;
}

export function createVercelAnalytics(): AnalyticsPort {
  return {
    trackPageView(pathname: string) {
      pageview({ path: pathname });
    },
    trackEvent(name: string, properties?: Record<string, unknown>) {
      track(name, toAllowedProperties(properties));
    },
  };
}
