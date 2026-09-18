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
} from "./modes";

export const petTypeValues = ["dog", "cat", "both"] as const;
export const publicPetAgeValues = ["puppy", "young", "adult", "senior"] as const;
export const petWeightUnits = ["kg", "lb"] as const;

export type PetType = (typeof petTypeValues)[number];
export type PublicPetAge = (typeof publicPetAgeValues)[number];
export type PetAgeMode = "publicEnum" | "adminLegacyText";
export type PetWeightUnit = (typeof petWeightUnits)[number];

export type PublicPetAgeOption = Readonly<{
  value: PublicPetAge;
  labelKey: `forms:fields.petAge.options.${PublicPetAge}`;
}>;

export const publicPetAgeOptions: readonly PublicPetAgeOption[] = publicPetAgeValues.map((value) => ({
  value,
  labelKey: `forms:fields.petAge.options.${value}` as const,
}));

const kilogramsPerPound = 0.45359237;

const petTypeSet = new Set<string>(petTypeValues);
const publicPetAgeSet = new Set<string>(publicPetAgeValues);

export interface PetAgeFieldOptions extends FieldValidationOptions {
  ageMode?: PetAgeMode;
}

export function validatePetTypeField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<string> {
  return validateStringEnum(value, options, petTypeSet, "forms:fields.petType");
}

export function petTypeFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return enumFieldSchema(validatePetTypeField, options);
}

export function validatePetNameField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const name = normalizeText(value).replace(/\s+/g, " ");
  const issues: FieldValidationIssue[] = [];

  if (!name && required) {
    issues.push(fieldIssue("required", "forms:fields.petName.required", mode));
  } else if (name.length > 80) {
    issues.push(fieldIssue("too_long", "forms:fields.petName.tooLong", mode));
  }

  return makeFieldResult(name, issues);
}

export function petNameFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validatePetNameField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

export function validatePetAgeField(
  value: unknown,
  options: PetAgeFieldOptions = {},
): FieldValidationResult<string> {
  if (options.ageMode === "adminLegacyText") {
    return validateLegacyPetAge(value, options);
  }

  return validateStringEnum(value, options, publicPetAgeSet, "forms:fields.petAge");
}

export function petAgeFieldSchema(options: PetAgeFieldOptions = {}): FieldSchema<string> {
  return enumFieldSchema(validatePetAgeField, options);
}

export function validatePetWeightKgField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<number | null> {
  const mode = resolveFieldMode(options.mode);
  const required = options.required ?? false;
  const weight = normalizeWeight(value);
  const issues: FieldValidationIssue[] = [];

  if (weight === null && required) {
    issues.push(fieldIssue("required", "forms:fields.petWeight.required", mode));
  } else if (weight !== null && (weight <= 0 || weight > 120)) {
    issues.push(fieldIssue("invalid", "forms:fields.petWeight.invalid", mode));
  }

  return makeFieldResult(weight, issues);
}

export function petWeightKgFieldSchema(
  options: FieldValidationOptions = {},
): FieldSchema<number | null> {
  return z
    .unknown()
    .transform((value) => validatePetWeightKgField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

export function poundsToKilograms(pounds: number): number {
  return roundPetWeight(pounds * kilogramsPerPound);
}

export function kilogramsToPounds(kilograms: number): number {
  return roundPetWeight(kilograms / kilogramsPerPound);
}

function validateLegacyPetAge(
  value: unknown,
  options: FieldValidationOptions,
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const age = normalizeText(value).replace(/\s+/g, " ");
  const issues: FieldValidationIssue[] = [];

  if (!age && required) {
    issues.push(fieldIssue("required", "forms:fields.petAge.required", mode));
  } else if (age.length > 80) {
    issues.push(fieldIssue("too_long", "forms:fields.petAge.tooLong", mode));
  }

  return makeFieldResult(age, issues);
}

function validateStringEnum(
  value: unknown,
  options: FieldValidationOptions,
  allowed: Set<string>,
  keyPrefix: string,
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const normalized = normalizeText(value).toLowerCase();
  const issues: FieldValidationIssue[] = [];

  if (!normalized && required) {
    issues.push(fieldIssue("required", `${keyPrefix}.required`, mode));
  } else if (normalized && !allowed.has(normalized)) {
    issues.push(fieldIssue("invalid", `${keyPrefix}.invalid`, mode));
  }

  return makeFieldResult(normalized, issues);
}

function enumFieldSchema(
  validate: (value: unknown, options: FieldValidationOptions) => FieldValidationResult<string>,
  options: FieldValidationOptions,
): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validate(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

function normalizeWeight(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = normalizeText(value).replace(",", ".");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPetWeight(value: number): number {
  return Math.round(value * 100) / 100;
}
