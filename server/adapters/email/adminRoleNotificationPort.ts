import { button, heading, paragraph } from "../../../src/domains/communications/email/blocks.js";
import { emailPresentation } from "../../../src/domains/communications/email/deploymentEmailPresentation.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import type { AdminRoleNotificationPort, AdminRoleNotificationSkipReason } from "../../domains/platform/inviteAdminUserUseCase.js";
import {
  classifyEmailSendOutcome,
  type EmailSendOutcome,
  type EmailSendResult,
  type EmailTransport,
} from "../../infra/email/emailTransport.js";
import {
  EMAIL_NOTIFICATION_ADMIN_DISABLED,
  createEmailNotificationControlPort as createNotificationControl,
} from "../../infra/email/emailNotificationControl.js";
import { buildEmailOriginMetadata, withEmailOriginMetadata } from "../../infra/resend/emailOriginMetadata.js";
import {
  recordEmailDeliveryTimeline,
  type EmailDeliveryTimelineClient,
} from "../resend/emailDeliveryTimeline.js";
import { logEmailLedgerInsertFailure } from "../resend/emailLedgerLog.js";

export const ADMIN_ROLE_NOTIFICATION_SOURCE = "invite-admin-user";
export const ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG = "admin-user-role-granted";

type RoleNotificationOutcome = EmailSendOutcome & { adminDisabled?: boolean };
type RoleNotificationResult = Omit<EmailSendResult, "outcome"> & { outcome: RoleNotificationOutcome };

interface AdminRoleNotificationQuery {
  select(columns: string): AdminRoleNotificationQuery;
  eq(column: string, value: unknown): AdminRoleNotificationQuery;
  maybeSingle(): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  insert(row: Record<string, unknown>):
    | PromiseLike<{ error: unknown }>
    | {
      select(columns: "id"): {
        maybeSingle(): PromiseLike<{ data: { id?: string } | null; error: unknown }>;
      };
    };
}

export interface AdminRoleNotificationClient extends EmailDeliveryTimelineClient {
  from(table: string): AdminRoleNotificationQuery;
}

export function createAdminRoleNotificationPort(input: {
  client: AdminRoleNotificationClient;
  transport: EmailTransport;
  fromEmail: string;
  siteUrl: string;
  emailOriginSource?: string | null;
  emailEnvironment?: string | null;
}): AdminRoleNotificationPort {
  const { client, fromEmail, siteUrl, transport } = input;
  const originMetadata = buildEmailOriginMetadata({
    baseUrl: siteUrl,
    originSource: input.emailOriginSource,
    environment: input.emailEnvironment,
  });
  const notificationControl = createNotificationControl(client);

  return {
    async sendRoleGranted(notification) {
      const rendered = renderRoleGrantedEmail(notification.role, notification.locale, siteUrl);
      const dedupeKey = `${ADMIN_ROLE_NOTIFICATION_SOURCE}:role-granted:${notification.authUserId}`;
      const enabled = await notificationControl.isEnabled(
        ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG,
        new AbortController().signal,
      );
      const result: RoleNotificationResult = enabled
        ? await transport.send({
          from: fromEmail,
          to: notification.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          idempotencyKey: dedupeKey,
        })
        : skippedResult();
      const providerMessageId = result.outcome.resendId;
      const projected = classifyEmailSendOutcome(result.outcome);
      const skipReason = projected.skipReason;

      await logRoleGrantedAttempt({
        client,
        result,
        providerMessageId,
        skipReason,
        dedupeKey,
        authUserId: notification.authUserId,
        email: notification.email,
        role: notification.role,
        originMetadata,
        providerKind: transport.providerKind,
      });

      return {
        ok: result.outcome.ok,
        providerMessageId,
        providerError: result.outcome.providerError,
        skipped: skipReason !== null,
        skipReason,
      };
    },
  };
}

function renderRoleGrantedEmail(
  role: "admin" | "distributor",
  locale: Parameters<AdminRoleNotificationPort["sendRoleGranted"]>[0]["locale"],
  siteUrl: string,
) {
  const localizedRoleName = roleLabel(role);
  const roleEn = role === "admin" ? "Admin" : "Distributor";
  const copyBrandName = emailPresentation.brand.email.copyBrandName;
  return renderEmail({
    brand: emailPresentation.emailBrandForOrigin(siteUrl),
    locale,
    subject: `Dostęp do panelu ${copyBrandName}: ${localizedRoleName}`,
    preheader: `Nadano Ci rolę ${localizedRoleName} w panelu ${copyBrandName}.`,
    blocks: [
      heading(`Dostęp do panelu ${copyBrandName}`),
      paragraph(`Nadano Ci rolę: ${localizedRoleName}. Możesz zalogować się do panelu ${copyBrandName} przyciskiem poniżej.`),
      paragraph(`You've been granted this ${copyBrandName} admin-panel role: ${roleEn}. Use the button below to sign in.`),
      button("Otwórz panel / Open admin panel", `${siteUrl}/admin`),
      paragraph(`Jeśli nie spodziewałeś się tego dostępu, skontaktuj się z zespołem ${copyBrandName}.`, { muted: true }),
    ],
  });
}

