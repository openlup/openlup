import { z } from "zod";
import type { DestinationAddressV2 } from "../commerce/contracts/index.js";

import type {
  AddressCanonPostalCodeLookupRequest, AddressCanonPostalCodeLookupResponse,
  AddressCanonLocalitiesLookupRequest, AddressCanonLocalitiesLookupResponse,
  AddressCanonStreetsLookupRequest, AddressCanonStreetsLookupResponse,
  CustomerAddressesRequest, CustomerAddressesResponse, CustomerAddressUpsertRequest, CustomerAddressDeleteRequest,
} from "./contracts/address.js";
type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { flatten(): unknown } };
};
/** Host-owned format, source and geographic validation. */
export interface AddressLookupSchemas {
  addressCanonPostalCodeLookupRequestSchema: Schema<AddressCanonPostalCodeLookupRequest>;
  addressCanonPostalCodeLookupResponseSchema: Schema<AddressCanonPostalCodeLookupResponse>;
  addressCanonLocalitiesLookupRequestSchema: Schema<AddressCanonLocalitiesLookupRequest>;
  addressCanonLocalitiesLookupResponseSchema: Schema<AddressCanonLocalitiesLookupResponse>;
  addressCanonStreetsLookupRequestSchema: Schema<AddressCanonStreetsLookupRequest>;
  addressCanonStreetsLookupResponseSchema: Schema<AddressCanonStreetsLookupResponse>;
}
/** Host-owned validation and mutation-conflict identity. */
export interface CustomerAddressSchemas {
  customerAddressesRequestSchema: Schema<CustomerAddressesRequest>;
  customerAddressesResponseSchema: Schema<CustomerAddressesResponse>;
  customerAddressUpsertRequestSchema: Schema<CustomerAddressUpsertRequest>;
  customerAddressDeleteRequestSchema: Schema<CustomerAddressDeleteRequest>;
  isMutationConflict(error: unknown): error is Error;
}

const unsafeText = /[\p{Cc}\p{Cs}]/u;
const country = /^[A-Za-z]{2}$/u;
const subdivision = /^[A-Za-z0-9-]{1,16}$/u;
const asciiUpper = (value: string) => value.replace(/[a-z]/gu, char => char.toUpperCase());
const trimSpaces = (value: string) => value.replace(/^ +| +$/gu, "");
const normalize = (value: string) => trimSpaces(value.normalize("NFC"));
const bytes = new TextEncoder();

const addressInput = z.strictObject({
  line1: z.string(), line2: z.string().optional(), city: z.string(), subdivisionCode: z.string().optional(),
  postalCode: z.string(), countryCode: z.string(),
});
const addressFields = addressInput.keyof();
const token = z.union([z.enum(["digit", "letter"]), z.strictObject({ literal: z.string().regex(/^[ -~]$/u) })]);
const key = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const code = z.string().regex(subdivision);
const reference = z.string().min(1).max(180).refine(value => value === value.trim() && !unsafeText.test(value));
const line1Prefix = z.string().min(1).refine(value => !value.startsWith(" ") && !unsafeText.test(value))
  .transform(value => value.normalize("NFC")).refine(value => bytes.encode(value).byteLength <= 200);
const policyInput = z.strictObject({
  schemaVersion: z.literal(1), policyRef: reference, policyRevision: reference, countryCode: z.string().regex(country),
  requiredFields: z.array(addressFields).max(6), allowedSubdivisionCodes: z.array(code), subdivisionAliases: z.record(code, code),
  postalRule: z.strictObject({
    upperAscii: z.boolean(), stripAsciiSpaces: z.boolean(), alternatives: z.array(z.array(token).min(1).max(32)).min(1).max(16),
  }),
  classificationRules: z.array(z.union([
    z.strictObject({ key, subdivisionCode: code }),
    z.strictObject({ key, line1Prefix }),
  ])).max(32),
});

/** @experimental Immutable host data selected for one market and country. */
export interface AddressPolicyV1 {
  readonly schemaVersion: 1;
  readonly policyRef: string;
  readonly policyRevision: string;
  readonly countryCode: string;
  readonly requiredFields: readonly (keyof DestinationAddressV2)[];
  readonly allowedSubdivisionCodes: readonly string[];
  readonly subdivisionAliases: Readonly<Record<string, string>>;
  readonly postalRule: {
    readonly upperAscii: boolean;
    readonly stripAsciiSpaces: boolean;
    readonly alternatives: readonly (readonly ("digit" | "letter" | { readonly literal: string })[])[];
  };
  readonly classificationRules: readonly (
    { readonly key: string; readonly subdivisionCode: string } | { readonly key: string; readonly line1Prefix: string }
  )[];
}

type RefusalCode = "address_invalid_input" | "address_policy_unavailable" | "address_policy_invalid"
  | "address_subdivision_required" | "address_subdivision_unrecognized" | "address_postal_invalid";
type Refusal = { outcome: "refused"; code: RefusalCode; field: string; remedy: string };
const refuse = (code: RefusalCode, field: string, remedy: string): Refusal => ({ outcome: "refused", code, field, remedy });
const invalidPolicy = () => refuse("address_policy_invalid", "policyRef", "The host address policy is malformed. Correct the selected policy definition and reload the host binding.");
const invalidInput = (field: string, reason: string) => refuse("address_invalid_input", field, `${reason} Correct ${field} and resubmit the destination address.`);
const blankSubdivision = () => refuse("address_invalid_input", "subdivisionCode", "Omit an empty subdivision, or supply one of the policy's subdivision codes.");

