export const PREVIEW_FULFILLMENT_HANDOFF_OPERATIONS = [
  "created",
  "label_created",
  "handed_over",
] as const;

export type PreviewFulfillmentHandoffOperation =
  (typeof PREVIEW_FULFILLMENT_HANDOFF_OPERATIONS)[number];

export type PreviewFulfillmentProviderMode = "preview_mock" | "shadow" | "stage" | "live";

export type PreviewFulfillmentHandoffProofInput = {
  paymentProviderScope: readonly ["stripe"];
  capturedAt: string;
  previewHost: string;
  order: {
    orderId: string;
    paymentStatus: string;
    paymentIntentStatus: string;
    paymentProvider: "stripe";
    providerPaymentId: string;
    browserReturnAppliedPaymentResult?: boolean;
  };
  fulfillment: {
    fulfillmentOrderId: string;
    status: string;
    providerKind: "noop_shipping" | "omnipack";
    providerMode: PreviewFulfillmentProviderMode;
    providerTrackingId?: string | null;
    shipmentExternalRefActive: boolean;
    operations: readonly PreviewFulfillmentHandoffOperation[];
    createReplayReturnedSameFulfillmentOrder: boolean;
    handoffReplayConsumedMovementCount: number;
  };
  inventory: {
    reservationStatusBeforeLabel: "reserved" | "released" | "consumed" | "expired" | "missing";
    reservationStatusAfterLabel: "reserved" | "released" | "consumed" | "expired" | "missing";
    reservationStatusAfterHandoff: "reserved" | "released" | "consumed" | "expired" | "missing";
    reservationConsumedMovementCount: number;
  };
  previewMock?: {
    providerKind: "noop_shipping";
    previewOnly: boolean;
    marker: string;
    rawProviderPayloadSanitized: boolean;
  } | null;
  omnipack?: {
    dispatchMode: "shadow" | "stage" | "live";
    dispatchRefId?: string | null;
    providerOrderId?: string | null;
    requestSanitized: boolean;
    responseSanitized: boolean;
  } | null;
  guardrails: {
    failedPaymentCreateRejected: boolean;
    missingReservationCreateRejected: boolean;
  };
  notes?: string | null;
};

export type PreviewFulfillmentHandoffProofDecision = {
  readyForAccountingPreviewFulfillmentProof: boolean;
  reasons: string[];
  evidenceSummary: {
    orderId: string;
    fulfillmentOrderId: string;
    providerKind: "noop_shipping" | "omnipack";
    providerMode: PreviewFulfillmentProviderMode;
    trackingEvidence: string | null;
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9_]+$/;
const SECRET_SHAPE_RE =
  /(sk_(?:test|live)_[A-Za-z0-9_]+|rk_(?:test|live)_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|\b(?:api[_-]?key|apiKey|auth[_-]?token|authToken|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|secret[_-]?key|secretKey)\b|client_secret|clientSecret|authorization:\s*bearer|bearer\s+[A-Za-z0-9._-]+|token\s*[:=])/i;

export function evaluatePreviewFulfillmentHandoffProof(
  input: PreviewFulfillmentHandoffProofInput,
): PreviewFulfillmentHandoffProofDecision {
  const reasons: string[] = [];

  if (input.paymentProviderScope.length !== 1 || input.paymentProviderScope[0] !== "stripe") {
    reasons.push("paymentProviderScope must be exactly [\"stripe\"]");
  }
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    reasons.push("capturedAt must be an ISO-compatible timestamp");
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+/.test(input.previewHost)) {
    reasons.push("previewHost must be an https preview host");
  }
  if (containsSecretShape(input)) reasons.push("proof payload contains secret-shaped data");

  validateOrder(input, reasons);
  validateFulfillment(input, reasons);
  validateInventory(input, reasons);
  validateProviderEvidence(input, reasons);
  validateGuardrails(input, reasons);

  return {
    readyForAccountingPreviewFulfillmentProof: reasons.length === 0,
    reasons,
    evidenceSummary: {
      orderId: input.order.orderId,
      fulfillmentOrderId: input.fulfillment.fulfillmentOrderId,
      providerKind: input.fulfillment.providerKind,
      providerMode: input.fulfillment.providerMode,
      trackingEvidence: input.fulfillment.providerTrackingId ?? null,
    },
  };
}

function validateOrder(input: PreviewFulfillmentHandoffProofInput, reasons: string[]): void {
  if (!UUID_RE.test(input.order.orderId)) reasons.push("orderId must be a UUID");
  if (input.order.paymentProvider !== "stripe") reasons.push("payment provider must be stripe");
  if (!STRIPE_PAYMENT_INTENT_RE.test(input.order.providerPaymentId)) {
    reasons.push("providerPaymentId must be a Stripe pi_* id");
  }
  if (!["paid", "succeeded"].includes(input.order.paymentStatus)) {
    reasons.push("order payment status must be paid/succeeded before fulfillment");
  }
  if (input.order.paymentIntentStatus !== "succeeded") {
    reasons.push("payment intent must be succeeded before fulfillment");
  }
  if (input.order.browserReturnAppliedPaymentResult === true) {
    reasons.push("browser return must not be payment proof for fulfillment");
  }
}

