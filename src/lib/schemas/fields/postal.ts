import { postcodeValidator, postcodeValidatorExistsForCountry } from "postcode-validator";
import { z } from "../../validation/zod.js";
import { normalizeCountryIso } from "./country";
import {
  applyBlockingIssues,
  fieldIssue,
  type FieldValidationIssue,
  makeFieldResult,
  normalizeText,
  optionalByDefault,
  resolveFieldMode,
  type FieldSchema,
  type FieldValidationOptions,
  type FieldValidationResult,
} from "./modes";

export interface PostalCodeFieldOptions extends FieldValidationOptions {
  country?: unknown;
}

export function normalizePostalCode(value: unknown): string {
  return normalizeText(value).toUpperCase().replace(/\s+/g, " ");
}

/**
 * Country-aware canonicalisation applied before validation. Polish postal codes
 * are canonically `NN-NNN`, but customers routinely type the five bare digits
 * (e.g. `05074`). We insert the hyphen so the bare form is accepted and stored
 * canonically. Idempotent: `05-074` and `05 074` both normalise to `05-074`,
 * and any non-five-digit input is left to the country validator to reject.
 */
export function formatPostalCodeForCountry(value: unknown, country?: unknown): string {
  const normalized = normalizePostalCode(value);
  if (normalizeCountryIso(country) === "PL") {
    const digits = normalized.replace(/\D/g, "");
    if (digits.length === 5) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }
  return normalized;
}

export function validatePostalCodeField(
  value: unknown,
  options: PostalCodeFieldOptions = {},
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const postalCode = formatPostalCodeForCountry(value, options.country);
  const country = normalizeCountryIso(options.country);
  const issues: FieldValidationIssue[] = [];

  if (!postalCode && required) {
    issues.push(fieldIssue("required", "forms:fields.postalCode.required", mode));
  } else if (postalCode && !isValidPostalForCountry(postalCode, country)) {
    issues.push(fieldIssue("invalid", "forms:fields.postalCode.invalid", mode));
  }

  return makeFieldResult(postalCode, issues);
}

export function postalCodeFieldSchema(
  options: PostalCodeFieldOptions = {},
): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validatePostalCodeField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

function isValidPostalForCountry(postalCode: string, country: string | null): boolean {
  if (!country) return /^[A-Z0-9][A-Z0-9 -]{1,18}[A-Z0-9]$/.test(postalCode);
  if (!postcodeValidatorExistsForCountry(country)) {
    return /^[A-Z0-9][A-Z0-9 -]{1,18}[A-Z0-9]$/.test(postalCode);
  }

  return postcodeValidator(postalCode, country);
}
