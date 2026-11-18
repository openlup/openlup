import type { CheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/contracts';
import type { RenewalStockProtectionPolicy } from '@openlup/platform/inventory/contracts';
import { MAX_CADENCE_DAYS } from '@openlup/core/subscription';
import type { AdminCommerceOrderHoldRequest } from '@openlup/platform/commerce/contracts';
import { estimateOffer } from './offer-estimate.ts';
import { assertQuoteConfiguration, type QuoteConfiguration } from './quote-config.ts';
import { isValidGtin } from '@openlup/platform/catalog/contracts';
import { assertRetention, assertRenewalConfig, type RenewalConfig } from './renewal-config.ts';
import { assertRecoveryConfiguration, type RecoveryConfiguration } from './recovery-config.ts';
import type { SellableCatalogItem } from '@openlup/platform/catalog/contracts';
import { assertEditorConfig, type SubscriptionEditorConfig } from './subscription-edit.ts';

import { assertSubscriptionOffer, type SubscriptionOffers } from './subscription-offer.ts';
import { assertLocaleMarket, type Localized, type LocaleMarket } from './locales.ts';
import { assertStarterCopy } from './locale-copy.ts';
export type { Locale, Localized } from './locales.ts';

// Starter cart representation bound; owned offers may choose a lower maximum.
const MAX_STARTER_OFFER_UNITS = 100;

export type PurchaseMode = 'one_time' | 'subscription';

export interface Product extends SellableCatalogItem {
  physical: { netWeightG: number; unitGtin: string; issuer: string };
  slug: string;
  name: Localized;
  description: Localized;
  details: Localized;
  media: string;
  mediaAlt: Localized;
  contents: string;
}

/** Application-owned data, shared without translation between browser and host. */
export interface StoreConfig {
  id: string;
  inventory: { renewalProtection: RenewalStockProtectionPolicy };
  checkoutRecoveryReminders: CheckoutRecoveryReminderSchedule;
  subscriptionCreation: { editWindowHours: number };
  subscriptionEditing: SubscriptionEditorConfig;
  subscriptionOffers: SubscriptionOffers;
  renewal: RenewalConfig;
  recovery?: RecoveryConfiguration;
  /** Optional owned origin; absence preserves the two local HTTP authorities. */
  publicOrigin?: string;
  /** Explicit opt-in for a non-loopback HTTP origin. Prefer TLS. */
  allowInsecurePublicOrigin?: boolean;
  /** Public support contact, rendered as plain text only. */
  supportEmail?: string;
  brand: {
    name: string;
    strapline: Localized;
    description: Localized;
  };
  theme: {
    ink: string;
    paper: string;
    accent: string;
    accentInk: string;
    border: string;
  };
  copy: {
    heroTitle: Localized;
    heroBody: Localized;
    offerTitle: Localized;
    offerBody: Localized;
  };
  media: {
    hero: string;
    heroAlt: Localized;
  };
  market: LocaleMarket & {
    country: string;
    currency: string;
    timezone: string;
  };
  offer: {
    layout: 'cards' | 'list';
    products: readonly Product[];
    minUnits: number;
    maxUnits: number;
    shippingMinor: number;
    freeShippingFromMinor: number;
    subscriptionDiscountBps: number;
    subscriptionRoundingQuantumMinor: number;
    cadenceDays: readonly number[];
    defaultCadenceDays: number;
  };
  quote: QuoteConfiguration;
  purchase: {
    recoveryMessage: { subject: Localized; body: Localized; expiryLabel: Localized; orderLabel: Localized };
    inputLimits: { text: number; postalCode: number; email: number; name: number; phone: number };
    contact: { acquisitionSource: string; lifecycleStage: 'lead' | 'customer' | 'inactive' };
    responseFloorMs: number;
    attemptLimits: { windowMs: number; maxPerRequester: number; maxPerEmail: number; retentionMs: number; maxEntries: number };
    reservationMinutes: number;
    stock: { quantities: Record<string, number>; collectedAt: string; staleAfter: string; providerRef: string; syncRunId: string };
    tax: { vatRateBps: number; legalBasis: string; category: string };
    sandbox: { dunningTemplateSlug: string; recoveryTemplateSlug: string; recoveryUrlPath: string };
  };
  documents: { sandbox: { enabled: boolean; providerRef: string } };
  returns: { reasons: readonly { code: string; label: Localized }[] };
  orderControls: { holdReasons: readonly { code: AdminCommerceOrderHoldRequest['reason']; label: Localized }[] };
  legal: {
    revision: string;
    returnsDays: number;
    demoOnly: true;
  };
  features: {
    reviews: boolean;
    acquisition: boolean;
    research: boolean;
    partners: boolean;
    risk: false;
    normalizedIngest: boolean;
  };
}

export function assertConfig(config: StoreConfig): void {
  assertLocaleMarket(config.market);
  const schedule = config.checkoutRecoveryReminders;
  const scheduleCode = 'checkout_recovery_reminder_schedule_invalid';
  if (!schedule || Object.keys(schedule).sort().join(',') !== 'abandonedCart,checkoutRecovery,revision'
    || typeof schedule.revision !== 'string' || !schedule.revision.trim()) throw new Error(scheduleCode);
  for (const key of ['abandonedCart', 'checkoutRecovery'] as const) {
    const waves = schedule[key];
    if (!Array.isArray(waves) || !waves.length) throw new Error(scheduleCode);
    let previous = 0;
    const seen = new Set<string>();
    for (const wave of waves) {
      if (!wave || Object.keys(wave).sort().join(',') !== 'afterHours,stage'
        || !['first', 'last', ...(key === 'abandonedCart' ? ['gentle'] : [])].includes(wave.stage)
        || seen.has(wave.stage) || !Number.isInteger(wave.afterHours)
        || wave.afterHours <= previous || wave.afterHours > 2147483647) throw new Error(scheduleCode);
      previous = wave.afterHours; seen.add(wave.stage);
    }
    if (waves.at(-1)?.stage !== 'last') throw new Error(scheduleCode);
  }
  const protection = config.inventory?.renewalProtection;
  if (!protection || Object.keys(protection).sort().join(',') !== 'renewalProtectionDays,revision'
    || typeof protection.revision !== 'string' || !protection.revision.trim()
    || !Number.isInteger(protection.renewalProtectionDays)
    || protection.renewalProtectionDays < 1 || protection.renewalProtectionDays > 3660) {
    throw new Error('inventory_renewal_protection_policy_invalid');
  }
  if (!Number.isInteger(config.subscriptionCreation?.editWindowHours)
    || config.subscriptionCreation.editWindowHours < 1 || config.subscriptionCreation.editWindowHours > 720) {
    throw new Error('starter_subscription_creation_invalid');
  }
  assertRenewalConfig(config.renewal, config.market.locales);
  assertRetention(config.renewal.subscriptionCare);
  for (const offer of Object.values(config.subscriptionOffers)) assertSubscriptionOffer(offer, config.subscriptionEditing.catalogue.map(product => product.sku));
  assertEditorConfig(config.subscriptionEditing);
  assertPublicOrigin(config);
  assertRecoveryConfiguration(config.recovery, config.market.locales);
  assertSupportEmail(config);
  assertStarterCopy(config);
  const offer = config.offer;
  assertQuoteConfiguration(config.quote, config.subscriptionOffers.classic);
  if (typeof config.market.country !== 'string' || !/^[A-Z]{2}$/.test(config.market.country)
    || typeof config.market.currency !== 'string' || !/^[A-Z]{3}$/.test(config.market.currency)
    || typeof config.market.timezone !== 'string' || !config.market.timezone.trim()) {
    throw new Error('starter_market_invalid');
  }
  try { new Intl.DateTimeFormat(config.market.defaultLocale, { timeZone: config.market.timezone }); }
  catch { throw new Error('starter_market_invalid'); }
  if (typeof config.id !== 'string' || config.id.length > 80
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.id)) throw new Error('starter_configuration_invalid');
  if (typeof config.legal.revision !== 'string' || config.legal.revision !== config.legal.revision.trim()
    || config.legal.revision.length < 1 || config.legal.revision.length > 64) throw new Error('starter_configuration_invalid');
  if (!config.brand.name.trim() || !config.legal.demoOnly || config.features.risk !== false) {
    throw new Error('starter_configuration_invalid');
  }
  for (const token of Object.values(config.theme)) {
    if (!/^#[0-9a-f]{6}$/i.test(token)) throw new Error('starter_theme_invalid');
  }
  for (const amount of [offer.minUnits, offer.maxUnits, offer.shippingMinor,
    offer.freeShippingFromMinor, offer.subscriptionDiscountBps,
    offer.subscriptionRoundingQuantumMinor]) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('starter_offer_invalid');
  }
  if (offer.maxUnits > MAX_STARTER_OFFER_UNITS) throw new Error('starter_units_above_representation');
  if (offer.shippingMinor > 2147483647 || offer.freeShippingFromMinor > 2147483647
    || offer.subscriptionRoundingQuantumMinor < 1 || offer.minUnits < 1 || offer.maxUnits < offer.minUnits
    || offer.subscriptionDiscountBps > 10000 || offer.cadenceDays.length === 0
    || !offer.cadenceDays.includes(offer.defaultCadenceDays)
    || !Number.isSafeInteger(offer.defaultCadenceDays) || offer.defaultCadenceDays < 1 || offer.defaultCadenceDays > MAX_CADENCE_DAYS
    || offer.cadenceDays.some(day => !Number.isSafeInteger(day) || day < 1 || day > MAX_CADENCE_DAYS)) {
    throw new Error('starter_offer_invalid');
  }
  const purchase = config.purchase;
  if (!purchase
    || !Number.isSafeInteger(purchase.responseFloorMs) || purchase.responseFloorMs < 0
    || !purchase.contact.acquisitionSource.trim() || purchase.contact.acquisitionSource.length > 100
    || !['lead', 'customer', 'inactive'].includes(purchase.contact.lifecycleStage)
    || Object.values(purchase.attemptLimits).some(value => !Number.isSafeInteger(value) || value < 1)
    || purchase.attemptLimits.retentionMs < purchase.attemptLimits.windowMs
    || purchase.inputLimits.text > 200 || purchase.inputLimits.postalCode > 32
    || purchase.inputLimits.email > 160 || purchase.inputLimits.name > 80 || purchase.inputLimits.phone > 64
    || !Number.isSafeInteger(purchase.reservationMinutes) || purchase.reservationMinutes < 1
    || !Number.isSafeInteger(purchase.tax.vatRateBps) || purchase.tax.vatRateBps < 0 || purchase.tax.vatRateBps > 10000
    || !/^[a-z][a-z0-9_]*$/.test(purchase.tax.category)
    || !purchase.stock.providerRef.trim()
    || !purchase.stock.syncRunId.trim()
    || !purchase.tax.legalBasis.trim() || purchase.tax.legalBasis.trim().length > 200
    || Object.values(purchase.inputLimits).some(value => !Number.isSafeInteger(value) || value < 1)
    || !/^[a-z0-9-]+$/.test(purchase.sandbox.dunningTemplateSlug)
    || !/^[a-z0-9-]+$/.test(purchase.sandbox.recoveryTemplateSlug)
    || !/^\/[a-zA-Z0-9/_-]+$/.test(purchase.sandbox.recoveryUrlPath)
    || !Number.isFinite(Date.parse(purchase.stock.collectedAt)) || !Number.isFinite(Date.parse(purchase.stock.staleAfter))
    || Date.parse(purchase.stock.staleAfter) <= Date.parse(purchase.stock.collectedAt)) throw new Error('starter_purchase_configuration_invalid');
  if (!config.documents || typeof config.documents.sandbox.enabled !== 'boolean'
    || !config.documents.sandbox.providerRef.trim() || !config.returns?.reasons.length
    || !config.orderControls?.holdReasons.length) throw new Error('starter_order_controls_configuration_invalid');
  for (const choices of [config.returns.reasons, config.orderControls.holdReasons]) {
    if (new Set(choices.map(choice => choice.code)).size !== choices.length || choices.some(choice =>
      !choice.code.trim())) {
      throw new Error('starter_order_controls_configuration_invalid');
    }
  }
  const seen = new Set<string>();
  const slugs = new Set<string>();
  if (offer.products.length === 0) throw new Error('starter_catalog_empty');
  for (const product of offer.products) {
    if (!product.physical || !Number.isSafeInteger(product.physical.netWeightG) || product.physical.netWeightG < 1
      || !isValidGtin(product.physical.unitGtin) || !product.physical.issuer.trim() || seen.has(product.sku) || slugs.has(product.slug)
      || !/^[A-Z0-9-]{1,80}$/.test(product.sku)
      || !/^[a-z0-9-]{1,80}$/.test(product.slug)
      || !Number.isSafeInteger(product.unitPrice.amountMinor)
      || product.unitPrice.amountMinor < 1 || product.unitPrice.amountMinor > 2147483647
      || product.unitPrice.currency !== config.market.currency
      || product.permittedPurchaseModes.length === 0
      || product.permittedPurchaseModes.some(mode => mode !== 'one_time' && mode !== 'subscription')
      || !product.media.startsWith('/media/')) {
      throw new Error('starter_product_invalid');
    }
    if (!Number.isSafeInteger(purchase.stock.quantities[product.sku]) || purchase.stock.quantities[product.sku]! < 0 || purchase.stock.quantities[product.sku]! > 2147483647) {
      throw new Error('starter_purchase_configuration_invalid');
    }
    for (const mode of product.permittedPurchaseModes) {
      const amount = estimateOffer(config, mode, [{ sku: product.sku, quantity: 1 }]).lines[0]!.unitMinor;
      if (amount < 1 || amount > 2147483647) throw new Error('starter_product_invalid');
    }
    seen.add(product.sku);
    slugs.add(product.slug);
  }
  if (Object.keys(purchase.stock.quantities).some(sku => !seen.has(sku))) throw new Error('starter_purchase_configuration_invalid');
}

