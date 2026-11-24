import { installCheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/server';
import { installRenewalStockProtectionPolicy } from '@openlup/platform/inventory';
import type { StoreConfig } from '../shared/config.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import type { FulfillmentStockSyncPort } from '@openlup/platform/fulfillment/contracts';
import * as ownedCatalogue from '../owned/catalogue.ts';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { CatalogDefinitionInstallError, catalogPackInstallIssues, catalogPackIssues, catalogProductTypeIssues, createCatalogProductTypeRegistry,
  installCatalogDefinitions, withCatalogPublicationRules, type CatalogPackInput, type CatalogProductTypeInput } from '@openlup/platform/catalog';
import { constants, readFileSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQuoteAcceptanceKeyring } from '../host/quote-secret.ts';
import { buildRefusal, installationFailure, isInstallationRefusal, packBuildFilename, refusal, rulesRecheck, up } from './refusals.ts';

export const demonstrationMarker = 'openlup-neutral-store-demo-v1';

/** One dedicated install session, never a runtime pool or HTTP binding. */
export interface InstallConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Container-local demo material; never provision a customer installation. */
export async function prepareDemonstrationQuoteKey(connection: InstallConnection, directory: string): Promise<string> {
  const { rows } = await connection.query(`SELECT pg_catalog.shobj_description(oid, 'pg_database') AS marker
    FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()`);
  if (rows[0]?.marker !== demonstrationMarker) throw new Error('starter_seed_demonstration_database_required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700
    || parent.uid !== process.getuid?.()) throw new Error('starter_quote_acceptance_key_invalid');
  const path = resolve(directory, 'quote-acceptance-keyring.json');
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify({ current: randomBytes(32).toString('base64url') }) + '\n');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally { await handle?.close(); }
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o777) !== 0o600
    || file.uid !== process.getuid?.()) throw new Error('starter_quote_acceptance_key_invalid');
  await readQuoteAcceptanceKeyring(path);
  return path;
}

/** Called by the installer on its private connection, after the qualified forward. */
export async function provisionDemonstrationPublicationPassword(connection: InstallConnection, path: string): Promise<string> {
  const temporary = await mkdtemp(resolve(dirname(path), '.publication-'));
  const source = resolve(temporary, 'password');
  try {
    await writeFile(source, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    try { await link(source, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let password: string;
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o777) !== 0o600 || file.size !== 65)
      throw new Error('starter_catalogue_publication_password_invalid');
    password = (await handle.readFile('utf8')).trim();
    if (!/^[a-f0-9]{64}$/u.test(password)) throw new Error('starter_catalogue_publication_password_invalid');
  } finally { await handle.close(); }
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  const verifier = `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
  await connection.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${verifier}'`);
  return password;
}

export interface DemonstrationInstallation {
  connection: InstallConnection;
  stock?: Pick<FulfillmentStockSyncPort,'recordProviderStockCurrent'>;
  catalogueRules?: Uint8Array;
  catalogueBuildDirectory?: string;
  installRole: string;
  runtimeRole: string;
  close(): Promise<void>;
}

export type InstallationBootstrap = (config: StoreConfig, progress?: NodeJS.WritableStream) => Promise<DemonstrationInstallation>;

const rulesFile = 'owned/catalogue-rules.cjs';
function installerRoleRequired() {
  return refusal('starter_seed_install_role_required', '', 'The seed connection did not have the configured installer identity.',
    'The login and effective role must both be the demo installer and must differ from the runtime role.',
    "Restore the starter's isolated Compose installation service and its installer binding.");
}

function demonstrationDatabaseRequired() {
  return refusal('starter_seed_demonstration_database_required', '', 'The target database lacks the starter\'s demonstration marker.',
    'The demo seed is allowed only on a database created and marked for this Compose project.',
    'Use the intended marked demo database. For an abandoned, disposable local demo only, follow “Reset an interrupted first install” in the installed starter guide.',
    'Run `./lifecycle up` in that demo project.');
}

