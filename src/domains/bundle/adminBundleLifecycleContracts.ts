import { z } from "../../lib/validation/zod.js";
import { adminModeFields, idempotencyKeyField } from "../../lib/agent-domain/ruleResult.js";
import { COMMERCE_CONTRACT_VERSION } from "../commerce/types.js";
import { bundleCodeSchema } from "./adminBundleContracts.js";

/**
 * Bundle LIFECYCLE write contracts, kept apart from the structural writes so each
 * file stays well under the source-size cap.
 *
 *   archive     — remove a bundle from sale (status flip, never a hard delete).
 *                 Agent-allowed: it is reversible via restore.
 *   restore     — archived -> draft. Agent-allowed: the target is draft, so
 *                 nothing becomes sellable without a separate human activation.
 *   cloneDraft  — clone any bundle into a NEW draft under a new code. Agent-allowed;
 *                 orchestrated through the same draft upsert, so the audit action
 *                 it records is the draft-upsert one rather than a clone action.
 *   activate    — draft -> active. HUMAN-ONLY.
 *   deactivate  — active -> draft. HUMAN-ONLY.
 *
 * Both publish-state transitions carry a lifecycle marker on the spec, so the MCP
 * generator drops them and the agent surface has no publish button at all.
 */

const adminFields = {
  ...adminModeFields,
  ...idempotencyKeyField,
};

const baseResponseFields = {
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  dryRun: z.boolean(),
  idempotent: z.boolean(),
};

// ── archive (never hard-delete) ──────────────────────────────────────────────
export const archiveBundleRequestSchema = z
  .object({ ...adminFields, code: bundleCodeSchema })
  .strict();

export const archiveBundleResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
});

// ── restore (archived -> draft) ──────────────────────────────────────────────
export const restoreBundleRequestSchema = z
  .object({ ...adminFields, code: bundleCodeSchema })
  .strict();

export const restoreBundleResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
});

// ── clone draft (source -> NEW draft under a new code) ───────────────────────
export const cloneBundleDraftRequestSchema = z
  .object({
    ...adminFields,
    sourceCode: bundleCodeSchema,
    code: bundleCodeSchema,
    title: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const cloneBundleDraftResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
  bundleId: z.string().min(1),
});

// ── activate (publish) — HUMAN-ONLY ──────────────────────────────────────────
export const activateBundleRequestSchema = z
  .object({ ...adminFields, code: bundleCodeSchema })
  .strict();

export const activateBundleResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
});

// ── deactivate (unpublish) — HUMAN-ONLY ──────────────────────────────────────
export const deactivateBundleRequestSchema = z
  .object({ ...adminFields, code: bundleCodeSchema })
  .strict();

export const deactivateBundleResponseSchema = z.object({
  ...baseResponseFields,
  code: bundleCodeSchema,
});

export type ArchiveBundleRequest = z.infer<typeof archiveBundleRequestSchema>;
export type ArchiveBundleResponse = z.infer<typeof archiveBundleResponseSchema>;
export type RestoreBundleRequest = z.infer<typeof restoreBundleRequestSchema>;
export type RestoreBundleResponse = z.infer<typeof restoreBundleResponseSchema>;
export type CloneBundleDraftRequest = z.infer<typeof cloneBundleDraftRequestSchema>;
export type CloneBundleDraftResponse = z.infer<typeof cloneBundleDraftResponseSchema>;
export type ActivateBundleRequest = z.infer<typeof activateBundleRequestSchema>;
export type ActivateBundleResponse = z.infer<typeof activateBundleResponseSchema>;
export type DeactivateBundleRequest = z.infer<typeof deactivateBundleRequestSchema>;
export type DeactivateBundleResponse = z.infer<typeof deactivateBundleResponseSchema>;
