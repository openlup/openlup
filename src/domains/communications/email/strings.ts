// Locale-keyed chrome strings (footer, logo alt) contract. The concrete brand
// words live in the app layer (src/lib/brand/appBrand.ts: APP_EMAIL_CHROME) and
// are injected via the renderer's `brand`, so a fork's PL/EN wording is
// configurable independently of the renderer.

export interface EmailChromeStrings {
  /** Optional footer tagline under the content card. Left undefined by brands
   *  that show only the legal fine print (see footerLegalLines). */
  footerTagline?: string;
  /** Accessible alt text for the logo (also the fallback when an image logo is
   *  blocked). */
  logoAlt: string;
  /** Optional hosted hero-banner image URL (absolute HTTPS), rendered full-width
   *  under the header. Each locale can carry different artwork. */
  bannerImageUrl?: string;
  /** Alt text for the banner image (shown when the image is blocked). */
  bannerImageAlt?: string;
  /** Optional legal fine-print lines rendered in the footer (company
   *  identification, e.g. art. 206 KSH). Each entry is one line. */
  footerLegalLines?: string[];
}
