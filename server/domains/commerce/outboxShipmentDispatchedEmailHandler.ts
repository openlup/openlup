import { z } from "zod";
import { COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type { OutboxHandler } from "./outboxDispatchContracts.js";
import {
  OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { createTransactionalEmailHandler } from "../../shared/transactionalEmailHandler.js";
import {
  carrierTrackingUrl,
  normalizeCarrierKind,
} from "../../../src/domains/shipping/contracts.js";

export { OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

const trackingReferenceSchema = z
  .object({
    providerKind: z.string().trim().min(1).max(80).nullable().optional(),
    carrierKind: z.string().trim().min(1).max(80).nullable().optional(),
    service: z.string().trim().min(1).max(120).nullable().optional(),
    trackingNumber: z.string().trim().min(1).max(160),
    trackingUrl: z.string().url().max(500).nullable().optional(),
  })
  .strict();

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    providerKind: z.string().trim().min(1).max(80).nullable().optional(),
    carrierKind: z.string().trim().min(1).max(80).nullable().optional(),
    service: z.string().trim().min(1).max(120).nullable().optional(),
    trackingNumber: z.string().trim().min(1).nullable().optional(),
    trackingUrl: z.string().url().max(500).nullable().optional(),
    trackingReferences: z.array(trackingReferenceSchema).max(20).optional(),
  })
  .passthrough();

export function createOutboxShipmentDispatchedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return createTransactionalEmailHandler({
    eventType: COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    templateSlug: OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG,
    schema: payloadSubsetSchema,
    resolveKey: (payload) => payload.orderUuid,
    recipientPort: deps.recipientPort,
    findExistingSend: (slug, id) => deps.emailPort.findExistingSend(slug, id),
    send: ({ payload, recipient, row, signal }) => {
      const tracking = resolveCustomerTracking(payload);
      return deps.emailPort.sendShipmentDispatchedNotice({
        to: recipient.email,
        firstName: recipient.firstName,
        petName: recipient.petName ?? null,
        orderId: payload.orderId,
        trackingNumber: tracking.trackingNumber,
        trackingUrl: tracking.trackingUrl,
        outboxEventId: row.id,
        locale: resolveLocale(recipient.country ?? null),
        signal,
      });
    },
  });
}

function resolveCustomerTracking(payload: z.infer<typeof payloadSubsetSchema>): {
  trackingNumber: string | null;
  trackingUrl: string | null;
} {
  const refs = (payload.trackingReferences ?? []).map((ref) => ({
    providerKind: normalizeKind(ref.providerKind),
    carrierKind: normalizeKind(ref.carrierKind),
    service: ref.service ?? null,
    trackingNumber: ref.trackingNumber,
    trackingUrl: ref.trackingUrl ?? null,
  }));
  const legacyRef = payload.trackingNumber
    ? {
        providerKind: normalizeKind(payload.providerKind),
        carrierKind: normalizeKind(payload.carrierKind),
        service: payload.service ?? null,
        trackingNumber: payload.trackingNumber,
        trackingUrl: payload.trackingUrl ?? null,
      }
    : null;
  const candidates = refs.length > 0 ? refs : legacyRef ? [legacyRef] : [];
  const primary = candidates.find((ref) => ref.trackingUrl) ?? candidates[0] ?? null;
  if (!primary) return { trackingNumber: null, trackingUrl: null };

  // Persisted URL wins; otherwise the shared carrier registry builds one from
  // the carrier kind (older shipment_external_refs rows predate URL persistence).
  // Legacy DHL-direct payloads without any carrier evidence keep their historic
  // DHL default; unknown carriers fall back to a number-only email.
  return {
    trackingNumber: primary.trackingNumber,
    trackingUrl:
      primary.trackingUrl ??
      carrierTrackingUrl(
        normalizeCarrierKind({ carrierKind: primary.carrierKind, service: primary.service }),
        primary.trackingNumber,
      ) ??
      (isDirectDhlTracking(primary, refs.length > 0)
        ? carrierTrackingUrl("dhl", primary.trackingNumber)
        : null),
  };
}

function normalizeKind(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

function isDirectDhlTracking(
  ref: { providerKind: string | null; carrierKind: string | null },
  hasExplicitReferences: boolean,
): boolean {
  if (ref.providerKind === "dhl") return true;
  if (ref.providerKind) return false;
  if (ref.carrierKind) return ref.carrierKind === "dhl";
  return !hasExplicitReferences;
}
