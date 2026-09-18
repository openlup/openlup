import { z } from "../../lib/validation/zod.js";

export const SUPPORT_CUSTOMER_360_CONTRACT_VERSION = "support.customer_360.v2" as const;

/**
 * The wire primitives this contract is built from. They are exported so the
 * command half in ./customerSupportCommandContracts.ts bounds its own ids,
 * timestamps and statuses to exactly these definitions rather than restating
 * them, which is the only way the two halves cannot drift apart. Nothing outside
 * this contract pair should reach for them.
 */
export const idSchema = z.string().trim().min(1).max(160);
export const datetimeSchema = z.string().datetime({ offset: true });
export const nullableDatetimeSchema = datetimeSchema.nullable();
export const statusSchema = z.string().trim().min(1).max(120);
const lookupTextSchema = z.string().trim().min(1).max(320);
/**
 * The free-text parts of a postal address. Deliberately wider than the columns
 * that carry a length check, because the ones that do not (`line1`, `city`,
 * `label`) would otherwise let one long real address fail the whole snapshot.
 */
const addressTextSchema = z.string().trim().min(1).max(320);

export const customer360LifecycleStageSchema = z.enum([
  "lead", "waitlist", "tester", "customer", "inactive",
]);

export const customer360LookupRequestSchema = z.object({
  query: lookupTextSchema.optional(),
  subjectId: idSchema.optional(),
  orderId: idSchema.optional(),
  subscriptionId: idSchema.optional(),
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  pageSize: z.coerce.number().int().positive().max(25).default(10),
  mode: z.enum(["search", "snapshot"]).optional(),
}).strict().refine((value) => Boolean(
  value.query || value.subjectId || value.orderId || value.subscriptionId || value.email,
), "At least one lookup key is required");

export const customer360SubjectSchema = z.object({
  subjectId: idSchema,
  displayName: z.string().trim().min(1).max(240).nullable(),
  email: z.string().email().max(320).nullable(),
  /**
   * The number the fulfillment dispatch payload carries, which is why the card
   * shows it and lets an operator correct it. Optional for the same reason
   * `authUserLinked` is: a lane that cannot resolve it omits the key rather than
   * reporting a null it did not read.
   */
  phone: z.string().trim().max(40).nullable().optional(),
  lifecycleStage: customer360LifecycleStageSchema,
  lifecycle: z.array(z.object({
    stage: customer360LifecycleStageSchema,
    enteredAt: nullableDatetimeSchema,
    exitedAt: nullableDatetimeSchema,
  }).strict()),
  firstSeenAt: nullableDatetimeSchema,
  lastActivityAt: nullableDatetimeSchema,
  /**
   * Two read-only facts that must never be folded into one. `authUserLinked` says a
   * sign-in identity row exists, and checkout mints one for every buyer, so it proves a
   * purchase and not a sign-in; `hasSignedIn` says whether that identity was ever used,
   * and only a present `true` may be reported as a sign-in. Either key is omitted when
   * the lane cannot resolve it: a console that guesses states something false.
   */
  authUserLinked: z.boolean().optional(), hasSignedIn: z.boolean().optional(),
}).strict();

export const customer360OrderSchema = z.object({
  orderId: idSchema,
  orderNumber: z.string().trim().min(1).max(80).nullable(),
  status: statusSchema,
  subscriptionId: idSchema.nullable(),
  totalMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().trim().min(3).max(3).nullable(),
  createdAt: nullableDatetimeSchema,
}).strict();

/**
 * `templateVersion` is optional for the same reason `authUserLinked` is: a lane that
 * cannot resolve it omits the key rather than inventing one. It is the expectation the
 * operator subscription command compares, so a card without it must render the
 * subscription actions disabled instead of sending a guess.
 */
export const customer360SubscriptionSchema = z.object({
  subscriptionId: idSchema,
  status: statusSchema,
  nextCycleAt: nullableDatetimeSchema,
  latestOrderId: idSchema.nullable(),
  templateVersion: z.number().int().min(1).optional(),
  /**
   * Which saved address this subscription's next parcel is routed to. Optional
   * for the same reason `templateVersion` is: a lane that does not read the
   * pointer omits the key, and only a present value may be rendered as "the
   * current address". A present `null` is the positive answer — the subscription
   * carries no address pointer at all.
   */
  shippingAddressId: idSchema.nullable().optional(),
}).strict();

/**
 * One address this subject has saved, in the shape an operator picks from when a
 * subscriber asks for her parcels to go somewhere else.
 *
 * `kind` admits only the two values the shipping rail accepts. A billing-only row
 * is not a shipping destination, and a picker that could offer one would let an
 * operator repoint a subscription at an address the customer never meant to
 * receive a parcel at — so the exclusion is pinned in the contract rather than
 * left to whichever lane happens to filter.
 */
export const customer360AddressSchema = z.object({
  addressId: idSchema,
  label: addressTextSchema.nullable(),
  recipientName: addressTextSchema.nullable(),
  line1: addressTextSchema,
  line2: addressTextSchema.nullable(),
  postalCode: z.string().trim().min(1).max(40),
  city: addressTextSchema,
  country: z.string().trim().min(2).max(3),
  contactPhone: z.string().trim().min(1).max(64).nullable(),
  isDefault: z.boolean(),
  kind: z.enum(["shipping", "both"]),
}).strict();

