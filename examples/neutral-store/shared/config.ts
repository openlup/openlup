import type { SellableCatalogItem } from '@openlup/platform/catalog/contracts';

export type Locale = 'en' | 'pl';
export type Localized = Record<Locale, string>;
export type PurchaseMode = 'one_time' | 'subscription';

export interface Product extends SellableCatalogItem {
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
    shippingNote: Localized;
  };
  media: {
    hero: string;
    heroAlt: Localized;
  };
  market: {
    country: string;
    currency: string;
    timezone: string;
    locales: readonly Locale[];
  };
  offer: {
    layout: 'cards' | 'list';
    products: readonly Product[];
    minUnits: number;
    maxUnits: number;
    shippingMinor: number;
    freeShippingFromMinor: number;
    subscriptionDiscountBps: number;
    cadenceDays: readonly number[];
    defaultCadenceDays: number;
  };
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
  assertPublicOrigin(config);
  assertSupportEmail(config);
  const offer = config.offer;
  if (typeof config.market.country !== 'string' || !/^[A-Z]{2}$/.test(config.market.country)
    || typeof config.market.currency !== 'string' || !/^[A-Z]{3}$/.test(config.market.currency)
    || typeof config.market.timezone !== 'string' || !config.market.timezone.trim()) {
    throw new Error('starter_market_invalid');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: config.market.timezone }); }
  catch { throw new Error('starter_market_invalid'); }
  if (typeof config.id !== 'string' || config.id.length > 80
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.id)) throw new Error('starter_configuration_invalid');
  if (!config.brand.name.trim() || !config.legal.demoOnly || config.features.risk !== false) {
    throw new Error('starter_configuration_invalid');
  }
  for (const token of Object.values(config.theme)) {
    if (!/^#[0-9a-f]{6}$/i.test(token)) throw new Error('starter_theme_invalid');
  }
  for (const amount of [offer.minUnits, offer.maxUnits, offer.shippingMinor,
    offer.freeShippingFromMinor, offer.subscriptionDiscountBps]) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('starter_offer_invalid');
  }
  if (offer.minUnits < 1 || offer.maxUnits < offer.minUnits || offer.maxUnits > 100
    || offer.subscriptionDiscountBps > 10000 || offer.cadenceDays.length === 0
    || !offer.cadenceDays.includes(offer.defaultCadenceDays)
    || offer.cadenceDays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 366)) {
    throw new Error('starter_offer_invalid');
  }
  const seen = new Set<string>();
  const slugs = new Set<string>();
  if (offer.products.length === 0) throw new Error('starter_catalog_empty');
  for (const product of offer.products) {
    if (seen.has(product.sku) || slugs.has(product.slug)
      || !/^[A-Z0-9-]{1,80}$/.test(product.sku)
      || !/^[a-z0-9-]{1,80}$/.test(product.slug)
      || !Number.isSafeInteger(product.unitPrice.amountMinor)
      || product.unitPrice.amountMinor < 1
      || product.unitPrice.currency !== config.market.currency
      || product.permittedPurchaseModes.length === 0
      || product.permittedPurchaseModes.some(mode => mode !== 'one_time' && mode !== 'subscription')
      || !product.media.startsWith('/media/')) {
      throw new Error('starter_product_invalid');
    }
    seen.add(product.sku);
    slugs.add(product.slug);
  }
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
  configuration: string | undefined; port: number; listen: '127.0.0.1' | '0.0.0.0'; databaseUrl?: string;
} {
  let configuration: string | undefined;
  let databaseUrl: string | undefined;
  let port = 4319;
  let listen: '127.0.0.1' | '0.0.0.0' = '127.0.0.1';
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (!['--configuration', '--port', '--listen', '--database-url'].includes(flag)) throw new Error('starter_argument_unknown');
    if (seen.has(flag)) throw new Error('starter_argument_duplicate');
    seen.add(flag);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('starter_argument_value_required');
    if (flag === '--database-url') {
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
  return { configuration, port, listen, ...(databaseUrl === undefined ? {} : { databaseUrl }) };
}
