import { parseStorefrontVerdict, type StorefrontVerdict } from "../../lifecycle/index.js";

const RECHECK = "Call serializeStorefrontVerdict again with the corrected verdict.";

function notJson(path: string, kind: string): TypeError {
  return new TypeError(`storefront_verdict_invalid: ${path === "" ? "the verdict" : path} holds ${kind}, which JSON cannot carry. `
    + "Cause: the serializer refuses a value it would otherwise drop or coerce. "
    + "Fix: set the field to a string, a finite number, a boolean, null, an array or a plain object, or leave it out. "
    + `Recheck: ${RECHECK}`);
}

/** A plain copy with every object's keys sorted by UTF-16 code units; refuses anything JSON would drop or coerce. */
function canonical(value: unknown, path: string, open: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw notJson(path, String(value));
    return value;
  }
  if (typeof value !== "object") throw notJson(path, value === undefined ? "undefined" : `a ${typeof value}`);
  if (open.has(value)) throw notJson(path, "a reference to an enclosing value");
  open.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => canonical(value[index], `${path}[${index}]`, open));
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw notJson(path, "an object that is not plain");
    const keys = Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      Object.defineProperty(copy, key, {
        value: canonical((value as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`, open),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return copy;
  } finally {
    open.delete(value);
  }
}

/**
 * Serializes a verdict as two-space JSON with every object's keys sorted by
 * UTF-16 code units, and a line feed, after `parseStorefrontVerdict` accepts
 * that text, so a harness never writes a verdict the package refuses and equal
 * verdicts give equal bytes whatever order they were built in. A value JSON
 * cannot carry (a function, symbol, bigint, `undefined`, a non-finite number, an
 * object that is not plain, or a cycle) is refused, never dropped or coerced.
 * Refusals throw a `TypeError` whose message is the refusal code and the
 * observation, then `Cause:`, `Fix:` and `Recheck:`. A harness writes one file
 * per run under `.context/storefront-verdicts/`; this entry reads and writes no
 * file.
 *
 * @experimental
 */
export function serializeStorefrontVerdict(verdict: StorefrontVerdict): string {
  const text = `${JSON.stringify(canonical(verdict, "", new Set()), null, 2)}\n`;
  const parsed = parseStorefrontVerdict(text);
  if (!parsed.ok) {
    const { code, observed, cause, fix, recheck } = parsed.refusal;
    throw new TypeError(`${code}: ${observed} Cause: ${cause} Fix: ${fix} Recheck: ${recheck}`);
  }
  return text;
}
