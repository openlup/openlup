export interface CanonicalJsonOptions {
  readonly maxDepth: number;
  readonly maxBytes: number;
  readonly errors: { readonly invalid: string; readonly depth: string; readonly tooLarge: string };
}

/** Sorted bounded JSON for command identity; options come from trusted caller constants. */
export function canonicalJson(input: unknown, options: CanonicalJsonOptions): string {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (depth > options.maxDepth) throw new Error(options.errors.depth);
    if (typeof value === "string") {
      if (value.includes("\u0000") || hasLoneSurrogate(value)) throw new Error(options.errors.invalid);
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== "object" || ancestors.has(value)) throw new Error(options.errors.invalid);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(options.errors.invalid);
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error(options.errors.invalid);
    for (const key of keys) {
      visit(key, depth + 1);
      if (Object.getOwnPropertyDescriptor(value, key)?.get || Object.getOwnPropertyDescriptor(value, key)?.set) throw new Error(options.errors.invalid);
    }
    let result: unknown;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new Error(options.errors.invalid);
      result = Array.from(value, (item) => visit(item, depth + 1));
    } else {
      result = Object.fromEntries((keys as string[]).sort().map((key) => [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
    }
    ancestors.delete(value);
    return result;
  }
  const text = JSON.stringify(visit(input, 0));
  if (new TextEncoder().encode(text).byteLength > options.maxBytes) throw new Error(options.errors.tooLarge);
  return text;
}

/** A UTF-16 surrogate without its partner. A loop, not a lookbehind regex: iOS < 16.4 cannot evaluate one. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = value.charCodeAt(index + 1);
    if (unit > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return true;
    index += 1;
  }
  return false;
}
