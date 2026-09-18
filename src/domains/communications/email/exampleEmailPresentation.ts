import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { BrandConfig, EmailBrand } from "../../../lib/brand/brandConfig.js";
import type { EmailChromeStrings } from "./strings.js";
import type { EmailTheme } from "./theme.js";
import type { EmailPresentation } from "./presentation.js";

const EXAMPLE_EMAIL_THEME: EmailTheme = {
  bodyBg: "#f4f7fb",
  cardBg: "#ffffff",
  accentBg: "#e7f0ff",
  hairline: "#d9e2f0",
  brand: "#2563eb",
  onBrand: "#ffffff",
  textHeading: "#1f2937",
  textBody: "#374151",
  textMuted: "#6b7280",
  fontFamily: "Arial,Helvetica,sans-serif",
  logoText: "Example Store",
  logoImageHeightPx: 52,
  logoImageWidthPx: 52,
  cardRadiusPx: 16,
  buttonRadiusPx: 10,
  maxWidthPx: 600,
};

const EXAMPLE_EMAIL_CHROME: Record<Locale, EmailChromeStrings> = {
  pl: {
    logoAlt: "Example Store",
    bannerImageAlt: "Wiadomość od Example Store",
    footerLegalLines: [
      "Example Store Ltd. · 1 Example Street, Example City",
      "Kontakt: support@example.test",
    ],
  },
  en: {
    logoAlt: "Example Store",
    bannerImageAlt: "A message from Example Store",
    footerLegalLines: [
      "Example Store Ltd. · 1 Example Street, Example City",
      "Contact: support@example.test",
    ],
  },
};

const EXAMPLE_EMAIL_BRAND: EmailBrand = {
  copyBrandName: "EXAMPLE STORE",
  copyBrandNameCased: "Example Store",
  theme: EXAMPLE_EMAIL_THEME,
  chrome: EXAMPLE_EMAIL_CHROME,
};

const EXAMPLE_BRAND: BrandConfig = {
  brandName: "Example Store",
  supportEmail: "support@example.test",
  fromEmail: "Example Store <notifications@example.test>",
  replyToEmail: "support@example.test",
  siteOrigin: "https://example.test",
  productionEmailHosts: ["example.test", "www.example.test"],
  orderRefPrefix: "ORDER",
  email: EXAMPLE_EMAIL_BRAND,
  seller: {
    name: "Example Store Ltd.",
    street: "1 Example Street",
    postalCode: "00-000",
    city: "Example City",
    taxId: "EXAMPLE-123",
    krs: "EXAMPLE-REGISTRY",
    bankAccount: "00000000000000000000000000",
    departmentId: null,
  },
};

const EXAMPLE_COMPANY_IDENTITY = {
  legalName: "Example Store Ltd.",
  street: "1 Example Street",
  locality: "Example City",
  postalCode: "00-000",
  city: "Example City",
  region: "Example Region",
  countryCode: "EX",
  taxId: "EXAMPLE-123",
  vatId: "EXAMPLE-123",
  regon: "EXAMPLE-REGON",
  krs: "EXAMPLE-REGISTRY",
  registryCourt: "Example Registry Court",
  shareCapital: "0.00 EXM",
  email: EXAMPLE_BRAND.supportEmail,
} as const;

const EXAMPLE_EMAIL_TEAM_SIGNOFF = Object.fromEntries(
  (Object.keys(EXAMPLE_EMAIL_CHROME) as Locale[]).map((locale, index) => [
    locale,
    index === 0
      ? "Pozdrawiamy,\nZespół Example Store"
      : "Best,\nExample Store team",
  ]),
) as Record<Locale, string>;

const EXAMPLE_LOGO_ASSET_PATH = "platform/favicon.svg";
const EXAMPLE_BANNER_ASSET_PATH = "platform/og/social-preview.png";

function exampleEmailVisualBrandForOrigin(origin: string): EmailBrand {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  const chrome = Object.fromEntries(
    Object.entries(EXAMPLE_EMAIL_CHROME).map(([locale, strings]) => [
      locale,
      {
        ...strings,
        bannerImageUrl: `${normalizedOrigin}/${EXAMPLE_BANNER_ASSET_PATH}`,
        footerLegalLines: strings.footerLegalLines ? [...strings.footerLegalLines] : undefined,
      },
    ]),
  ) as Record<Locale, EmailChromeStrings>;

  return {
    ...EXAMPLE_EMAIL_BRAND,
    theme: {
      ...EXAMPLE_EMAIL_THEME,
      logoImageUrl: `${normalizedOrigin}/${EXAMPLE_LOGO_ASSET_PATH}`,
    },
    chrome,
  };
}

function exampleEmailBrandForOrigin(_origin: string): EmailBrand {
  return EXAMPLE_EMAIL_BRAND;
}

/** Public/default owner, complete without a deployment overlay. */
export const emailPresentation: EmailPresentation = Object.freeze({
  id: "example",
  resolverConditions: [],
  brand: EXAMPLE_BRAND,
  companyName: "Example Store",
  companyIdentity: EXAMPLE_COMPANY_IDENTITY,
  companyAddressLine: "1 Example Street, Example City, 00-000 Example City (Example Region)",
  emailTeamSignoff: EXAMPLE_EMAIL_TEAM_SIGNOFF,
  emailVisualChromeEnabled: false,
  appShellAssetOverrides: {},
  emailBrandForOrigin: exampleEmailBrandForOrigin,
  emailVisualBrandForOrigin: exampleEmailVisualBrandForOrigin,
});
