import { projectPublishedCatalogOfferPage, readPostgresCatalogStorefrontPage,
  type CatalogMembershipCursor } from '@openlup/platform/catalog';
import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from '@openlup/platform/data';
import type { StoreConfig } from '../shared/config.ts';
import { readStarterProducts, type StarterCatalogueItem } from '../shared/catalogue-products.ts';
import { checkoutSubscriptionOfferVersion, starterQuoteCatalogMaxItems } from '../shared/offer.ts';
import { editorProducts, starterCatalogue } from './editor-catalogue.ts';
import type { ActionBinding } from './bindings.ts';

const pageSize = 24;
const readFix = 'Check PostgreSQL reachability, TLS, driver, runtime login and grants, and installed migrations. Reread the same SKU.';
const pageFix = 'Reduce active sellable SKUs through the catalogue workflow, then reread and quote.';
const fixes = {
  starter_catalogue_presentation_invalid: ['presentation', 'The published title or local media reference does not fit the starter presentation.',
    'Correct the published copy and local media reference using the starter presentation shape.',
    'Publish through the catalogue workflow and reread the same SKU.'],
  starter_catalogue_one_time_required: ['sell.oneTime', 'The starter lists only SKUs sellable for one-time purchase.',
    'Make the SKU sellable for one-time purchase through the catalogue workflow.',
    'Reread the same SKU.'],
  starter_catalogue_price_missing: ['price.oneTime', 'The SKU has no effective one-time price.',
    'Set an effective gross one-time price through the authorized price action.',
    'Reread the SKU and repeat its server quote.'],
  starter_catalogue_price_basis_unsupported: ['price.oneTime', 'The effective one-time price does not fit the configured gross market.',
    'Correct the effective gross one-time price through the authorized price action.',
    'Reread the SKU and repeat its server quote.'],
} as const;
const failure = (code: string, message: string, cause?: unknown) =>
  Object.defineProperty({ ok: false as const, code, message, status: 503 as const }, 'cause', { value: cause });

type Transactions = Pick<PostgresRoleFreeTransactionLane<PgQueryExecutor>, 'run'>;
export function composeCatalogueStorefront(transactions: Transactions, readPage = readPostgresCatalogStorefrontPage,
  readCatalogue = starterCatalogue) {
  async function resolveCatalogue(config: StoreConfig) {
    try {
      const products = new Map<string, StarterCatalogueItem>(config.offer.products.map(item => [item.sku, item]));
      const seedCount = new Set(editorProducts(config).filter(item => item.permittedPurchaseModes.length).map(item => item.sku)).size;
      const budget = Math.max(0, starterQuoteCatalogMaxItems - seedCount), pages = Math.max(1, Math.ceil(budget / pageSize));
      const receipts = new Map<string, ReturnType<ReturnType<typeof starterCatalogue>['readInstalled']>>();
      let catalogue: ReturnType<typeof starterCatalogue> | undefined;
      try { catalogue = readCatalogue(); } catch { /* Unverified metadata carries no public attributes. */ }
      let cursor: CatalogMembershipCursor | null = null, headDigest: string | undefined, count = 0;
      const visited = new Set<string>();
      for (let page = 1; page <= pages; page++) {
        const result = await readPage(transactions, { offerVersion: checkoutSubscriptionOfferVersion, limit: pageSize,
          regionCode: config.market.country, currency: config.market.currency, channel: 'D2C', cursor });
        if ('outcome' in result) {
          if (page === 1 && result.issue === 'offer_unpublished') break;
          return failure(result.reason, result.message, Object.getOwnPropertyDescriptor(result, 'cause')?.value);
        }
        if (cursor && (result.protocol !== 'governed' || result.headDigest !== headDigest))
          return failure('catalog_publication_head_moved', 'Start a fresh read from the first page.');
        if (result.protocol === 'legacy') break;
        headDigest = result.headDigest;
        count += result.products.reduce((total, product) => total + product.skus.length, 0);
        cursor = result.nextCursor;
        if (cursor && visited.has(cursor.skuId))
          return failure('starter_catalogue_cursor_invalid', 'Verify the installed reader and retry from the first page.');
        if (count > budget || cursor && (count >= budget || page === pages))
          return failure('starter_catalogue_page_limit', pageFix);
        for (const { typeRef } of result.products) {
          const key = `${typeRef.key}@${typeRef.version}`;
          if (receipts.has(key)) continue;
          try { receipts.set(key, catalogue?.readInstalled(typeRef)); }
          catch { receipts.set(key, undefined); }
        }
        const mapped = readStarterProducts(projectPublishedCatalogOfferPage(result, [...receipts.values()].filter(row => !!row)), config);
        for (const item of mapped.products) if (!products.has(item.sku)) products.set(item.sku, item);
        for (const { code, subject } of mapped.exclusions) {
          const [path, cause, fix, recheck] = fixes[code];
          console.warn(JSON.stringify({ code, subject, path, observed: 'The published SKU was omitted from the storefront.',
            cause, fix, recheck }));
        }
        if (!cursor) break;
        visited.add(cursor.skuId);
      }
      const { rows: [census] } = await transactions.run(db => db.query(`SELECT count(*)::int AS count FROM (
        SELECT 1 FROM public.catalog_skus WHERE status='active' AND (sellable_standalone OR sellable_in_subscription) LIMIT $1
      ) active_sellable`, [starterQuoteCatalogMaxItems + 1]));
      if (typeof census?.count !== 'number') throw new Error('starter_catalogue_census_invalid');
      if (census.count > starterQuoteCatalogMaxItems) return failure('starter_catalogue_page_limit', pageFix);
      return { ok: true as const, value: { products: [...products.values()] } };
    } catch (cause) { return failure('starter_catalogue_read_unavailable', readFix, cause); }
  }
  const action: ActionBinding = (input, context) => Object.keys(input).some(key => key !== 'locale')
    ? Promise.resolve({ ok: false, code: 'starter_input_invalid' }) : resolveCatalogue(context.config);
  return { resolveCatalogue, action };
}