function hasReachablePostalMask({ upperAscii, stripAsciiSpaces, alternatives }: AddressPolicyV1["postalRule"]): boolean {
  return alternatives.some(mask => mask.every((part, index) => typeof part !== "object" || (
    (!upperAscii || asciiUpper(part.literal) === part.literal)
    && (part.literal !== " " || (!stripAsciiSpaces && index > 0 && index < mask.length - 1))
  )));
}

function matchesPostalMask(postal: string, alternatives: AddressPolicyV1["postalRule"]["alternatives"]): boolean {
  return alternatives.some(mask => mask.length === postal.length && mask.every((part, index) => {
    const char = postal[index]!;
    if (typeof part === "object") return part.literal === char;
    return part === "digit" ? /^[0-9]$/u.test(char) : /^[A-Za-z]$/u.test(char);
  }));
}

/** @experimental Validate an address using the host's selected policy and return normalized address facts. */
export function validateDestinationAddressV2(input: unknown, policy?: AddressPolicyV1): Refusal | {
  outcome: "valid"; address: DestinationAddressV2; policyRef: string; policyRevision: string; classificationKeys: string[];
} {
  const parsed = addressInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.code === "unrecognized_keys" ? issue.keys[0]! : String(issue.path[0] ?? "address");
    return invalidInput(field, issue.code === "unrecognized_keys" ? "The address contains an unsupported field. Remove it." : "Expected an address object with text fields.");
  }
  const address = parsed.data;
  for (const value of addressFields.options) {
    const raw = address[value];
    if (raw === undefined) continue;
    if (unsafeText.test(raw)) {
      if (value === "subdivisionCode" && raw.trim() === "") return blankSubdivision();
      return invalidInput(value, "The address contains a control character or invalid Unicode.");
    }
    address[value] = normalize(raw);
  }
  if (!country.test(address.countryCode)) return invalidInput("countryCode", "Enter a two-letter ASCII country code.");
  address.countryCode = asciiUpper(address.countryCode);
  if (address.subdivisionCode !== undefined && !subdivision.test(address.subdivisionCode)) {
    if (address.subdivisionCode.trim() === "") return blankSubdivision();
    return invalidInput("subdivisionCode", "Enter 1 to 16 ASCII letters, digits or hyphens, or omit an optional subdivision.");
  }

  if (policy === undefined) return refuse("address_policy_unavailable", "countryCode", "No host policy is installed for this market and country. Bind an address policy for the destination country.");
  const configured = policyInput.safeParse(policy);
  if (!configured.success) return invalidPolicy();
  const { policyRef, policyRevision, requiredFields, allowedSubdivisionCodes, subdivisionAliases, postalRule, classificationRules } = configured.data;
  const allowed = new Set(allowedSubdivisionCodes.map(asciiUpper));
  const aliases = new Map(Object.entries(subdivisionAliases).map(([from, to]) => [asciiUpper(from), asciiUpper(to)]));
  if (new Set(requiredFields).size !== requiredFields.length || allowed.size !== allowedSubdivisionCodes.length
    || aliases.size !== Object.keys(subdivisionAliases).length
    || [...aliases].some(([source, target]) => allowed.has(source) || !allowed.has(target))
    || new Set(classificationRules.map(rule => rule.key)).size !== classificationRules.length
    || classificationRules.some(rule => "subdivisionCode" in rule && !allowed.has(asciiUpper(rule.subdivisionCode)))
    || !hasReachablePostalMask(postalRule)) return invalidPolicy();
  if (address.countryCode !== asciiUpper(configured.data.countryCode)) {
    return refuse("address_policy_unavailable", "countryCode", "The selected policy covers a different country. Bind the policy for this market and destination country.");
  }

  if (address.subdivisionCode !== undefined) {
    const token = asciiUpper(address.subdivisionCode);
    address.subdivisionCode = aliases.get(token) ?? token;
  }
  for (const field of ["line1", "city", "postalCode", ...requiredFields] as const) {
    if (address[field]) continue;
    if (field === "subdivisionCode") return refuse("address_subdivision_required", field, "This policy requires a subdivision. Enter a subdivision for the destination country.");
    return invalidInput(field, "The address requires a nonblank value.");
  }
  if (address.subdivisionCode !== undefined && !allowed.has(address.subdivisionCode)) {
    return refuse("address_subdivision_unrecognized", "subdivisionCode", "This policy does not admit the subdivision. Select a subdivision accepted for the destination country.");
  }
  if (postalRule.upperAscii) address.postalCode = asciiUpper(address.postalCode);
  if (postalRule.stripAsciiSpaces) address.postalCode = address.postalCode.replaceAll(" ", "");
  for (const [field, max] of [["line1", 200], ["line2", 200], ["city", 120], ["postalCode", 32]] as const) {
    if (bytes.encode(address[field] ?? "").byteLength > max) return invalidInput(field, `The normalized field exceeds ${max} UTF-8 bytes.`);
  }
  if (!matchesPostalMask(address.postalCode, postalRule.alternatives)) {
    return refuse("address_postal_invalid", "postalCode", "The postal code does not match the policy format. Enter the full postal code for the destination.");
  }
  if (!address.line2) delete address.line2;
  if (address.subdivisionCode === undefined) delete address.subdivisionCode;
  const line1 = asciiUpper(address.line1);
  const classificationKeys = classificationRules.filter(rule => "subdivisionCode" in rule
    ? asciiUpper(rule.subdivisionCode) === address.subdivisionCode
    : line1.startsWith(asciiUpper(rule.line1Prefix))).map(rule => rule.key).sort();
  return { outcome: "valid", address, policyRef, policyRevision, classificationKeys };
}
