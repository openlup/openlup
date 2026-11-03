import type { StoreConfig } from '../shared/config.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';

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

export type InstallationBootstrap = () => Promise<DemonstrationInstallation>;

/** Called only by lifecycle up, once per installation invocation, before the HTTP host starts. */
export async function installDemonstration(config: StoreConfig, bootstrap: InstallationBootstrap): Promise<void> {
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
    for (const { addressReference: row } of acquisitionAddresses) {
      await connection.query(`INSERT INTO acquisition_private.address_references
        (source, reference, revision, provenance, active) VALUES ($1,$2,$3,$4,true)
        ON CONFLICT (source, reference, revision) DO NOTHING`,
      [row.source, row.reference, row.revision, row.provenance]);
      // Never overwrite or silently accept an existing tuple with different meaning.
      const existing = await connection.query(`SELECT provenance, active
        FROM acquisition_private.address_references
        WHERE source=$1 AND reference=$2 AND revision=$3 FOR SHARE`,
      [row.source, row.reference, row.revision]);
      if (existing.rows.length !== 1 || existing.rows[0]?.provenance !== row.provenance
        || existing.rows[0]?.active !== true) throw new Error('starter_acquisition_seed_conflict');
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

/** Local demo only. Socket access is the install capability; the application never mounts it. */
export async function bootstrapDemonstration(): Promise<DemonstrationInstallation> {
  const migrations = await import('@openlup/platform/migrations').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error
      && (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || error.code === 'ERR_MODULE_NOT_FOUND')
      && /@openlup\/platform/.test(error.message)) {
      throw new Error('starter_installation_binding_required');
    }
    throw error;
  });
  if (typeof migrations.createPlatformPostgresMigrationRunner !== 'function') {
    throw new Error('starter_installation_binding_required');
  }
  const { default: pg } = await import('pg');
  const socket = '/var/run/postgresql';
  const database = 'neutral_store';
  const installRole = 'starter_install';
  const runtimeRole = 'starter_runtime';
  const bootstrap = new pg.Client({ host: socket, database: 'postgres', user: 'postgres' });
  await bootstrap.connect();
  try {
    // Serialize database creation and marker admission across concurrent startup invocations.
    await bootstrap.query("SELECT pg_advisory_lock(hashtext('neutral-store-bootstrap'))");
    const existing = await bootstrap.query(`SELECT pg_catalog.shobj_description(oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database WHERE datname = $1`, [database]);
    if (existing.rows.length && existing.rows[0]?.marker !== demonstrationMarker) {
      throw new Error('starter_seed_demonstration_database_required');
    }
    if (!existing.rows.length) {
      await bootstrap.query(`CREATE ROLE starter_install LOGIN INHERIT SUPERUSER NOCREATEROLE
        NOCREATEDB NOREPLICATION NOBYPASSRLS`);
      await bootstrap.query(`CREATE ROLE starter_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE
        NOCREATEDB NOREPLICATION NOBYPASSRLS`);
      await bootstrap.query(`CREATE ROLE starter_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE
        NOCREATEDB NOREPLICATION NOBYPASSRLS`);
      await bootstrap.query('CREATE DATABASE neutral_store OWNER starter_install');
      // This branch is reachable only after THIS invocation successfully created the database.
      await bootstrap.query("COMMENT ON DATABASE neutral_store IS 'openlup-neutral-store-demo-v1'");
    }
    const runner = migrations.createPlatformPostgresMigrationRunner({
      connectionString: 'postgresql://starter_install@localhost/neutral_store?host=/var/run/postgresql',
    }, { installation: { generation: 'qualified-v2', roleMode: 'installer-managed',
      migrationLogin: installRole, bootstrapLogin: 'postgres', runtimeLogin: runtimeRole,
      restoreLogin: 'starter_restore' } });
    const applied = await runner.apply();
    const status = await runner.status();
    if (status.pending.length) throw new Error('starter_installation_incomplete');
    process.stdout.write(JSON.stringify({ migrations: status.applied.length, newlyApplied: applied.applied.length }) + '\n');
  } finally { await bootstrap.end(); }
  const connection = new pg.Client({ host: socket, database, user: installRole });
  await connection.connect();
  return { connection, installRole, runtimeRole, close: () => connection.end() };
}
