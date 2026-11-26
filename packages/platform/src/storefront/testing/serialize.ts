import { parseStorefrontVerdict, type StorefrontVerdict } from "../../lifecycle/index.js";

/**
 * Serializes a verdict as `JSON.stringify(verdict, null, 2)` and a line feed,
 * after `parseStorefrontVerdict` accepts that text, so a harness never writes
 * a verdict the package refuses. Otherwise throws a `TypeError` naming the
 * refusal's code, observation, cause, fix and recheck. A harness writes one
 * file per run under `.context/storefront-verdicts/`; this entry reads and
 * writes no file.
 *
 * @experimental
 */
export function serializeStorefrontVerdict(verdict: StorefrontVerdict): string {
  const text = `${JSON.stringify(verdict, null, 2)}\n`;
  const parsed = parseStorefrontVerdict(text);
  if (!parsed.ok) {
    const { code, observed, cause, fix, recheck } = parsed.refusal;
    throw new TypeError(`${code}: ${observed} Cause: ${cause} Fix: ${fix} Recheck: ${recheck}`);
  }
  return text;
}
