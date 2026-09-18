import { z } from "../../validation/zod.js";
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

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const urlPattern = /https?:\/\/|www\./i;
const freeEmailDomains = new Set([
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "outlook.com",
  "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "proton.me",
  "protonmail.com", "aol.com", "wp.pl", "o2.pl", "onet.pl", "interia.pl",
  "gazeta.pl", "op.pl",
]);

export interface EmailFieldOptions extends FieldValidationOptions {
  allowFreeDomains?: boolean;
}

export function validateEmailField(
  value: unknown,
  options: EmailFieldOptions = {},
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const email = normalizeText(value).toLowerCase();
  const issues: FieldValidationIssue[] = [];

  if (!email && required) {
    issues.push(fieldIssue("required", "forms:fields.email.required", mode));
  } else if (email && !emailPattern.test(email)) {
    issues.push(fieldIssue("invalid", "forms:fields.email.invalid", mode));
  } else if (email && options.allowFreeDomains === false && isFreeEmailDomain(email)) {
    issues.push(fieldIssue("free_domain", "forms:fields.email.freeDomain", mode));
  }

  return makeFieldResult(email, issues);
}

export function emailFieldSchema(options: EmailFieldOptions = {}): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validateEmailField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

export function businessEmailFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return emailFieldSchema({ ...options, allowFreeDomains: false });
}

export function isFreeEmailDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && freeEmailDomains.has(domain));
}

export function validateNameField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<string> {
  return validateTextField(value, options, {
    required: "forms:fields.name.required",
    tooShort: "forms:fields.name.tooShort",
    tooLong: "forms:fields.name.tooLong",
    invalid: "forms:fields.name.invalid",
    min: 2,
    max: 80,
  });
}

export function nameFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return textFieldSchema(validateNameField, options);
}

export function validateCompanyField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<string> {
  return validateTextField(value, options, {
    required: "forms:fields.company.required",
    tooShort: "forms:fields.company.tooShort",
    tooLong: "forms:fields.company.tooLong",
    invalid: "forms:fields.company.invalid",
    min: 2,
    max: 160,
  });
}

export function companyFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return textFieldSchema(validateCompanyField, options);
}

export function validateConsentField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<boolean> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const consent = value === true;
  const issues: FieldValidationIssue[] = [];

  if (required && !consent) {
    issues.push(fieldIssue("required", "forms:fields.consent.required", mode));
  }

  return makeFieldResult(consent, issues);
}

export function consentFieldSchema(options: FieldValidationOptions = {}): FieldSchema<boolean> {
  return z
    .unknown()
    .transform((value) => validateConsentField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

function validateTextField(
  value: unknown,
  options: FieldValidationOptions,
  config: {
    required: string;
    tooShort: string;
    tooLong: string;
    invalid: string;
    min: number;
    max: number;
  },
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const text = normalizeText(value).replace(/\s+/g, " ");
  const issues: FieldValidationIssue[] = [];

  if (!text && required) {
    issues.push(fieldIssue("required", config.required, mode));
  } else if (text && text.length < config.min) {
    issues.push(fieldIssue("too_short", config.tooShort, mode));
  } else if (text.length > config.max) {
    issues.push(fieldIssue("too_long", config.tooLong, mode));
  }

  if (text && urlPattern.test(text)) {
    issues.push(fieldIssue("invalid", config.invalid, mode));
  }

  return makeFieldResult(text, issues);
}

function textFieldSchema(
  validate: (value: unknown, options: FieldValidationOptions) => FieldValidationResult<string>,
  options: FieldValidationOptions,
): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validate(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}
