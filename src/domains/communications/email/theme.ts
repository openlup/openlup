// Email theme contract — the shape of the *look* of every transactional email
// the renderer produces. Emails cannot rely on CSS variables across clients, so
// the theme is a value contract injected into the renderer.
//
// Open-source note (Apache-2.0): the renderer takes an EmailTheme as a parameter, so a
// fork swaps colours / logo / footer / fonts by passing its own theme — without
// editing render.ts. The concrete brand theme lives in the app layer
// (src/lib/brand/appBrand.ts: APP_EMAIL_THEME); core defines only the shape.

export interface EmailTheme {
  /** Outer page background (warm cream). */
  bodyBg: string;
  /** Content card background. */
  cardBg: string;
  /** Accent-box background (light teal tint). */
  accentBg: string;
  /** Accent-box / divider hairline. */
  hairline: string;
  /** Primary brand colour (teal): logo, links, buttons, accent border. */
  brand: string;
  /** Text colour on top of the brand colour (e.g. button label). */
  onBrand: string;
  /** Heading text. */
  textHeading: string;
  /** Body copy. */
  textBody: string;
  /** Muted/secondary text (footer, fine print). */
  textMuted: string;
  /** Font stack — system fonts only, for broad client support. */
  fontFamily: string;
  /** Text logo rendered in the header, and the alt/fallback shown when an image
   *  logo is set but blocked by the client. */
  logoText: string;
  /** Optional hosted logo image URL (absolute HTTPS). When set, the header
   *  renders an <img> (with logoText as the alt fallback) instead of the text
   *  wordmark. Left undefined by forks that prefer the text logo. */
  logoImageUrl?: string;
  /** Displayed logo height in px (width auto-scales). Used for the width/height
   *  attributes that keep layout stable when the image is blocked. */
  logoImageHeightPx?: number;
  /** Displayed logo width in px (paired with logoImageHeightPx for the attrs). */
  logoImageWidthPx?: number;
  /** Optional feature-card background; falls back to accentBg. Set it when the
   *  card's illustration carries its own background that must match. */
  featureCardBg?: string;
  /** Optional feature-card eyebrow and alt-text colour; falls back to brand. */
  featureCardAccent?: string;
  /** Content card corner radius, px. */
  cardRadiusPx: number;
  /** Button corner radius, px. */
  buttonRadiusPx: number;
  /** Max content width, px. */
  maxWidthPx: number;
}
