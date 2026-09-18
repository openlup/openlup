import { button, dataTable, heading, paragraph } from "../../../src/domains/communications/email/blocks.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import { readEmailOriginConfiguration, resolveEmailOrigin } from "../../../src/domains/communications/email/originPolicy.js";
import type { PartnersB2BInquirySubmitRequest } from "../../../src/domains/partners/contracts.js";
import { APP_PRODUCTION_EMAIL_HOSTS, APP_SITE_ORIGIN, appEmailBrandForOrigin } from "../../../src/lib/brand/appBrand.js";
import type { ManagedB2BInquiryPresenter } from "../../domains/partners/managedB2BInquirySubmit.js";

export interface PrivateLabelB2BInquiryPresentationEnv extends Record<string, string | undefined> {
  FROM_EMAIL?: string;
  APP_BASE_URL?: string;
  openlup_BASE_URL?: string;
  CUSTOMER_AUTH_REDIRECT_ORIGIN?: string;
  SITE_URL?: string;
  HIDDEN_SANDBOX_PREVIEW_ENABLED?: string;
  EMAIL_ENVIRONMENT?: string;
  EMAIL_DEFAULT_ORIGIN?: string;
  EMAIL_PRODUCTION_ORIGIN_HOSTS?: string;
}

export function createPrivateLabelB2BInquiryPresenter(env: PrivateLabelB2BInquiryPresentationEnv): ManagedB2BInquiryPresenter {
  return {
    present({ request, sourceId, notificationTo }) {
      const origin = resolveEmailOrigin({
        ...readEmailOriginConfiguration(env, { defaultOrigin: APP_SITE_ORIGIN, productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS }),
        explicitBaseUrl: env.APP_BASE_URL ?? env.openlup_BASE_URL,
        customerAuthRedirectOrigin: env.CUSTOMER_AUTH_REDIRECT_ORIGIN,
        siteUrl: env.SITE_URL,
        hiddenPreviewEnabled: env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true",
        environment: env.EMAIL_ENVIRONMENT,
      });
      if (origin.ok === false) return { ok: false, error: origin.error };

      const brand = appEmailBrandForOrigin(origin.origin);
      const regionCode = request.country;
      const formattedRegion = formatRegion(regionCode);
      const sender = env.FROM_EMAIL || "openlup <bart@openlup.com>";
      const confirmation = renderEmail({
        brand,
        locale: "en",
        subject: `We've received your enquiry, ${request.firstName}`,
        preheader: "We've received your B2B enquiry — our team will review it within 1–2 business days.",
        blocks: [
          heading(`Hi ${request.firstName},`),
          paragraph(`Thank you for reaching out about a private-label partnership for ${request.company}.`),
          paragraph("We've received your enquiry and our team will review it within 1–2 business days. If everything looks like a good fit, we'll be in touch to schedule a discovery call."),
          paragraph("In the meantime, feel free to reply to this email with any questions."),
          paragraph(`Best,\nTeam ${brand.theme.logoText}`),
        ],
      });
      const notification = notificationEmail(
        request,
        new URL(`/admin/b2b-inquiries/${sourceId}`, origin.origin).toString(),
        brand,
        formattedRegion,
      );
      return {
        ok: true,
        confirmation: { sender, ...confirmation, ...(notificationTo[0] ? { replyTo: notificationTo[0] } : {}) },
        notification: { sender, subject: `🤝 New B2B inquiry: ${request.company} (${formattedRegion})`, ...notification },
      };
    },
  };
}

function notificationEmail(
  request: PartnersB2BInquirySubmitRequest,
  adminUrl: string,
  brand: ReturnType<typeof appEmailBrandForOrigin>,
  formattedRegion: string,
) {
  const rowValues: Array<[string, string | null | undefined]> = [
    ["Company", request.company],
    ["Country", formattedRegion],
    ["Contact", `${request.firstName} ${request.lastName}`],
    ["Email", request.email],
    ["Phone", request.phone],
    ["Notes", request.notes],
  ];
  const rows = rowValues
    .filter(([label, value]) => ["Company", "Contact", "Email"].includes(label) || Boolean(value))
    .map(([label, value]) => ({ label, value: String(value ?? "—") }));
  const { subject: _subject, ...content } = renderEmail({
    brand,
    locale: "en",
    subject: "New B2B inquiry",
    blocks: [heading("New B2B inquiry 🤝"), dataTable(rows), button("Open in admin panel", adminUrl)],
  });
  return content;
}

const REGION_NAME_OVERRIDES: Readonly<Record<string, string>> = { CZ: "Czech Republic" };
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function formatRegion(code: string): string {
  const normalized = code.toUpperCase();
  let region: string | undefined;
  try {
    region = REGION_NAME_OVERRIDES[normalized] ?? regionNames.of(normalized);
  } catch {
    return code;
  }
  return !region || region === normalized || region === "Unknown Region" ? code : `${region} (${normalized})`;
}
