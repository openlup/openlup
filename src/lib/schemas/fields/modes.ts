import { z } from "../../validation/zod.js";

export const fieldValidationModes = [
  "strictSubmit",
  "legacyPermissive",
  "warningOnly",
] as const;

export type FieldValidationMode = (typeof fieldValidationModes)[number];
export type FieldIssueSeverity = "error" | "warning";

export interface FieldValidationIssue {
  code: string;
  messageKey: string;
  severity: FieldIssueSeverity;
}

export interface FieldValidationResult<T> {
  success: boolean;
  value: T;
  issues: FieldValidationIssue[];
  errors: FieldValidationIssue[];
  warnings: FieldValidationIssue[];
}

export interface FieldValidationOptions {
  mode?: FieldValidationMode;
  required?: boolean;
}

export type FieldSchema<T> = z.ZodType<T, unknown>;

export function resolveFieldMode(mode: FieldValidationMode | undefined): FieldValidationMode {
  return mode ?? "strictSubmit";
}

export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function optionalByDefault(required: boolean | undefined): boolean {
  return required ?? true;
}

export function fieldIssue(
  code: string,
  messageKey: string,
  mode: FieldValidationMode,
  strictSeverity: FieldIssueSeverity = "error",
): FieldValidationIssue {
  const severity =
    mode === "warningOnly"
      ? "warning"
      : mode === "legacyPermissive" && strictSeverity === "error"
        ? "warning"
        : strictSeverity;

  return { code, messageKey, severity };
}

export function makeFieldResult<T>(
  value: T,
  issues: FieldValidationIssue[],
): FieldValidationResult<T> {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return {
    success: errors.length === 0,
    value,
    issues,
    errors,
    warnings,
  };
}

export function applyBlockingIssues(
  ctx: z.RefinementCtx,
  issues: FieldValidationIssue[],
): void {
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.messageKey,
    });
  }
}
