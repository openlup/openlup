import parsePhoneNumberFromString, { type CountryCode } from "libphonenumber-js/min";
import { z } from "../../validation/zod.js";
import { isSupportedCountryIso, normalizeCountryIso } from "./country.js";
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
} from "./modes.js";

export interface PhoneFieldOptions extends FieldValidationOptions {
  country?: unknown;
}

export function normalizePhoneToE164(value: unknown, country?: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;

  const defaultCountry = countryCodeForPhone(country);
  const parsed = parsePhoneNumberFromString(raw, {
    defaultCountry,
    extract: false,
  });

  return parsed?.isValid() ? parsed.number : null;
}

export function validatePhoneField(
  value: unknown,
  options: PhoneFieldOptions = {},
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const raw = normalizeText(value);
  const e164 = normalizePhoneToE164(raw, options.country);
  const issues: FieldValidationIssue[] = [];

  if (!raw && required) {
    issues.push(fieldIssue("required", "forms:fields.phone.required", mode));
  } else if (raw && !e164) {
    issues.push(fieldIssue("invalid", "forms:fields.phone.invalid", mode));
  }

  return makeFieldResult(e164 ?? raw, issues);
}

export function phoneFieldSchema(options: PhoneFieldOptions = {}): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validatePhoneField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

function countryCodeForPhone(country: unknown): CountryCode | undefined {
  const iso = normalizeCountryIso(country);
  return iso && isSupportedCountryIso(iso) ? (iso as CountryCode) : undefined;
}
