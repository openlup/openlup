import type { StoreConfig } from '../shared/config.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';

export const demonstrationMarker = 'openlup-neutral-store-demo-v1';

/** One dedicated install session, never a runtime pool or HTTP binding. */
export interface InstallConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DemonstrationInstallation {
  connection: InstallConnection;
  installRole: string;
  runtimeRole: string;
  close(): Promise<void>;
}

// The selected base candidate has no installed-catalogue/bootstrap binding.
// A future installed bootstrap must create/migrate a NEW demonstration database,
// mark that database, create restricted roles and return its dedicated install session.
export type InstallationBootstrap = () => Promise<DemonstrationInstallation>;

/** Called only by lifecycle up, once per installation invocation, before the HTTP host starts. */
export async function installDemonstration(config: StoreConfig, bootstrap?: InstallationBootstrap): Promise<void> {
  if (!bootstrap) throw new Error('starter_installation_binding_required');
  const installation = await bootstrap();
  try { await applyDemoSeed(config, installation); }
  finally { await installation.close(); }
}

/** Idempotent data composition; never creates schema, clients, stock or subscription truth. */
export async function applyDemoSeed(config: StoreConfig, installation: DemonstrationInstallation): Promise<void> {
  const { connection, installRole, runtimeRole } = installation;
  if (!installRole || !runtimeRole || installRole === runtimeRole) throw new Error('starter_seed_install_role_required');
  const seed = buildDemoSeed(config);
  await connection.query('BEGIN');
  try {
    const { rows } = await connection.query(`SELECT session_user AS login, current_user AS role,
      pg_catalog.shobj_description(oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()`);
    const target = rows[0];
    // Check both identities: SET ROLE must not turn a runtime login into an installer.
    if (target?.login === runtimeRole || target?.role === runtimeRole) {
      throw new Error('starter_seed_runtime_role_forbidden');
    }
    if (target?.login !== installRole || target?.role !== installRole) {
      throw new Error('starter_seed_install_role_required');
    }
    if (target.marker !== demonstrationMarker) throw new Error('starter_seed_demonstration_database_required');
    for (const row of seed.products) await connection.query(`INSERT INTO public.catalog_products
      (id, slug, status, name, description) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, status=EXCLUDED.status,
        name=EXCLUDED.name, description=EXCLUDED.description`,
    [row.id, row.slug, row.status, row.name, row.description]);
    for (const row of seed.skus) await connection.query(`INSERT INTO public.catalog_skus
      (id, product_id, sku, title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET
        product_id=EXCLUDED.product_id, sku=EXCLUDED.sku, title=EXCLUDED.title, status=EXCLUDED.status,
        min_order_qty=EXCLUDED.min_order_qty, is_addon=EXCLUDED.is_addon,
        sellable_standalone=EXCLUDED.sellable_standalone, sellable_in_subscription=EXCLUDED.sellable_in_subscription`,
    [row.id, row.product_id, row.sku, row.title, row.status, row.min_order_qty,
      row.is_addon, row.sellable_standalone, row.sellable_in_subscription]);
    for (const row of seed.priceLists) await connection.query(`INSERT INTO public.price_lists
      (id, name, region_code, currency, status, valid_from) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, region_code=EXCLUDED.region_code,
        currency=EXCLUDED.currency, status=EXCLUDED.status, valid_from=EXCLUDED.valid_from`,
    [row.id, row.name, row.region_code, row.currency, row.status, row.valid_from]);
    for (const row of seed.prices) await connection.query(`INSERT INTO public.price_entries
      (id, price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active, valid_from)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET
        price_list_id=EXCLUDED.price_list_id, variant_id=EXCLUDED.variant_id, mode=EXCLUDED.mode,
        min_qty=EXCLUDED.min_qty, unit_price_minor=EXCLUDED.unit_price_minor,
        amount_kind=EXCLUDED.amount_kind, active=EXCLUDED.active, valid_from=EXCLUDED.valid_from`,
    [row.id, row.price_list_id, row.variant_id, row.mode, row.min_qty, row.unit_price_minor,
      row.amount_kind, row.active, row.valid_from]);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}
