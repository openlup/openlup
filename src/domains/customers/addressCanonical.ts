export interface CanonicalAddressInput {
  clientId?: string | null;
  kind?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  country?: string | null;
}

export function canonicalAddressKey(input: CanonicalAddressInput): string {
  return [
    normalise(input.clientId ?? ""),
    normaliseKind(input.kind),
    normalise(input.country ?? "PL"),
    normalisePostalCode(input.postalCode),
    normalise(input.city),
    normalise(input.line1),
    normalise(input.line2 ?? ""),
  ].join("|");
}

function normaliseKind(value: string | null | undefined): string {
  return value === "billing" || value === "shipping" || value === "both" ? value : "shipping";
}

function normalisePostalCode(value: string): string {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}
