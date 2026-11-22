import type { TaxRefusalCode } from "./types.js";

export type Decode<T> = (value: unknown, field: string) => T;
type Fields = Record<string, Decode<unknown>>;
type Decoded<F extends Fields> = { [K in keyof F]: ReturnType<F[K]> };
class ParseError extends Error {
  constructor(message: string, readonly field: string, readonly code: TaxRefusalCode) { super(message); }
}

export const exclusiveTaxRemedy = "Use the existing inclusive quote path for inclusive-tax quotes. This port version calculates exclusive tax.";

export function invalid(
  field: string, remedy = "Supply the documented value at this field.", code: TaxRefusalCode = "tax_invalid_input",
): never {
  throw new ParseError(remedy, field, code);
}

function property(value: object, key: string, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) invalid(field, "Supply an own enumerable data property.");
  return descriptor.value;
}

function record(value: unknown, field: string): object {
  if (typeof value !== "object" || value === null) invalid(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(field);
  return value;
}

export function object<R extends Fields, O extends Fields = Record<never, never>>(
  required: R, optional?: O,
): Decode<Decoded<R> & Partial<Decoded<O>>> {
  return (value, field) => {
    const input = record(value, field);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || (!Object.hasOwn(required, key) && !(optional && Object.hasOwn(optional, key)))) {
        invalid(field, "Remove unexpected properties from this object.");
      }
    }
    const result: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(required)) {
      const path = field + "/" + key;
      result[key] = decode(property(input, key, path), path);
    }
    for (const [key, decode] of Object.entries(optional ?? {})) {
      const path = field + "/" + key;
      if (Object.hasOwn(input, key)) result[key] = decode(property(input, key, path), path);
    }
    return result as Decoded<R> & Partial<Decoded<O>>;
  };
}

export function variant<T>(key: string, cases: Record<string, Decode<T>>): Decode<T> {
  return (value, field) => {
    const path = field + "/" + key;
    const tag = property(record(value, field), key, path);
    if (typeof tag !== "string" || !Object.hasOwn(cases, tag)) invalid(path, "Supply a supported discriminator.");
    return cases[tag](value, field);
  };
}

export function array<T>(item: Decode<T>, max = 1_048_576): Decode<T[]> {
  return (value, field) => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
      || Reflect.ownKeys(value).length !== value.length + 1) invalid(field, "Supply a dense array within the documented limits.");
    return Array.from({ length: value.length }, (_, index) => {
      const path = field + "/" + index;
      return item(property(value, String(index), path), path);
    });
  };
}

export function checked<T>(predicate: (value: unknown) => value is T, remedy: string): Decode<T> {
  return (value, field) => {
    if (!predicate(value)) invalid(field, remedy);
    return value;
  };
}

export function oneOf<const T extends readonly (string | number)[]>(...allowed: T): Decode<T[number]> {
  return checked((value): value is T[number] => allowed.some(item => item === value),
    "Supply one of " + allowed.join(", ") + ".");
}

export function unique<T>(items: readonly T[], key: (item: T) => string, field: string, code?: TaxRefusalCode): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = key(item);
    if (seen.has(id)) invalid(field + "/" + index, "Remove the duplicate identity.", code);
    seen.add(id);
  });
}

export interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: ParseError };
}

export function bounded<T>(result: T): T {
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1_048_576) {
    invalid("", "Reduce the document to at most one MiB.");
  }
  return result;
}

export function schema<T>(decode: Decode<T>): Schema<T> {
  function parse(value: unknown): T {
    try {
      return bounded(decode(value, ""));
    } catch (error) {
      if (error instanceof ParseError) throw error;
      return invalid("", "Supply an ordinary serializable document.");
    }
  }
  return { parse, safeParse(value) {
    try { return { success: true, data: parse(value) }; }
    catch (error) { return { success: false, error: error as ParseError }; }
  } };
}