function packInvalid(path: string, finding: string) {
  if (finding === 'starter_catalogue_conformance_missing')
    return refusal('starter_catalogue_pack_invalid', path, 'The owned catalogue module does not export catalogueConformance.',
      'The installer requires catalogueConformance.packs to read adopter pack declarations.',
      "Add the catalogueConformance export to owned/catalogue.ts as the upgrade guide's owned-module step describes, keeping your existing validator and drafts.",
      'Run `npm run catalogue:check:source`, then `./lifecycle up`.');
  if (finding === 'starter_pack_identity_reserved')
    return refusal('starter_catalogue_pack_invalid', path, `The adopter pack uses a reserved starter identity at ${path}.`,
      'The starter reserves the namespace `starter` and IDs beginning with `starter`.',
      'Use an application-owned pack ID and namespace, and update affected type keys and owned fixture references to match.',
      'Run `./lifecycle up`. The source check alone does not enforce this reservation.');
  return refusal('starter_catalogue_pack_invalid', path, `The adopter pack has finding ${finding} at ${path}.`,
    'The declaration fails an offline catalogue definition check or an installation requirement identified by the finding.',
    'Correct the declaration at the reported path. Use the source check for its definition findings, then run the installer to verify installation requirements.',
    'Run `npm run catalogue:check:source`, then `./lifecycle up`.');
}

const starterCodes = {
  catalog_definition_install_conflict: 'starter_catalogue_pack_version_conflict',
  catalog_type_install_refuses_redefinition: 'starter_catalogue_type_redefinition',
  catalog_profile_install_refuses_redefinition: 'starter_catalogue_profile_redefinition',
  definition_unknown_profile_ref: 'starter_catalogue_profile_ref_missing',
  catalog_definition_rules_binding_failed: 'starter_catalogue_rules_invalid',
} satisfies Record<CatalogDefinitionInstallError['code'], string>;

function installRefusal(error: unknown, path?: string) {
  if (!(error instanceof CatalogDefinitionInstallError)) return installationFailure(error);
  const legacy = path === undefined;
  const rules = error.code === 'catalog_definition_rules_binding_failed';
  return refusal(starterCodes[error.code], legacy ? rules ? rulesFile : 'owned/catalogue.ts' : path + error.path,
    error.observed, error.causeText, legacy
      ? 'Restore the original starter fixture and rules inputs. For a disposable demo, follow “Reset an interrupted first install” in the installed starter guide.'
      : error.fix,
    rules ? rulesRecheck : up);
}

function plainRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(input));
}

function snapshotData(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(snapshotData);
  if (plainRecord(input)) return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, snapshotData(value)]));
  return input;
}