/** One validator for the optional public contact; no URL or HTML is accepted. */
export function assertSupportEmail(config: Pick<StoreConfig, 'supportEmail'>): void {
  if (config.supportEmail === undefined) return;
  if (typeof config.supportEmail !== 'string' || config.supportEmail.length > 254 || /\s/.test(config.supportEmail)
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(config.supportEmail)) {
    throw new Error('starter_support_email_invalid');
  }
}

/** The only origin validator. Store the URL parser's canonical origin in the input. */
export function assertPublicOrigin(config: Pick<StoreConfig, 'publicOrigin' | 'allowInsecurePublicOrigin'>): void {
  if (config.allowInsecurePublicOrigin !== undefined && typeof config.allowInsecurePublicOrigin !== 'boolean') {
    throw new Error('starter_public_origin_flag_invalid');
  }
  if (config.publicOrigin === undefined) return;
  const value = config.publicOrigin;
  if (typeof value !== 'string' || !value || value.length > 256 || /\s/.test(value)
    || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
    throw new Error('starter_public_origin_invalid');
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('starter_public_origin_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || value.includes('*')
    || parsed.hostname.endsWith('.')) throw new Error('starter_public_origin_invalid');
  // Reject parser repairs (case, IDN, escaped hosts, dot paths, backslashes, empty
  // query/fragment/userinfo). Only a root slash and the default port may normalize.
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  const accepted = [parsed.origin, parsed.origin + '/'];
  if (!parsed.port) {
    accepted.push(`${parsed.protocol}//${parsed.hostname}:${defaultPort}`,
      `${parsed.protocol}//${parsed.hostname}:${defaultPort}/`);
  }
  if (!accepted.includes(value)) throw new Error('starter_public_origin_not_canonical');
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'http:' && !loopback && config.allowInsecurePublicOrigin !== true) {
    throw new Error('starter_public_origin_tls_required');
  }
  config.publicOrigin = parsed.origin;
}


