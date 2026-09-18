import { describe, expect, it } from "vitest";
import {
  adminNotificationRecipientsRequestSchema,
  adminNotificationRecipientsResponseSchema,
  adminCommunicationPermissionsReadResponseSchema,
  adminActiveEmailTemplatesResponseSchema,
  adminTesterEmailSendsRequestSchema,
  adminTesterEmailSendsResponseSchema,
  createNotificationRecipientRequestSchema,
  createNotificationRecipientResponseSchema,
  communicationsDeliveryControlMutationSchema,
  communicationsDeliveryOperationsRequestSchema,
  communicationsDeliveryOperationsResponseSchema,
  deleteNotificationRecipientRequestSchema,
  deleteNotificationRecipientResponseSchema,
  emailStatusReadRequestSchema,
  emailStatusReadResponseSchema,
  sendEmailRequestSchema,
  sendEmailResponseSchema,
  updateNotificationRecipientRequestSchema,
  updateNotificationRecipientResponseSchema,
  updateAdminCommunicationPermissionRequestSchema,
} from "./contracts.js";

describe("communications contracts", () => {
  it("validates send-email requests and trims transport-neutral fields", () => {
    expect(
      sendEmailRequestSchema.parse({
        recipientId: " tester-1 ",
        templateSlug: " approved ",
        source: "admin",
      }),
    ).toEqual({
      recipientId: "tester-1",
      templateSlug: "approved",
      source: "admin",
    });
  });

  it("validates admin communication permission read and write contracts", () => {
    expect(
      adminCommunicationPermissionsReadResponseSchema.parse({
        email: "ala@example.com",
        contact: null,
        permissions: [
          {
            purpose: "marketing_newsletter",
            state: "granted",
            source: "legacy_testers_backfill",
            source_ref: { table: "testers", id: "tester-1" },
            reason: null,
            captured_at: "2026-06-13T10:00:00+00:00",
            metadata: {},
            updated_at: "2026-06-13T10:00:00+00:00",
          },
        ],
        links: [],
        events: [],
      }).permissions[0].purpose,
    ).toBe("marketing_newsletter");

    expect(
      updateAdminCommunicationPermissionRequestSchema.safeParse({
        email: "ala@example.com",
        purpose: "marketing_newsletter",
        state: "suppressed",
      }).success,
    ).toBe(false);

    expect(
      updateAdminCommunicationPermissionRequestSchema.parse({
        email: " ala@example.com ",
        purpose: "marketing_launch_offer",
        state: "denied",
        reason: "support request",
      }).email,
    ).toBe("ala@example.com");
  });

  it("rejects malformed send-email requests before provider calls", () => {
    expect(
      sendEmailRequestSchema.safeParse({
        recipientId: "",
        templateSlug: "approved",
      }).success,
    ).toBe(false);
  });

  it("validates send-email response envelopes for sent and skipped messages", () => {
    expect(
      sendEmailResponseSchema.parse({
        message: {
          id: "send-1",
          channel: "email",
          recipientId: "tester-1",
          templateSlug: "approved",
          status: "sent",
          provider: "resend",
          providerMessageId: "resend-1",
          skippedReason: null,
        },
      }).message.providerMessageId,
    ).toBe("resend-1");

    expect(
      sendEmailResponseSchema.parse({
        message: {
          id: "send-2",
          channel: "email",
          recipientId: "tester-1",
          templateSlug: "approved",
          status: "skipped",
          provider: null,
          providerMessageId: null,
          skippedReason: "already_sent",
        },
      }).message.skippedReason,
    ).toBe("already_sent");

  });

  it("rejects inconsistent skipped and sent message envelopes", () => {
    const baseMessage = {
      id: "send-1",
      channel: "email",
      recipientId: "tester-1",
      templateSlug: "approved",
      providerMessageId: null,
    };

    expect(
      sendEmailResponseSchema.safeParse({
        message: {
          ...baseMessage,
          status: "sent",
          provider: "resend",
          skippedReason: "already_sent",
        },
      }).success,
    ).toBe(false);

    expect(
      sendEmailResponseSchema.safeParse({
        message: {
          ...baseMessage,
          status: "skipped",
          provider: "resend",
          skippedReason: "already_sent",
        },
      }).success,
    ).toBe(false);
  });

  it("validates the provider-neutral delivery operations contract", () => {
    expect(communicationsDeliveryOperationsRequestSchema.parse({})).toEqual({
      page: 0,
      pageSize: 25,
    });
    expect(communicationsDeliveryControlMutationSchema.parse({
      action: "set-template",
      templateReference: "receipt.approved:v1",
      controlKey: "transactional.receipt",
      active: true,
    })).toEqual({
      action: "set-template",
      templateReference: "receipt.approved:v1",
      controlKey: "transactional.receipt",
      active: true,
    });
    expect(communicationsDeliveryOperationsResponseSchema.parse({
      operations: [{
        idempotencyKey: "delivery:1",
        templateReference: "receipt.approved:v1",
        recipientFingerprint: "a".repeat(64),
        state: "accepted",
        deliveryReference: "captured:1",
        errorCode: null,
        attemptCount: 1,
        createdAt: "2026-08-13T05:00:00.000Z",
        updatedAt: "2026-08-13T05:00:00.000Z",
      }],
      totalCount: 1,
      controls: [{
        controlKey: "transactional.receipt",
        enabled: true,
        revision: 1,
        updatedAt: "2026-08-13T05:00:00.000Z",
      }],
      templates: [{
        templateReference: "receipt.approved:v1",
        controlKey: "transactional.receipt",
        active: true,
        revision: 1,
        updatedAt: "2026-08-13T05:00:00.000Z",
      }],
      health: { attempted: 1, accepted: 1, failed: 0 },
      readiness: { requiredControlCount: 1, disabledControlKeys: [] },
    }).operations[0].deliveryReference).toBe("captured:1");
  });

  it("validates email status read contracts by local or provider ids", () => {
    expect(
      emailStatusReadRequestSchema.parse({ providerMessageId: "resend-1" }),
    ).toEqual({ providerMessageId: "resend-1" });
    expect(emailStatusReadRequestSchema.safeParse({}).success).toBe(false);

    expect(
      emailStatusReadResponseSchema.parse({
        message: {
          id: "send-1",
          channel: "email",
          recipientId: "tester-1",
          templateSlug: "approved",
          status: "delivered",
          provider: "resend",
          providerMessageId: "resend-1",
          skippedReason: null,
        },
      }).message.status,
    ).toBe("delivered");
  });

  it("validates admin notification recipient contracts", () => {
    expect(
      adminNotificationRecipientsRequestSchema.parse({
        notification_type: "packaging_digest",
      }).notification_type,
    ).toBe("packaging_digest");
    expect(
      adminNotificationRecipientsResponseSchema.parse({
        recipients: [
          {
            id: "rec-1",
            email: "ops@example.com",
            name: null,
            active: true,
            notification_type: "new_signup",
            created_at: "2026-05-31T12:00:00.000Z",
          },
        ],
      }).recipients,
    ).toHaveLength(1);
    expect(
      adminNotificationRecipientsResponseSchema.parse({
        recipients: [
          {
            id: "rec-2",
            email: "ops-2@example.com",
            name: "Ops 2",
            active: true,
            notification_type: "packaging_digest",
            created_at: "2026-05-31T12:00:00+00:00",
          },
        ],
      }).recipients[0].created_at,
    ).toBe("2026-05-31T12:00:00+00:00");
    expect(
      createNotificationRecipientRequestSchema.parse({
        email: " ops@example.com ",
        name: " Ops ",
        notification_type: "new_signup",
        active: true,
      }).email,
    ).toBe("ops@example.com");
    expect(
      createNotificationRecipientResponseSchema.safeParse({
        created: true,
        email: "ops@example.com",
        notification_type: "new_signup",
      }).success,
    ).toBe(true);
    expect(
      updateNotificationRecipientRequestSchema.parse({
        recipientId: " rec-1 ",
        active: false,
      }).recipientId,
    ).toBe("rec-1");
    expect(
      updateNotificationRecipientResponseSchema.safeParse({
        updated: true,
        recipientId: "rec-1",
      }).success,
    ).toBe(true);
    expect(
      deleteNotificationRecipientRequestSchema.parse({ recipientId: " rec-1 " }).recipientId,
    ).toBe("rec-1");
    expect(
      deleteNotificationRecipientResponseSchema.safeParse({
        deleted: true,
        recipientId: "rec-1",
      }).success,
    ).toBe(true);
  });

  it("validates tester detail read contracts", () => {
    expect(
      adminActiveEmailTemplatesResponseSchema.parse({
        templates: [{ slug: "approved", name: "Approved", sequence_order: null }],
      }).templates[0].slug,
    ).toBe("approved");
    expect(
      adminTesterEmailSendsRequestSchema.parse({ testerId: " tester-1 " }),
    ).toEqual({ testerId: "tester-1" });
    expect(
      adminTesterEmailSendsResponseSchema.parse({
        sends: [
          {
            id: "send-1",
            template_slug: null,
            status: "sent",
            sent_at: null,
            events: [
              {
                send_id: "send-1",
                event_type: "open",
                link_url: null,
                timestamp: "2026-05-01T10:00:00Z",
              },
            ],
          },
        ],
      }).sends,
    ).toHaveLength(1);
  });
});
