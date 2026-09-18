import { createHash } from "node:crypto";
import type { PartnersB2BInquirySubmitRequest } from "../../../src/domains/partners/contracts.js";
import { isFreeEmailDomain } from "../../../src/lib/schemas/fields/identity.js";
import type { PublicIntakeDeliveryMessage, PublicIntakeDeliveryPort } from "../communications/ports.js";

const B2B_SPECIFIC_BLOCKED_EMAIL_DOMAINS = new Set([
  "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es", "hotmail.co.uk",
  "mail.com", "mail.ru", "gmx.com", "gmx.net", "gmx.de", "yandex.com", "yandex.ru", "tlen.pl",
]);

const HIDDEN_PREVIEW_APPROVED_TEST_EMAILS = new Set(["operator@example.invalid", "delivered@resend.dev"]);

export interface ManagedB2BInquiryGateway {
  submit(input: {
    ipHash: string;
    request: PartnersB2BInquirySubmitRequest;
  }): Promise<{ kind: "accepted"; id: string } | { kind: "rate_limited" } | { kind: "unavailable" }>;
}

export interface ManagedB2BInquiryPresenter {
  present(input: {
    request: PartnersB2BInquirySubmitRequest;
    sourceId: string;
    notificationTo: string[];
  }):
    | { ok: true; confirmation: Omit<PublicIntakeDeliveryMessage, "to">; notification: Omit<PublicIntakeDeliveryMessage, "to"> }
    | { ok: false; error: string };
}

export interface ManagedB2BInquirySubmitDeps {
  gateway: ManagedB2BInquiryGateway;
  delivery: PublicIntakeDeliveryPort;
  notificationTo: string[];
  presenter: ManagedB2BInquiryPresenter;
  hiddenPreviewEnabled?: boolean;
  hashIp?: (value: string) => Promise<string>;
}

export function createManagedB2BInquirySubmit(deps: ManagedB2BInquirySubmitDeps) {
  const hashIp = deps.hashIp ?? (async (value) => createHash("sha256").update(value).digest("hex"));
  return async (request: PartnersB2BInquirySubmitRequest, headers?: Headers, honeypotFilled = false) => {
    try {
      if (honeypotFilled) return { success: true, status: 200 };
      if (invalidRequest(request, deps.hiddenPreviewEnabled)) {
        return { success: false, status: 400, error: invalidRequest(request, deps.hiddenPreviewEnabled)!, code: "validation_error" };
      }
      const submitted = await deps.gateway.submit({ ipHash: await hashIp(readIp(headers)), request });
      if (submitted.kind === "unavailable") return unavailable();
      if (submitted.kind === "rate_limited") return { success: false, status: 429, error: "rate_limit", code: "rate_limit" };

      const email = request.email.trim().toLowerCase();
      const sourceId = submitted.id;
      const confirmationPolicy = await deps.delivery.evaluatePolicy({
        email,
        purpose: "transactional",
        source: "send-b2b-inquiry",
        recipientKind: "external_contact",
        sourceTable: "b2b_inquiries",
        sourceId,
        metadata: { template_slug: "b2b_confirmation" },
      });
      const notificationPolicies = await Promise.all(deps.notificationTo.map((recipient, index) =>
        deps.delivery.evaluatePolicy({
          email: recipient,
          purpose: "admin_notification",
          source: "send-b2b-inquiry-admin-notification",
          recipientKind: "admin_internal",
          sourceTable: "b2b_inquiries",
          sourceId,
          metadata: {
            template_slug: "b2b_admin_notification",
            recipient_count: deps.notificationTo.length,
            recipient_index: index,
          },
        }),
      ));
      if (!confirmationPolicy.allowed && !notificationPolicies.some((policy) => policy.allowed)) {
        return { success: true, id: sourceId, skipped: "policy_blocked", status: 200 };
      }

      const presentation = deps.presenter.present({ request, sourceId, notificationTo: deps.notificationTo });
      if (presentation.ok === false) return { success: false, status: 500, error: presentation.error, code: "email_origin_error" };
      const sends: Promise<void>[] = [];
      if (confirmationPolicy.allowed) {
        sends.push(deliver(deps, {
          source: "send-b2b-inquiry",
          templateSlug: "b2b_confirmation",
          policyDecisionId: confirmationPolicy.decisionId,
          recipient: email,
          message: { ...presentation.confirmation, to: email },
          dedupeKey: `b2b_confirmation:${sourceId}`,
          triggerEvent: "b2b_inquiry_created",
          aggregateId: sourceId,
          metadata: { policyReason: confirmationPolicy.reason },
        }));
      }
      if (notificationPolicies.length > 0) {
        for (const [index, recipient] of deps.notificationTo.entries()) {
          const policy = notificationPolicies[index]!;
          if (!policy.allowed) continue;
          sends.push(deliver(deps, {
            source: "send-b2b-inquiry-admin-notification",
            templateSlug: "b2b_admin_notification",
            policyDecisionId: policy.decisionId,
            recipient,
            message: { ...presentation.notification, to: recipient },
            dedupeKey: `b2b_admin_notification:${sourceId}:${index}`,
            triggerEvent: "b2b_inquiry_created",
            aggregateId: sourceId,
            metadata: { recipientCount: deps.notificationTo.length, inquiryId: sourceId, policyReason: policy.reason },
          }));
        }
      }
      await Promise.all(sends);
      return { success: true, id: sourceId, status: 200 };
    } catch {
      return { success: false, status: 500, error: "internal_error", code: "internal_error" };
    }
  };
}