function validateFulfillment(input: PreviewFulfillmentHandoffProofInput, reasons: string[]): void {
  if (!UUID_RE.test(input.fulfillment.fulfillmentOrderId)) {
    reasons.push("fulfillmentOrderId must be a UUID");
  }
  if (input.fulfillment.status !== "handed_over") {
    reasons.push("fulfillment status must be handed_over");
  }
  for (const operation of PREVIEW_FULFILLMENT_HANDOFF_OPERATIONS) {
    if (!input.fulfillment.operations.includes(operation)) {
      reasons.push(`fulfillment operation missing: ${operation}`);
    }
  }
  if (!input.fulfillment.providerTrackingId?.trim()) {
    reasons.push("provider tracking id is required");
  }
  if (input.fulfillment.shipmentExternalRefActive !== true) {
    reasons.push("active shipment external ref read-back is required");
  }
  if (input.fulfillment.createReplayReturnedSameFulfillmentOrder !== true) {
    reasons.push("create idempotency replay must return the same fulfillment order");
  }
  if (input.fulfillment.handoffReplayConsumedMovementCount !== 1) {
    reasons.push("handoff replay must not consume inventory twice");
  }
  if (input.fulfillment.providerMode === "live") {
    reasons.push("live fulfillment provider evidence is out of scope for hidden preview");
  }
}

function validateInventory(input: PreviewFulfillmentHandoffProofInput, reasons: string[]): void {
  if (input.inventory.reservationStatusBeforeLabel !== "reserved") {
    reasons.push("inventory reservation must be reserved before label creation");
  }
  if (input.inventory.reservationStatusAfterLabel !== "reserved") {
    reasons.push("label creation must not consume inventory");
  }
  if (input.inventory.reservationStatusAfterHandoff !== "consumed") {
    reasons.push("handoff must consume the inventory reservation");
  }
  if (input.inventory.reservationConsumedMovementCount !== 1) {
    reasons.push("inventory must be consumed exactly once");
  }
}

function validateProviderEvidence(input: PreviewFulfillmentHandoffProofInput, reasons: string[]): void {
  if (input.fulfillment.providerKind === "noop_shipping") {
    if (input.fulfillment.providerMode !== "preview_mock") {
      reasons.push("noop_shipping evidence must be marked preview_mock");
    }
    if (input.previewMock?.providerKind !== "noop_shipping") {
      reasons.push("noop_shipping requires explicit preview mock evidence");
    }
    if (input.previewMock && input.previewMock.previewOnly !== true) {
      reasons.push("preview mock evidence must be marked previewOnly");
    }
    if (input.previewMock && !input.previewMock.marker.trim()) {
      reasons.push("preview mock marker is required");
    }
    if (input.previewMock && input.previewMock.rawProviderPayloadSanitized !== true) {
      reasons.push("preview mock provider payload must be sanitized");
    }
    return;
  }

  if (input.fulfillment.providerMode !== "shadow" && input.fulfillment.providerMode !== "stage") {
    reasons.push("omnipack evidence must be shadow or stage mode");
  }
  if (!input.omnipack) {
    reasons.push("omnipack dispatch evidence is required");
    return;
  }
  if (input.omnipack.dispatchMode === "live") {
    reasons.push("omnipack live dispatch is out of scope for hidden preview");
  }
  if (input.omnipack.dispatchMode !== input.fulfillment.providerMode) {
    reasons.push("omnipack dispatch mode must match fulfillment provider mode");
  }
  if (!input.omnipack.dispatchRefId && !input.omnipack.providerOrderId?.trim()) {
    reasons.push("omnipack dispatch reference or provider order id is required");
  }
  if (input.omnipack.dispatchRefId && !UUID_RE.test(input.omnipack.dispatchRefId)) {
    reasons.push("omnipack dispatchRefId must be a UUID");
  }
  if (input.omnipack.requestSanitized !== true || input.omnipack.responseSanitized !== true) {
    reasons.push("omnipack request and response evidence must be sanitized");
  }
}

function validateGuardrails(input: PreviewFulfillmentHandoffProofInput, reasons: string[]): void {
  if (input.guardrails.failedPaymentCreateRejected !== true) {
    reasons.push("failed-payment create rejection proof is required");
  }
  if (input.guardrails.missingReservationCreateRejected !== true) {
    reasons.push("missing-reservation create rejection proof is required");
  }
}

function containsSecretShape(value: unknown): boolean {
  if (typeof value === "string") return SECRET_SHAPE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsSecretShape);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    SECRET_SHAPE_RE.test(key) || containsSecretShape(nested),
  );
}