function readRules() {
  try { return readFileSync(new URL('../owned/catalogue-rules.cjs', import.meta.url)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

function admitPacks(rulesFor: () => Uint8Array | undefined) {
  if (!Object.hasOwn(ownedCatalogue, 'catalogueConformance'))
    throw packInvalid('owned/catalogue.ts#catalogueConformance', 'starter_catalogue_conformance_missing');
  const source: unknown = ownedCatalogue.catalogueConformance?.packs;
  if (!Array.isArray(source)) throw packInvalid('/packs', 'conformance_subject_invalid');
  const entries = Array.from(source, (entry: unknown, index) => {
    if (!plainRecord(entry) || !Object.hasOwn(entry, 'pack') || !Array.isArray(entry.drafts)
      || Object.keys(entry).length !== 2) throw packInvalid(`/packs/${index}`, 'conformance_subject_invalid');
    return { pack: snapshotData(entry.pack), path: `/packs/${index}/pack` };
  });
  const fixtures = entries.filter(({ pack }) => plainRecord(pack) && pack.id === 'starter');
  const adopters = entries.filter(({ pack }) => !plainRecord(pack) || pack.id !== 'starter');
  let bytes: Uint8Array | undefined;
  try { bytes = rulesFor(); } catch (error) { throw installationFailure(error, rulesFile); }
  if (!bytes && adopters.length) throw refusal('starter_catalogue_rules_required', rulesFile,
    `The rules file is absent for ${adopters.length} adopter packs.`, 'Installing an adopter pack requires a publication rules bundle.',
    "Add the rules module at `owned/catalogue-rules.cjs` using the starter's rules skeleton, then rebuild the demonstration image through the lifecycle command.");
  const artifact = bytes && Buffer.from(bytes);
  const types: CatalogProductTypeInput[] = [];
  const typePaths: string[] = [];
  const packs: { pack: CatalogPackInput; path: string }[] = [];
  let failure: { error: unknown } | undefined;
  try {
    for (const { pack, path } of adopters) {
      const field = plainRecord(pack) && (pack.namespace === 'starter' ? 'namespace'
        : typeof pack.id === 'string' && pack.id.startsWith('starter') ? 'id' : undefined);
      if (field) throw packInvalid(`${path}/${field}`, 'starter_pack_identity_reserved');
      const [finding] = catalogPackIssues(pack);
      if (finding) throw packInvalid(path + finding.path, finding.code);
      const declaration = pack as CatalogPackInput;
      if (!packBuildFilename(declaration.id, declaration.version)) throw buildRefusal('starter_catalogue_pack_invalid',
        `${path}/id`, 'The adopter pack ID cannot form the required build filename.');
      declaration.types.forEach((type, index) => {
        types.push(type);
        typePaths.push(`${path}/types/${index}`);
      });
      let bound;
      try { bound = withCatalogPublicationRules(declaration, () => artifact); }
      catch (error) { throw installRefusal(error, path); }
      const [installFinding] = catalogPackInstallIssues(bound);
      if (installFinding) throw packInvalid(path + installFinding.path, installFinding.code);
      packs.push({ pack: bound, path });
    }
  } catch (error) { failure = { error }; }
  // The prefix ends before a reservation or source finding, and includes the failing entry for binding or install findings.
  const duplicate = types.length && catalogProductTypeIssues(types).find(issue => issue.code === 'definition_duplicate_identity');
  if (duplicate) {
    const [, index, field] = duplicate.path.split('/');
    throw packInvalid(`${typePaths[Number(index)]}/${field}`, duplicate.code);
  }
  if (failure) throw failure.error;
  return { artifact, fixtures, packs };
}

async function withInstallationCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
  let result: T;
  try { result = await work(); }
  catch (error) {
    try { await cleanup(); }
    catch { /* Cleanup cannot replace the installation failure. */ }
    throw error;
  }
  try { await cleanup(); }
  catch (error) { throw installationFailure(error); }
  return result;
}

/** Called only by lifecycle up, once per installation invocation, before the HTTP host starts. */
export async function installDemonstration(config: StoreConfig, bootstrap: InstallationBootstrap, progress?: NodeJS.WritableStream) {
  let installation;
  try { installation = await bootstrap(config, progress); }
  catch (error) { throw installationFailure(error); }
  return withInstallationCleanup(
    () => applyDemoSeed(config, installation, bootstrap === bootstrapDemonstration ? readRules : undefined),
    () => installation.close());
}

/** Idempotent demo composition; stock uses its native writer. No schema, clients or subscription truth. */
export async function applyDemoSeed(config: StoreConfig, installation: DemonstrationInstallation,
  rulesFor = () => installation.catalogueRules) {
  let admitted;
  try { admitted = admitPacks(rulesFor); }
  catch (error) {
    throw installationFailure(error);
  }
  const { artifact, fixtures, packs } = admitted;
  const [{ editorProducts, stagePackBuild, stageStarterCatalogueBuild, starterCataloguePack, starterCatalogueType }, { buildDemoSeed }, { seedQuoteAuthority }] =
    await Promise.all([import('../host/editor-catalogue.ts'), import('../owned/demo-seed.ts'), import('./quote-seed.ts')])
      .catch(error => { throw installationFailure(error); });
  const { installRole, runtimeRole } = installation;
  const connection: InstallConnection = { async query(text, values) {
    try { return await installation.connection.query(text, values); }
    catch (error) { throw installationFailure(error); }
  } };
  if (!installRole || !runtimeRole || installRole === runtimeRole) throw installerRoleRequired();
  const seed = buildDemoSeed(config);
  await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  let stagedBuild: ReturnType<typeof stageStarterCatalogueBuild>;
  const adopterBuilds: { stage: NonNullable<typeof stagedBuild>; path: string }[] = [];
  const outcomes: { id: string; version: number; outcome: 'installed' | 'unchanged';
    types: { key: string; version: number }[]; taxClasses: string[] }[] = [];
  const atPack = (error: unknown, path: string) => isInstallationRefusal(error)
    ? refusal(error.code, path, error.observed, error.causeText, error.fix, error.recheck) : error;
  function discardAdopterBuilds() {
    let failure: { error: unknown } | undefined;
    for (const { stage } of adopterBuilds) {
      try { stage.discard(); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  }
  try {
    const { rows } = await connection.query(`SELECT session_user AS login, current_user AS role,
      pg_catalog.shobj_description(oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()`);
    const target = rows[0];
    // Check both identities: SET ROLE must not turn a runtime login into an installer.
    if (target?.login === runtimeRole || target?.role === runtimeRole) {
      throw refusal('starter_seed_runtime_role_forbidden', '', 'The seed connection used the configured runtime login or effective role.',
        'Runtime connections cannot install catalogue definitions.',
        'Start the demo through its installation service with the installer login. Keep the runtime grants restricted.');
    }
    if (target?.login !== installRole || target?.role !== installRole) {
      throw installerRoleRequired();
    }
    if (target.marker !== demonstrationMarker) throw demonstrationDatabaseRequired();
    const legacyDefinition = createCatalogProductTypeRegistry(fixtures.flatMap(({ pack }) =>
      (pack as CatalogPackInput).types)).resolve(starterCatalogueType);
    let legacyPack;
    try { legacyPack = artifact && starterCataloguePack(artifact, () => legacyDefinition); }
    catch (error) {
      if (error instanceof CatalogDefinitionInstallError) throw installRefusal(error);
      throw error;
    }
    const catalogueReceipt = legacyPack
      ? await installCatalogDefinitions(installation.connection, legacyPack).catch(error => { throw installRefusal(error); }) : undefined;
    for (const { pack, path } of packs) {
      const { id, version, types, taxClasses } = pack;
      // The legacy install holds the owner's transaction lock before this read.
      const retained = await connection.query('SELECT 1 FROM public.catalog_definition_installs WHERE pack_id=$1 AND pack_version=$2', [id, version]);
      const receipt = await installCatalogDefinitions(installation.connection, pack).catch(error => { throw installRefusal(error, path); });
      try {
        const stage = stagePackBuild(pack, receipt, artifact!, installation.catalogueBuildDirectory);
        if (stage) adopterBuilds.push({ stage, path });
      } catch (error) { throw installationFailure(atPack(error, path), path); }
      outcomes.push({ id, version, outcome: retained.rows.length ? 'unchanged' : 'installed',
        types: types.map(({ key, version }) => ({ key, version })), taxClasses: taxClasses.map(({ key }) => key) });
    }
    for (const row of seed.products) await connection.query(`INSERT INTO public.catalog_products
      (id, slug, status, name, description) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, status=EXCLUDED.status,
        name=EXCLUDED.name, description=EXCLUDED.description`,
    [row.id, row.slug, row.status, row.name, row.description]);
    for (const row of seed.skus) await connection.query(`INSERT INTO public.catalog_skus
      (id, product_id, sku, title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription,net_weight_g)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET
        product_id=EXCLUDED.product_id, sku=EXCLUDED.sku, title=EXCLUDED.title, status=EXCLUDED.status,
        min_order_qty=EXCLUDED.min_order_qty, is_addon=EXCLUDED.is_addon,
        sellable_standalone=EXCLUDED.sellable_standalone, sellable_in_subscription=EXCLUDED.sellable_in_subscription,net_weight_g=EXCLUDED.net_weight_g`,
    [row.id, row.product_id, row.sku, row.title, row.status, row.min_order_qty,
      row.is_addon, row.sellable_standalone, row.sellable_in_subscription,row.net_weight_g]);
    await installRenewalStockProtectionPolicy(connection, config.inventory.renewalProtection);
    await installCheckoutRecoveryReminderSchedule(installation.connection, config.checkoutRecoveryReminders);
    const settlement = seed.priceLists[0]!;
    const settings = [...seed.settings, { key: 'settlement_region', value: settlement.region_code },
      { key: 'settlement_currency', value: settlement.currency }];
    for (const row of settings) await connection.query(`INSERT INTO public.commerce_settings(key,value_text)
      VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`, [row.key,row.value]);
    const stock = installation.stock ?? (await import('@openlup/platform/fulfillment').catch(error => { throw installationFailure(error); }))
      .createPostgresFulfillmentStockSyncPort(installation.connection,
      { sourceKey: `starter-demo:${config.id}`,readLocalInventoryStock: async () => [] });
    for (const product of editorProducts(config)) await stock.recordProviderStockCurrent({ requestKey: `starter-stock:${product.sku}`,snapshot: {
      providerRef: config.purchase.stock.providerRef,collectedAt: config.purchase.stock.collectedAt,sourceRevision: null,revisionSource: 'collection',quantityKind: 'snapshot',
      skuRef: product.sku,totalQuantity: product.stockQuantity,forSaleQuantity: product.stockQuantity,reservedOrUnavailableQuantity: 0,syncRunId: config.purchase.stock.syncRunId },
      inventoryClass: 'sellable',lastSyncedAt: config.purchase.stock.collectedAt,staleAfter: config.purchase.stock.staleAfter });
    for (const row of seed.priceLists) await connection.query(`INSERT INTO public.price_lists
      (id, name, region_code, currency, status, valid_from) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, region_code=EXCLUDED.region_code,
        currency=EXCLUDED.currency, status=EXCLUDED.status, valid_from=EXCLUDED.valid_from`,
    [row.id, row.name, row.region_code, row.currency, row.status, row.valid_from]);
    for (const row of seed.prices) {
      await connection.query(`INSERT INTO public.price_entries
        (id, price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active, valid_from)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.price_list_id, row.variant_id, row.mode, row.min_qty, row.unit_price_minor,
        row.amount_kind, row.active, row.valid_from]);
      const existing = (await connection.query(`SELECT id, price_list_id, variant_id, mode, min_qty,
        unit_price_minor, amount_kind, active, valid_from FROM public.price_entries WHERE id=$1 FOR SHARE`, [row.id])).rows[0];
      if (!existing || Object.entries(row).some(([key, value]) => key === 'valid_from'
        ? new Date(String(existing[key])).getTime() !== Date.parse(value as string)
        : existing[key] !== value)) throw new Error('starter_price_seed_conflict');
    }
    await seedQuoteAuthority(config, seed, connection);
    // The demonstration can attest the empty installed cohort for native price checks.
    if (catalogueReceipt) await connection.query(`SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()
      WHERE EXISTS (SELECT 1 FROM public.commerce_offer_policy_cohort_marking WHERE marked_count=0)
        AND NOT EXISTS (SELECT 1 FROM public.subscriptions
          WHERE offer_policy_assignment_state='legacy_frozen' AND NOT is_test_fixture)`);
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
    if (catalogueReceipt && artifact && legacyPack)
      stagedBuild = stageStarterCatalogueBuild(artifact, catalogueReceipt, installation.catalogueBuildDirectory, legacyPack.types[0]!);
    await connection.query('COMMIT');
  } catch (error) {
    try {
      try { try { discardAdopterBuilds(); } finally { stagedBuild?.discard(); } }
      finally { await connection.query('ROLLBACK'); }
    } catch { /* Cleanup cannot replace the installation failure. */ }
    throw error;
  }
  try {
    try { stagedBuild?.publish(); }
    finally { stagedBuild?.discard(); }
  } catch {
    // The definition is committed. Replaying this install can finish publishing its build.
    process.stderr.write('Catalogue rules committed. Run ./lifecycle up again to make the build available.\n');
  }
  return withInstallationCleanup(async () => {
    for (const { stage, path } of adopterBuilds) {
      try { stage.publish(); }
      catch (error) { throw installationFailure(atPack(error, path), '/packs', 'publish'); }
    }
    return outcomes;
  }, async () => {
    try { discardAdopterBuilds(); }
    catch (error) { throw installationFailure(error, '/packs', 'publish'); }
  });
}

/** Local demo only. Socket access is the install capability; the application never mounts it. */
export async function bootstrapDemonstration(config: StoreConfig, progress: NodeJS.WritableStream = process.stdout): Promise<DemonstrationInstallation> {
  const migrations = await import('@openlup/platform/migrations');
  if (typeof migrations.createPlatformPostgresMigrationRunner !== 'function')
    throw refusal('starter_installation_binding_required', 'installation/install.ts',
      'The installed @openlup/platform package does not provide the migration composition the demo installer needs.',
      'The demo installer requires the qualified platform migration runner from the pinned package.',
      "Install the exact @openlup/platform version pinned in the starter's package.json, then rebuild the demonstration image through the lifecycle command.");
  const createRunner = migrations.createPlatformPostgresMigrationRunner;
  const { default: pg } = await import('pg');
  const socket = '/var/run/postgresql';
  const database = 'neutral_store';
  const installRole = 'starter_install';
  const runtimeRole = 'starter_runtime';
  const bootstrap = new pg.Client({ host: socket, database: 'postgres', user: 'postgres' });
  await withInstallationCleanup(async () => {
    await bootstrap.connect();
    // Serialize database creation and marker admission across concurrent startup invocations.
    await bootstrap.query("SELECT pg_advisory_lock(hashtext('neutral-store-bootstrap'))");
    const existing = await bootstrap.query(`SELECT pg_catalog.shobj_description(oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database WHERE datname = $1`, [database]);
    if (existing.rows.length && existing.rows[0]?.marker !== demonstrationMarker) {
      throw demonstrationDatabaseRequired();
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
    const runner = createRunner({
      connectionString: 'postgresql://starter_install@localhost/neutral_store?host=/var/run/postgresql',
    }, { installation: { generation: 'qualified-v2', roleMode: 'installer-managed',
      migrationLogin: installRole, bootstrapLogin: 'postgres', runtimeLogin: runtimeRole,
      restoreLogin: 'starter_restore' } });
    const applied = await runner.apply();
    const status = await runner.status();
    if (status.pending.length) throw new Error('starter_installation_incomplete');
    await provisionDemonstrationPublicationPassword(bootstrap,
      fileURLToPath(new URL('../.context/catalogue-builds/.publication-password', import.meta.url)));
    progress.write(JSON.stringify({ migrations: status.applied.length, newlyApplied: applied.applied.length }) + '\n');
  }, () => bootstrap.end());
  const connection = new pg.Client({ host: socket, database, user: installRole });
  try {
    await connection.connect();
    const { createPostgresFulfillmentStockSyncPort } = await import('@openlup/platform/fulfillment');
    const stock = createPostgresFulfillmentStockSyncPort(connection, { sourceKey: `starter-demo:${config.id}`, readLocalInventoryStock: async () => [] });
    return { connection, stock, installRole, runtimeRole, close: () => connection.end() };
  } catch (error) {
    return withInstallationCleanup(async () => { throw error; }, () => connection.end());
  }
}
