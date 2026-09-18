import { z } from "../../lib/validation/zod.js";

// Generic auth account-reconcile contract — the BFF response that tells the UI
// whether an authenticated principal now has a linked, functional account.
// OSS core: no brand literals, no Supabase types.

export const AUTH_RECONCILE_CONTRACT_VERSION = "auth.reconcile.v1" as const;

export const authReconcileRequestSchema = z.object({}).strict();

/**
 * Successful reconcile payload (the BFF `data` envelope). The authenticated
 * principal now has a linked, functional account.
 *  - `created`: a brand-new empty account was provisioned.
 *  - `linked`: this principal was newly attached to a pre-existing account.
 */
export const authReconcileResponseSchema = z
  .object({
    accountId: z.string().min(1),
    created: z.boolean(),
    linked: z.boolean(),
  })
  .strict();
export type AuthReconcileResponse = z.infer<typeof authReconcileResponseSchema>;

/**
 * Domain failure codes carried in the BFF error `details.code` so the UI can
 * branch (e.g. show the no-email / wrong-method message). Mirrors
 * `ReconcileAccountErrorCode` in `server/domains/auth`.
 */
export const authReconcileErrorCodeSchema = z.enum([
  "NO_VERIFIED_EMAIL",
  "RESERVED_PRINCIPAL_REFUSED",
  "ACCOUNT_LINK_CONFLICT",
  "EMAIL_OWNED_BY_OTHER_PRINCIPAL",
]);
export type AuthReconcileErrorCode = z.infer<typeof authReconcileErrorCodeSchema>;
