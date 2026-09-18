import { z } from "../../lib/validation/zod.js";
import {
  customerSubscriptionActionSchema,
  type CustomerSubscriptionActionRequest,
} from "./selfServiceContracts.js";
import {
  subscriptionSelfServiceActionSchema,
  subscriptionPaymentMethodStatusSchema,
  subscriptionRenewalBlockStatusSchema,
  type SubscriptionSelfServiceAction,
  type SubscriptionPaymentMethodStatus,
  type SubscriptionRenewalBlockStatus,
} from "../subscription/contracts.js";
import { commerceMoneySchema } from "../commerce/contracts.js";
import type { CommerceMoney } from "../commerce/types.js";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().trim().min(8).max(180);

// A price DELTA can be negative — a package edit that lowers the recurring price
// yields `newTotal - currentTotal < 0`. `commerceMoneySchema.amountMinor` is
// non-negative, so using it for a delta made the preview handler reject its OWN
// response (INVALID_RESPONSE → 502) on any price-reducing package change (CJ01-R).
// Deltas therefore use a signed money schema; absolute prices stay non-negative.
const signedMoneySchema = commerceMoneySchema.extend({ amountMinor: z.number().int() });

export type CustomerSubscriptionBlockReason =
  | "not_active"
  | "edit_window_closed"
  | "cycle_locked"
  | "payment_blocked"
  | "missing_payment_method"
  | "invalid_address"
  | null;

export interface CustomerSubscriptionPreviewRequest {
  subscriptionAction: CustomerSubscriptionActionRequest | SubscriptionSelfServiceAction;
}

export interface CustomerSubscriptionPreviewResponse {
  preview: {
    subscriptionId: string;
    action: string;
    canApply: boolean;
    blockedReason: CustomerSubscriptionBlockReason;
    nextCycleAt: string | null;
    editCutoffAt: string | null;
    templateVersion: number | null;
    lockedCycle?: {
      locked: boolean;
      status: SubscriptionRenewalBlockStatus | null;
    };
    futureTemplate?: {
      templateVersion: number | null;
      effectiveCycleAt: string | null;
      priceAgreementPolicy: "lock_until_edit";
    };
    paymentMethodStatus?: SubscriptionPaymentMethodStatus;
    deliverability?: {
      status: "address_book_validated" | "blocked" | "unknown";
      blockedReason: CustomerSubscriptionBlockReason;
    };
    catalogAvailability?: {
      status: "available" | "blocked" | "unknown";
      blockedReason: CustomerSubscriptionBlockReason;
    };
    quoteHash?: string;
    quoteExpiresAt?: string;
    currentTotal?: CommerceMoney;
    newTotal?: CommerceMoney;
    delta?: CommerceMoney;
    chargeTiming?: {
      requiresConfirmation: boolean;
      confirmed: boolean;
      earliestChargeAt: string | null;
    };
    dateAvailability?: {
      earliestAllowedAt: string;
      latestAllowedAt: string;
      availableDates: string[];
      blockedReason: CustomerSubscriptionBlockReason;
    };
    packageEdit?: {
      currentRecurringPrice: CommerceMoney;
      newRecurringPrice: CommerceMoney;
      delta: CommerceMoney;
      quoteHash: string;
      effectiveCycleAt: string | null;
      priceAgreementPolicy: "lock_until_edit";
    };
  };
}

export type CustomerPaymentRecoveryStartResponse =
  | {
      recoverable: true;
      recoveryUrlPath: string;
      caseId: string;
      expiresAt: string;
      nextRetryAt: string | null;
    }
  | {
      recoverable: false;
      reason: "no_open_dunning_case" | "subscription_not_found" | "token_issue_failed";
    };

export const customerSubscriptionPreviewRequestSchema = z
  .object({
    subscriptionAction: z.union([customerSubscriptionActionSchema, subscriptionSelfServiceActionSchema]),
  })
  .strict() as unknown as z.ZodType<CustomerSubscriptionPreviewRequest>;