function unavailable() {
  return { success: false, status: 503, error: "rate_limit_unavailable", code: "rate_limit_unavailable" };
}

function invalidRequest(request: PartnersB2BInquirySubmitRequest, hiddenPreviewEnabled?: boolean): string | null {
  if (!request.company?.trim() || request.company.trim().length < 2 || request.company.length > 100) return "invalid_company";
  if (!request.country?.trim()) return "invalid_country";
  if (!request.firstName?.trim() || request.firstName.trim().length < 2 || request.firstName.length > 50) return "invalid_first_name";
  if (!request.lastName?.trim() || request.lastName.trim().length < 2 || request.lastName.length > 50) return "invalid_last_name";
  const email = request.email?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "invalid_email";
  if ((isFreeEmailDomain(email) || B2B_SPECIFIC_BLOCKED_EMAIL_DOMAINS.has(email.split("@")[1] ?? "")) && !(hiddenPreviewEnabled && HIDDEN_PREVIEW_APPROVED_TEST_EMAILS.has(email))) return "blocked_email_domain";
  if (request.phone && (!/^[+\d\s\-().]+$/.test(request.phone) || request.phone.replace(/\D/g, "").length < 7 || request.phone.replace(/\D/g, "").length > 15)) return "invalid_phone";
  return request.notes && request.notes.length > 1000 ? "invalid_notes" : null;
}

function readIp(headers: Headers | undefined): string {
  return headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || headers?.get("cf-connecting-ip") || "unknown";
}

async function deliver(deps: ManagedB2BInquirySubmitDeps, input: {
  source: string; templateSlug: string; policyDecisionId: string | null; recipient: string;
  message: PublicIntakeDeliveryMessage;
  dedupeKey: string; triggerEvent: string; aggregateId: string; metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await deps.delivery.deliver({
      source: input.source,
      templateSlug: input.templateSlug,
      policyDecisionId: input.policyDecisionId,
      dedupeKey: input.dedupeKey,
      purpose: input.templateSlug === "b2b_confirmation" ? "transactional" : "admin_notification",
      triggerEvent: input.triggerEvent,
      recipientEmail: input.recipient,
      aggregateType: "b2b_inquiry",
      aggregateId: input.aggregateId,
      metadata: input.metadata,
      message: input.message,
    });
  } catch {
    // Delivery and its evidence are best effort after the durable inquiry write.
  }
}
