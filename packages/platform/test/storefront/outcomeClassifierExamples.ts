import {
  ASYNC_CHECKOUT_STATUSES,
  checkoutActivationStatusSchema,
  subscriptionActivationStatusSchema,
} from "../../src/commerce/index.js";
import type { SubmitOutcomeClass } from "../../src/storefront/index.js";

/**
 * Example `SubmitOutcomeClassifier`s for the two answer shapes this repository
 * has: the checkout and payment-status answers of `@openlup/platform/commerce`,
 * and the neutral starter's action-result envelope. They are test support, not
 * a contract: a host writes its own classifier for its own transport.
 *
 * Each reads only the fields it needs, so a field the server adds later does
 * not change the class, and answers `unknown` for anything it does not
 * recognize. None of them answers `closed` unless the answer itself says that
 * the purchase is terminal and no payment under it can still settle.
 */

type AsyncCheckoutStatus = (typeof ASYNC_CHECKOUT_STATUSES)[number];
type AnswerRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnswerRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasClientAction(answer: AnswerRecord): boolean {
  // A checkout answer carries `clientAction`; a payment-status answer carries `nextAction`.
  const action = answer.clientAction !== undefined ? answer.clientAction : answer.nextAction;
  return isRecord(action) && typeof action.kind === "string" && action.kind !== "none";
}

const actionOrWait = (answer: AnswerRecord): SubmitOutcomeClass => hasClientAction(answer) ? "needs_client_action" : "awaiting_authority";

const COMMERCE_CLASSES: { readonly [status in AsyncCheckoutStatus]: (answer: AnswerRecord) => SubmitOutcomeClass } = {
  paid: () => "settled",
  requires_action: actionOrWait,
  pending_provider_action: actionOrWait,
  processing: () => "awaiting_authority",
  // The payment attempt ended; the order stays payable under a new attempt.
  failed: () => "declined",
  expired: () => "declined",
};

/**
 * Classifies a commerce checkout answer or payment-status answer by its
 * `status` and its action. The commerce answers carry no status that says the
 * key is finished, so this classifier never answers `closed`.
 */
export function classifyCheckoutAnswer(answer: unknown): SubmitOutcomeClass {
  if (!isRecord(answer) || typeof answer.status !== "string") return "unknown";
  if (answer.status === "price_changed") return "refused";
  if (!(ASYNC_CHECKOUT_STATUSES as readonly string[]).includes(answer.status)) return "unknown";
  return COMMERCE_CLASSES[answer.status as AsyncCheckoutStatus](answer);
}

/** Activation states after which nothing about the subscription is still pending. */
const ACTIVATION_SETTLED: readonly string[] = [
  checkoutActivationStatusSchema.enum.not_applicable,
  checkoutActivationStatusSchema.enum.activated,
  subscriptionActivationStatusSchema.enum.active,
];

/**
 * Whether a paid answer still waits for its subscription to activate. It reads
 * `subscriptionActivation.status` on a payment-status answer, or
 * `subscription.activationStatus` on a checkout answer. An answer that carries
 * neither field is not pending; an activation state this module does not know
 * is pending.
 */
export function checkoutActivationPending(answer: unknown): boolean {
  if (!isRecord(answer)) return false;
  const status = isRecord(answer.subscriptionActivation) ? answer.subscriptionActivation.status
    : isRecord(answer.subscription) ? answer.subscription.activationStatus : undefined;
  if (status === undefined) return false;
  return typeof status !== "string" || !ACTIVATION_SETTLED.includes(status);
}

/**
 * Refusal codes the starter answers before it creates anything, so the buyer
 * can correct the input. Every other refusal code is `unknown`.
 */
const STARTER_INPUT_REFUSALS: readonly string[] = ["starter_input_invalid", "starter_email_invalid"];

const STARTER_ATTEMPT_CLASSES: ReadonlyMap<unknown, SubmitOutcomeClass> = new Map<unknown, SubmitOutcomeClass>([
  [undefined, "needs_client_action"],
  [null, "needs_client_action"],
  ["refused", "declined"],
  ["dispatched", "awaiting_authority"],
  ["indeterminate", "awaiting_authority"],
]);

/**
 * Classifies the neutral starter's action-result envelope. `value.attemptState`
 * is not a field of one starter action: a host binding builds it from the
 * starter's payment inspection. `cancelled` is the only order status that says
 * the purchase is terminal with nothing left to settle. An expired order, and
 * the refusals that report an expired or not payable checkout, do not say
 * whether a payment under the key can still settle, so they are `unknown`.
 */
export function classifyStarterAnswer(answer: unknown): SubmitOutcomeClass {
  if (!isRecord(answer)) return "unknown";
  if (answer.ok === false) {
    return typeof answer.code === "string" && STARTER_INPUT_REFUSALS.includes(answer.code) ? "refused" : "unknown";
  }
  if (answer.ok !== true || !isRecord(answer.value)) return "unknown";
  const value = answer.value;
  if (value.status === "paid") return "settled";
  if (value.status === "pending_payment") return STARTER_ATTEMPT_CLASSES.get(value.attemptState) ?? "unknown";
  if (value.status === "cancelled") return "closed";
  return "unknown";
}
