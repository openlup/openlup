import { createHash } from "node:crypto";

/** Match the existing writer's md5(p_intent::text), without a writing RPC.
 * Normalize through JSON transport first (undefined, dates and nonfinite
 * numbers), then reproduce jsonb's UTF-8 key ordering, spacing and numeric
 * exponent expansion. Real PostgreSQL witnesses own this compatibility. */
export function configuratorIntentReplayFingerprint(payload: object): string {
  return createHash("md5").update(jsonbText(JSON.parse(JSON.stringify(payload)))).digest("hex");
}

function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => {
      const left = Buffer.from(a), right = Buffer.from(b);
      return left.length - right.length || Buffer.compare(left, right);
    });
    return `{${keys.map(key => `${JSON.stringify(key)}: ${jsonbText(record[key])}`).join(", ")}}`;
  }
  const encoded = JSON.stringify(value);
  if (typeof value !== "number" || !encoded.includes("e")) return encoded;
  // PostgreSQL numeric output never uses an exponent. Expand the JSON decimal
  // digits directly; converting back through floating point would round again.
  const [coefficient, exponent] = encoded.split("e"), negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const digits = unsigned.replace(".", ""), point = (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) + Number(exponent);
  const decimal = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + decimal;
}