export const customer360PaymentTruthSchema = z.object({
  orderId: idSchema,
  status: statusSchema,
  recoverable: z.boolean(),
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().trim().min(3).max(3).nullable(),
  lastAttemptAt: nullableDatetimeSchema,
}).strict();

export const customer360DunningCaseSchema = z.object({
  caseId: idSchema,
  subscriptionId: idSchema,
  orderId: idSchema.nullable(),
  status: statusSchema,
  retryAttempt: z.number().int().nonnegative(),
  nextRetryAt: nullableDatetimeSchema,
  notificationStatus: statusSchema.nullable(),
  recoveryAvailable: z.boolean(),
}).strict();

export const customer360RecoverySchema = z.object({
  caseId: idSchema,
  status: z.enum(["available", "unavailable"]),
  actionAvailable: z.boolean(),
  lastIssuedAt: nullableDatetimeSchema,
  lastDeliveryStatus: statusSchema.nullable(),
}).strict();

/**
 * Whether this subject's e-mail address still accepts mail, derived from the
 * delivery evidence already recorded elsewhere. It is a read-only projection:
 * nothing here is written, counted or retried.
 *
 * `reachable` is false only when the newest *terminal* delivery outcome is a
 * failure. Statuses that merely mean "no mail was owed" — a suppressed or
 * blocked send — are not terminal outcomes and never appear here, because
 * treating them as failures is a mistake this repository has already made once.
 * A single failure is enough to light the badge, so no attempt counter exists.
 */
export const customer360ContactHealthSchema = z.object({
  lastTerminalStatus: z.enum(["delivered", "bounced", "complained", "failed"]).nullable(),
  lastTerminalAt: nullableDatetimeSchema,
  reachable: z.boolean(),
}).strict();

export const customer360AuditEventSchema = z.object({
  eventId: idSchema,
  occurredAt: datetimeSchema,
  action: statusSchema,
  outcome: statusSchema,
  entity: z.object({
    kind: z.enum(["subject", "order", "subscription", "dunning_case", "recovery"]),
    id: idSchema,
  }).strict(),
}).strict();

const lookupResultSchema = z.object({
  query: z.string().max(320),
  matchedBy: z.enum(["subject_id", "email", "order_id", "order_number", "subscription_id", "text"]),
  confidence: z.enum(["exact", "high", "medium"]),
  warnings: z.array(z.string().trim().min(1).max(300)),
}).strict();

export const customer360SearchResponseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  query: z.string().max(320),
  candidates: z.array(z.object({
    subjectId: idSchema,
    displayName: z.string().trim().min(1).max(240).nullable(),
    email: z.string().email().max(320).nullable(),
    lifecycleStage: customer360LifecycleStageSchema,
    matchedBy: lookupResultSchema.shape.matchedBy,
    confidence: lookupResultSchema.shape.confidence,
    lastActivityAt: nullableDatetimeSchema,
    snapshotLookup: z.object({ subjectId: idSchema }).strict(),
  }).strict()),
  warnings: z.array(z.string().trim().min(1).max(300)),
}).strict();

export const customer360SnapshotResponseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  lookup: lookupResultSchema,
  subject: customer360SubjectSchema,
  orders: z.array(customer360OrderSchema),
  subscriptions: z.array(customer360SubscriptionSchema),
  payment: z.array(customer360PaymentTruthSchema),
  dunningCases: z.array(customer360DunningCaseSchema),
  recovery: z.array(customer360RecoverySchema),
  auditTrail: z.array(customer360AuditEventSchema),
  /**
   * Optional because not every implementation can answer it: a deployment whose
   * schema carries no e-mail-delivery evidence omits the key rather than
   * asserting a subject is reachable when it simply does not know.
   */
  contactHealth: customer360ContactHealthSchema.optional(),
  /**
   * The shipping addresses this subject has saved, default first and then most
   * recently used, capped at twenty. It exists so an operator changing where the
   * next parcel goes picks from what the subscriber already has instead of
   * retyping it during the call.
   *
   * Optional for the reason `contactHealth` is, and the distinction matters more
   * here: an empty array is the positive statement "this subject has saved none",
   * which a lane that never read the table must not make — an operator told that
   * would take a new address down by hand for a customer who already has one.
   *
   * This rides the detail read only. The search response carries no address at
   * all, which is what keeps a machine actor's candidate list free of them while
   * the audited detail read stays unmasked.
   */
  addresses: z.array(customer360AddressSchema).max(20).optional(),
}).strict();

export type Customer360LifecycleStage = z.infer<typeof customer360LifecycleStageSchema>;
export type Customer360LookupRequest = z.infer<typeof customer360LookupRequestSchema>;
export type Customer360Subject = z.infer<typeof customer360SubjectSchema>;
export type Customer360ContactHealth = z.infer<typeof customer360ContactHealthSchema>;
export type Customer360Address = z.infer<typeof customer360AddressSchema>;
export type Customer360SearchResponse = z.infer<typeof customer360SearchResponseSchema>;
export type Customer360SnapshotResponse = z.infer<typeof customer360SnapshotResponseSchema>;
