/** Application-owned commercial domains. Defaults and preferred choices never widen admission. */
export type Numbers = { kind: 'set'; values: readonly number[] }
  | { kind: 'range'; min: number; max: number; step: number };
export const set = (...values: number[]): Numbers => ({ kind: 'set', values });
export const range = (min: number, max: number, step: number): Numbers => ({ kind: 'range', min, max, step });
export const contains = (domain: Numbers, value: number): boolean => Number.isSafeInteger(value) && (domain.kind === 'set'
  ? domain.values.includes(value) : value >= domain.min && value <= domain.max && (value-domain.min)%domain.step === 0);
export const maximum = (domain: Numbers): number => domain.kind === 'set' ? Math.max(...domain.values) : domain.max;
export function choices(domain: Numbers): number[] {
  return domain.kind === 'set' ? [...domain.values] : Array.from({ length: Math.floor((domain.max-domain.min)/domain.step)+1 }, (_, index) => domain.min+index*domain.step);
}

export type Choice<T extends string> = { allowed: readonly T[]; default: T };
export const choice = <T extends string>(def: T, ...allowed: T[]): Choice<T> => ({ allowed, default: def });
export function assertChoice<T extends string>(value: Choice<T>, vocabulary: readonly T[], code: string): void {
  if (!value || !Array.isArray(value.allowed) || !value.allowed.length
    || new Set(value.allowed).size !== value.allowed.length
    || value.allowed.some(item => !vocabulary.includes(item)) || !value.allowed.includes(value.default)) {
    throw new Error(code);
  }
}