function skippedResult(): RoleNotificationResult {
  return {
    outcome: {
      ok: true,
      resendId: null,
      httpStatus: 0,
      providerError: null,
      aborted: false,
      adminDisabled: true,
    },
    providerResponse: { skipped: EMAIL_NOTIFICATION_ADMIN_DISABLED },
  };
}

async function logRoleGrantedAttempt(input: {
  client: AdminRoleNotificationClient;
  result: RoleNotificationResult;
  providerMessageId: string | null;
  skipReason: AdminRoleNotificationSkipReason | null;
  dedupeKey: string;
  authUserId: string;
  email: string;
  role: "admin" | "distributor";
  originMetadata: Record<string, string>;
  providerKind: string;
}): Promise<void> {
  const projected = classifyEmailSendOutcome(input.result.outcome);
  const status = projected.timelineStatus;
  const recordTimeline = (emailSendId: string | null) => recordEmailDeliveryTimeline(input.client, {
    dedupeKey: input.dedupeKey,
    templateSlug: ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG,
    purpose: "admin_notification",
    triggerSource: ADMIN_ROLE_NOTIFICATION_SOURCE,
    triggerEvent: "admin_user_role_granted",
    status,
    recipientEmail: input.email,
    authUserId: input.authUserId,
    aggregateType: "admin_user",
    aggregateId: input.authUserId,
    emailSendId,
    providerKind: input.providerKind,
    providerMessageId: input.providerMessageId,
    lastErrorCode: projected.lastErrorCode,
    metadata: { role: input.role },
  }, {
    required: false,
    context: `${ADMIN_ROLE_NOTIFICATION_SOURCE}:${ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG}`,
  });

  const sendAttemptId = await recordTimeline(null);
  const emailSendId = await writeEmailSend(input, sendAttemptId);
  if (sendAttemptId && emailSendId) {
    await recordTimeline(emailSendId);
  } else if (!sendAttemptId) {
    await recordTimeline(emailSendId);
  }
}

async function writeEmailSend(
  input: Parameters<typeof logRoleGrantedAttempt>[0],
  sendAttemptId: string | null,
): Promise<string | null> {
  const projected = classifyEmailSendOutcome(input.result.outcome);
  try {
    const result = input.client.from("email_sends").insert({
      tester_id: null,
      template_slug: ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG,
      source: ADMIN_ROLE_NOTIFICATION_SOURCE,
      resend_id: input.providerMessageId,
      status: projected.ledgerStatus,
      sent_at: projected.sentAtEligible ? new Date().toISOString() : null,
      provider_error: input.result.outcome.providerError,
      provider_response: withEmailOriginMetadata(input.result.providerResponse, input.originMetadata, {
        role: input.role,
        adminUserId: input.authUserId,
        ...(sendAttemptId ? { sendAttemptId } : { sendAttemptLink: "timeline_unavailable" }),
      }),
    });
    if (hasInsertSelect(result)) {
      const selected = await result.select("id").maybeSingle();
      if (selected.error) {
        logEmailLedgerInsertFailure({
          source: ADMIN_ROLE_NOTIFICATION_SOURCE,
          templateSlug: ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG,
          error: selected.error,
        });
        return null;
      }
      return typeof selected.data?.id === "string" && selected.data.id ? selected.data.id : null;
    }
    const awaited = await result;
    if (awaited.error) {
      logEmailLedgerInsertFailure({
        source: ADMIN_ROLE_NOTIFICATION_SOURCE,
        templateSlug: ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG,
        error: awaited.error,
      });
    }
  } catch (error) {
    logEmailLedgerInsertFailure({
      source: ADMIN_ROLE_NOTIFICATION_SOURCE,
      templateSlug: ADMIN_ROLE_NOTIFICATION_TEMPLATE_SLUG,
      error,
    });
  }
  return null;
}

function hasInsertSelect(value: ReturnType<AdminRoleNotificationQuery["insert"]>): value is Extract<
  ReturnType<AdminRoleNotificationQuery["insert"]>,
  { select(columns: "id"): unknown }
> {
  return typeof value === "object" && value !== null && "select" in value && typeof value.select === "function";
}

function roleLabel(role: "admin" | "distributor"): string {
  return role === "admin" ? "Admin" : "Dystrybutor";
}
