import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { BrandConfig, EmailBrand } from "../../../lib/brand/brandConfig.js";

export interface CompanyIdentity {
  readonly legalName: string;
  readonly street: string;
  readonly locality: string;
  readonly postalCode: string;
  readonly city: string;
  readonly region: string;
  readonly countryCode: string;
  readonly taxId: string;
  readonly vatId: string;
  readonly regon: string;
  readonly krs: string;
  readonly registryCourt: string;
  readonly shareCapital: string;
  readonly email: string;
}

/** Immutable presentation inputs selected once by an application composition root. */
export interface EmailPresentation {
  readonly id: string;
  /** Extra build-time resolver conditions required by this selected owner. */
  readonly resolverConditions: readonly string[];
  readonly brand: BrandConfig;
  readonly companyName: string;
  readonly companyIdentity: CompanyIdentity;
  readonly companyAddressLine: string;
  readonly emailTeamSignoff: Readonly<Record<Locale, string>>;
  readonly emailVisualChromeEnabled: boolean;
  readonly appShellAssetOverrides: Readonly<Record<string, string>>;
  emailBrandForOrigin(origin: string): EmailBrand;
  emailVisualBrandForOrigin(origin: string): EmailBrand;
}

export function emailCopyBrandName(presentation: EmailPresentation): string {
  return presentation.brand.email.copyBrandNameCased
    ?? presentation.brand.email.copyBrandName;
}
