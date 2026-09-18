// Compatibility facade for application roots that still use the historic
// appBrand API. Concrete values are selected once by #email-presentation.

import { emailPresentation } from "#email-presentation";

export const APP_EMAIL_VISUAL_CHROME_ENABLED = emailPresentation.emailVisualChromeEnabled;
export const APP_EMAIL_THEME = emailPresentation.brand.email.theme;
export const APP_EMAIL_CHROME = emailPresentation.brand.email.chrome;
export const APP_EMAIL_TEAM_SIGNOFF = emailPresentation.emailTeamSignoff;
export const APP_EMAIL_BRAND = emailPresentation.brand.email;
export const appEmailBrandForOrigin = emailPresentation.emailBrandForOrigin;
export const appEmailVisualBrandForOrigin = emailPresentation.emailVisualBrandForOrigin;
export const APP_BRAND_NAME = emailPresentation.brand.brandName;
export const APP_COMPANY_NAME = emailPresentation.companyName;
export const APP_SUPPORT_EMAIL = emailPresentation.brand.supportEmail;
export const APP_SITE_ORIGIN = emailPresentation.brand.siteOrigin;
export const APP_SITE_HOST = new URL(APP_SITE_ORIGIN).host;
export const APP_PRODUCTION_EMAIL_HOSTS = emailPresentation.brand.productionEmailHosts;
export const APP_ORDER_REF_PREFIX = emailPresentation.brand.orderRefPrefix;
export const APP_FROM_EMAIL = emailPresentation.brand.fromEmail;
export const APP_REPLY_TO_EMAIL = emailPresentation.brand.replyToEmail;
export const APP_DEFAULT_SELLER = emailPresentation.brand.seller;
export const APP_COMPANY_IDENTITY = emailPresentation.companyIdentity;
export const APP_COMPANY_ADDRESS_LINE = emailPresentation.companyAddressLine;
export const APP_SHELL_ASSET_OVERRIDES = emailPresentation.appShellAssetOverrides;
export const APP_BRAND = emailPresentation.brand;
export const APP_SOCIAL_LINKS = emailPresentation.brand.socialLinks ?? {};