export const customerSubscriptionPreviewResponseSchema = z
  .object({
    preview: z
      .object({
        subscriptionId: uuidSchema,
        action: z.string().min(1).max(80),
        canApply: z.boolean(),
        blockedReason: z
          .enum(["not_active", "edit_window_closed", "cycle_locked", "payment_blocked", "missing_payment_method", "invalid_address"])
          .nullable(),
        nextCycleAt: datetimeSchema.nullable(),
        editCutoffAt: datetimeSchema.nullable(),
        templateVersion: z.number().int().positive().nullable(),
        lockedCycle: z
          .object({
            locked: z.boolean(),
            status: subscriptionRenewalBlockStatusSchema.nullable(),
          })
          .strict()
          .optional(),
        futureTemplate: z
          .object({
            templateVersion: z.number().int().positive().nullable(),
            effectiveCycleAt: datetimeSchema.nullable(),
            priceAgreementPolicy: z.literal("lock_until_edit"),
          })
          .strict()
          .optional(),
        paymentMethodStatus: subscriptionPaymentMethodStatusSchema.optional(),
        deliverability: z
          .object({
            status: z.enum(["address_book_validated", "blocked", "unknown"]),
            blockedReason: z
              .enum(["not_active", "edit_window_closed", "cycle_locked", "payment_blocked", "missing_payment_method", "invalid_address"])
              .nullable(),
          })
          .strict()
          .optional(),
        catalogAvailability: z
          .object({
            status: z.enum(["available", "blocked", "unknown"]),
            blockedReason: z
              .enum(["not_active", "edit_window_closed", "cycle_locked", "payment_blocked", "missing_payment_method", "invalid_address"])
              .nullable(),
          })
          .strict()
          .optional(),
        quoteHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        quoteExpiresAt: datetimeSchema.optional(),
        currentTotal: commerceMoneySchema.optional(),
        newTotal: commerceMoneySchema.optional(),
        delta: signedMoneySchema.optional(),
        chargeTiming: z
          .object({
            requiresConfirmation: z.boolean(),
            confirmed: z.boolean(),
            earliestChargeAt: datetimeSchema.nullable(),
          })
          .strict()
          .optional(),
        dateAvailability: z
          .object({
            earliestAllowedAt: datetimeSchema,
            latestAllowedAt: datetimeSchema,
            availableDates: z.array(datetimeSchema).max(61),
            blockedReason: z
              .enum(["not_active", "edit_window_closed", "cycle_locked", "payment_blocked", "missing_payment_method", "invalid_address"])
              .nullable(),
          })
          .strict()
          .optional(),
        packageEdit: z
          .object({
            currentRecurringPrice: commerceMoneySchema,
            newRecurringPrice: commerceMoneySchema,
            delta: signedMoneySchema,
            quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
            effectiveCycleAt: datetimeSchema.nullable(),
            priceAgreementPolicy: z.literal("lock_until_edit"),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict() as unknown as z.ZodType<CustomerSubscriptionPreviewResponse>;

export const customerPaymentRecoveryStartRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    subscriptionId: uuidSchema,
  })
  .strict();

export const customerPaymentRecoveryStartResponseSchema = z
  .discriminatedUnion("recoverable", [
    z
      .object({
        recoverable: z.literal(true),
        recoveryUrlPath: z.string().trim().min(1).max(500).startsWith("/"),
        caseId: uuidSchema,
        expiresAt: datetimeSchema,
        nextRetryAt: datetimeSchema.nullable(),
      })
      .strict(),
    z
      .object({
        recoverable: z.literal(false),
        reason: z.enum(["no_open_dunning_case", "subscription_not_found", "token_issue_failed"]),
      })
      .strict(),
  ]) as unknown as z.ZodType<CustomerPaymentRecoveryStartResponse>;

export type CustomerPaymentRecoveryStartRequest = z.infer<
  typeof customerPaymentRecoveryStartRequestSchema
>;