/** Non-secret host arguments; the owned registry supplies the absent configuration. */
export function parseHostArguments(args: readonly string[]): {
  configuration: string | undefined; port: number; listen: '127.0.0.1' | '0.0.0.0'; databaseUrl?: string; quoteAcceptanceKeyFile?: string;
} {
  let configuration: string | undefined;
  let databaseUrl: string | undefined;
  let quoteAcceptanceKeyFile: string | undefined;
  let port = 4319;
  let listen: '127.0.0.1' | '0.0.0.0' = '127.0.0.1';
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (!['--configuration', '--port', '--listen', '--database-url', '--quote-acceptance-key-file'].includes(flag)) throw new Error('starter_argument_unknown');
    if (seen.has(flag)) throw new Error('starter_argument_duplicate');
    seen.add(flag);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('starter_argument_value_required');
    if (flag === '--quote-acceptance-key-file') {
      quoteAcceptanceKeyFile = value;
    } else if (flag === '--database-url') {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error('starter_runtime_connection_required'); }
      if (url.protocol !== 'postgresql:' || url.username !== 'starter_runtime' || url.password
        || url.search || url.hash || url.pathname !== '/neutral_store') throw new Error('starter_runtime_connection_required');
      databaseUrl = value;
    } else if (flag === '--configuration') configuration = value;
    else if (flag === '--port') {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))
        || Number(value) < 1024 || Number(value) > 65535) throw new Error('starter_port_invalid');
      port = Number(value);
    } else {
      if (value !== '127.0.0.1' && value !== '0.0.0.0') throw new Error('starter_listen_invalid');
      listen = value;
    }
  }
  return { configuration, port, listen, ...(databaseUrl === undefined ? {} : { databaseUrl }), ...(quoteAcceptanceKeyFile ? { quoteAcceptanceKeyFile } : {}) };
}
