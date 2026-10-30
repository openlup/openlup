import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { expect } from "vitest";
import { copyTransferObjects, createFilesystemTransferObjects, type CompatiblePostgresSnapshot } from "@openlup/platform/portability";
import { captureManagedSourceGraph, managedIdentityEvidence, mapManagedRetainedBusiness } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { mapManagedIdentityForConnectedRestore, restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createS3TransferObjectSource } from "../../server/adapters/s3/transferObjectSource.js";
import { disposableLabelArgs } from "../../scripts/disposable-docker.mjs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const run = promisify(execFile);
const selection = { generation: "qualified-v2" as const, roleMode: "installer-managed" as const,
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
const limits = { maximumObjectBytes: 1024, maximumTotalBytes: 4096, maximumFiles: 10, maximumPages: 4 };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const free = (port: number) => new Promise<boolean>((resolve, reject) => {
  const server = createServer();
  server.once("error", error => error.message.includes("EADDRINUSE") ? resolve(false) : reject(error));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});
async function block(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = 55000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 8000;
    if ((await Promise.all([0, 1, 2, 3, 4, 9, 10].map(offset => free(value + offset)))).every(Boolean)) return value;
  }
  throw new Error("No disposable managed port block");
}
function snapshot(pool: Pool, managedSource = false): CompatiblePostgresSnapshot {
  return { async withSnapshot(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (managedSource) await client.query("SET LOCAL ROLE postgres");
      const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } };
}
const capture = (pool: Pool) => captureManagedSourceGraph({ source: snapshot(pool, true), sourceId: "managed-storage-source",
  maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 });
const fresh = (pool: Pool) => captureConnectedNativeStore({ source: snapshot(pool),
  sourceId: `qualified-target-${randomUUID()}`, catalogueId: selected.objectInventorySha256,
  maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 });
const objectReader = (client: S3Client, bucket: string) => createS3TransferObjectSource({ client, bucket, ...limits });

async function main() {
  const awsModule = ["@aws-sdk", "client-s3"].join("/");
  const sdk = createRequire(import.meta.url)(awsModule) as typeof import("@aws-sdk/client-s3");
  await mkdir(join(process.cwd(), ".context/scratch"), { recursive: true });
  const scratch = await mkdtemp(join(process.cwd(), ".context/scratch/m14-managed-storage-"));
  // The opt-in service runner supplies only a private, explicitly selected source.
  // Required discovery clears this input and always runs the stock-PG adapter.
  const suppliedPath = process.env.OPENLUP_M14_STORAGE_INPUT;
  const supplied = suppliedPath === undefined ? undefined : JSON.parse(readFileSync(suppliedPath, "utf8")) as {
    port: number; bucket: string; customer: string; clientId: string; customerToken: string;
    endpoint: string; region: string; accessKeyId: string; secretAccessKey: string;
  };
  const targetPort = await block();
  const bucket = supplied?.bucket ?? `managed${randomBytes(4).toString("hex")}`;
  const targetBucket = `target${randomBytes(4).toString("hex")}`;
  const finalBucket = `final${randomBytes(4).toString("hex")}`;
  const container = `m14-object-target-${process.pid}-${randomBytes(3).toString("hex")}`;
  const s3Access = `m14${randomBytes(8).toString("hex")}`, s3Secret = randomBytes(24).toString("hex");
  let sourceContainer: Awaited<ReturnType<typeof runManagedCompatPostgres>> | undefined;
  let erasureFixtureCreated = false;
  let targetStarted = false, pgContainer: Awaited<ReturnType<typeof runPostgresContainer>> | undefined;
  let managed: Pool | undefined, bootstrap: Pool | undefined, target: Pool | undefined;
  let sourceS3: S3Client | undefined, targetS3: S3Client | undefined;
  try {
    const admin = randomUUID(), clientId = supplied?.clientId ?? randomUUID(), customer = supplied?.customer ?? randomUUID();
    const customerEmail = `${customer}@example.invalid`;
    if (supplied) {
      if (!Number.isSafeInteger(supplied.port) || supplied.port < 1024 || supplied.port > 65535)
        throw new Error("Selected source requires a loopback port");
      managed = new Pool({ connectionString: `postgresql://supabase_admin:postgres@127.0.0.1:${supplied.port}/postgres`, max: 2 });
    } else {
      sourceContainer = await runManagedCompatPostgres({ name: `m14-storage-source-${process.pid}`, password: "synthetic-transfer" });
      managed = new Pool({ connectionString: sourceContainer.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 2 });
      await managed.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"])
        for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"])
          await managed.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,anon,authenticated,service_role`);
      const baseline = readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql");
      if (sha(baseline) !== "fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe")
        throw new Error("Managed baseline pin changed");
      await managed.query("SET ROLE postgres; SET search_path=public,extensions");
      await managed.query(baseline.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
      await managed.query("RESET ROLE");
      // Add the finite fields consumed by this projection to this disposable
      // fixture only. The opt-in runner separately records the service schema.
      await managed.query(`ALTER TABLE storage.buckets
        ADD COLUMN type text DEFAULT 'STANDARD', ADD COLUMN file_size_limit bigint,
        ADD COLUMN allowed_mime_types text[], ADD COLUMN avif_autodetection boolean DEFAULT false,
        ADD COLUMN versioning_status text DEFAULT 'DISABLED', ADD COLUMN lifecycle_configuration jsonb,
        ADD COLUMN lifecycle_configuration_generation bigint;
        ALTER TABLE storage.objects ADD COLUMN owner uuid, ADD COLUMN user_metadata jsonb,
        ADD COLUMN version text, ADD COLUMN archived_at timestamptz,
        ADD COLUMN is_delete_marker boolean DEFAULT false, ADD COLUMN is_versioned boolean DEFAULT false,
        ADD COLUMN path_tokens text[];
        ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`);
      for (const id of [admin, customer]) await managed.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, `${id}@example.invalid`]);
      await managed.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)",
        [admin, `${admin}@example.invalid`]);
      await managed.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
        [clientId, customerEmail, customer]);
    }
    // Disposable receipt fixture: the pinned managed baseline predates this
    // existing item-7 input. The managed actor namespace has no native FK.
    await managed.query(`CREATE TABLE public.identity_privacy_erasures (
  erasure_id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  client_id uuid UNIQUE REFERENCES public.clients(id),
  principal_id uuid UNIQUE,
  actor_principal_id uuid NOT NULL,
  contract_version text NOT NULL CHECK (contract_version = 'identity.erasure.v1'),
  contributor_versions jsonb NOT NULL,
  dispositions jsonb NOT NULL,
  retained_obligations jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  CHECK (client_id IS NOT NULL OR principal_id IS NOT NULL)
)`);
    erasureFixtureCreated = true;
    if (!(await managed.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('postgres','public.identity_privacy_erasures','SELECT') AS allowed")).rows[0]?.allowed)
      await managed.query("GRANT SELECT ON public.identity_privacy_erasures TO postgres");
    pgContainer = await runPostgresContainer({ name: `m14-storage-pg-${process.pid}`, password: "synthetic-transfer" });
    expect(await waitForPostgresTcpReady(pgContainer.connectionString)).toBe(true);
    bootstrap = new Pool({ connectionString: pgContainer.connectionString });
    await bootstrap.query(`CREATE ROLE transfer_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
      ALTER DATABASE postgres OWNER TO transfer_owner;
      CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
      CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer'`);
    const targetUrl = new URL(pgContainer.connectionString); targetUrl.username = selection.migrationLogin;
    const plainUrl = targetUrl.toString();
    targetUrl.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    target = new Pool({ connectionString: targetUrl.toString() });
    const runner = createPostgresMigrationRunner({ connectionString: plainUrl }, { installation: selection, poolFactory: () => target! });
    expect((await runner.apply()).applied).toEqual([selected.baseline, ...selected.forward].map(unit => unit.file));
    const targetEndpoint = `http://127.0.0.1:${targetPort + 1}`;
    const compose = readFileSync("docker-compose.yml", "utf8");
    const image = /\n {4}image: (\S+)\n/.exec(compose.slice(compose.indexOf("\n  object-storage:\n")))?.[1];
    if (!image) throw new Error("Missing pinned local S3 image");
    await run("docker", ["run", ...disposableLabelArgs(), "-d", "--rm", "--name", container,
      "-p", `127.0.0.1:${targetPort + 1}:7070`, "--read-only", "--tmpfs", "/data", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", image, "--access", s3Access, "--secret", s3Secret, "posix", "/data"],
    { timeout: 30_000 });
    targetStarted = true;
    targetS3 = new sdk.S3Client({ region: "us-east-1", endpoint: targetEndpoint, forcePathStyle: true,
      credentials: { accessKeyId: s3Access, secretAccessKey: s3Secret } });
    let s3Ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await targetS3.send(new sdk.ListBucketsCommand({})); s3Ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!s3Ready) throw new Error("Local S3 target did not become ready");
    for (const name of [targetBucket, finalBucket]) await targetS3.send(new sdk.CreateBucketCommand({ Bucket: name }));
    sourceS3 = supplied ? new sdk.S3Client({ region: supplied.region, endpoint: supplied.endpoint, forcePathStyle: true,
      credentials: { accessKeyId: supplied.accessKeyId, secretAccessKey: supplied.secretAccessKey } }) : targetS3;
    if (!supplied) {
      await sourceS3.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
      await managed.query("INSERT INTO storage.buckets(id,name,public) VALUES($1,$1,false)", [bucket]);
    }
    const first = Buffer.from("managed original bytes"), second = Buffer.from("managed second bytes");
    const put = async (key: string, body: Buffer) => {
      await sourceS3!.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key,
        Body: body, ContentType: "application/octet-stream", CacheControl: "private, max-age=60", Metadata: { witness: "managed" } }));
      if (!supplied) {
        await managed!.query("DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2", [bucket, key]);
        await managed!.query(`INSERT INTO storage.objects(bucket_id,name,owner_id,metadata,user_metadata,path_tokens)
          VALUES($1,$2,NULL,$3::jsonb,'{"witness":"managed"}',$4::text[])`,
        [bucket, key, JSON.stringify({ size: body.length, mimetype: "application/octet-stream" }), key.split("/")]);
      }
    };
    const remove = async (key: string) => {
      await sourceS3!.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
      if (!supplied) await managed!.query("DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2", [bucket, key]);
    };
    if (!supplied) { await put("first.txt", first); await put("second.txt", second); }
    await managed.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2 AND name='first.txt'", [customer, bucket]);
    expect((await managed.query("SELECT name,owner_id FROM storage.objects WHERE bucket_id=$1 ORDER BY name", [bucket])).rows)
      .toEqual([{ name: "first.txt", owner_id: customer }, { name: "second.txt", owner_id: null }]);
    const sourceReader = objectReader(sourceS3, bucket);
    const project = async () => {
      const source = await capture(managed!);
      const baseline = await fresh(target!);
      const mapped = await mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
        freshTarget: baseline, targetOwner: target!, storageSources: new Map([[bucket, sourceReader]]) });
      expect(mapped.storageObjects).toHaveLength(1);
      return { mapped, baseline };
    };
    const preliminary = await project();
    expect(preliminary.mapped.storageObjects[0]!.inventory.objects).toHaveLength(2);
    const stage = async (generation: string, mapped: Awaited<ReturnType<typeof project>>["mapped"], targetName: string,
      interrupt = false) => {
      const projected = mapped.storageObjects[0]!;
      const destination = await createFilesystemTransferObjects({ root: join(scratch, generation),
        maximumObjectBytes: 1024, access: "private-target" });
      const input = { inventory: projected.inventory, source: projected.source, destination,
        accessMapping: { "authenticated-source-read": "private-target" }, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
      if (interrupt) await expect(copyTransferObjects({ ...input, checkpoint: async () => { throw new Error("interrupted checkpoint"); } }))
        .rejects.toThrow("interrupted checkpoint");
      const result = await copyTransferObjects(input);
      if (generation === "final")
        await expect(destination.read("second.txt")).rejects.toMatchObject({ code: "absent" });
      for (const object of projected.inventory.objects) {
        const read = await destination.read(object.key);
        expect(read.object.metadata).toEqual(object.metadata);
        expect(read.object.access).toBe("private-target");
        const chunks: Buffer[] = []; for await (const part of read.body) chunks.push(Buffer.from(part));
        const bytes = Buffer.concat(chunks);
        expect(sha(bytes)).toBe(object.sha256);
        await targetS3!.send(new sdk.PutObjectCommand({ Bucket: targetName, Key: object.key, Body: bytes,
          ContentType: object.metadata["s3.content-type"], CacheControl: object.metadata["s3.cache-control"],
          Metadata: Object.fromEntries(Object.entries(object.metadata).filter(([key]) => key.startsWith("s3.user."))
            .map(([key, value]) => [key.slice("s3.user.".length), value])) }));
        const copied = await objectReader(targetS3!, targetName).read(object.key);
        expect(copied.object.sha256).toBe(object.sha256);
        expect(copied.object.bytes).toBe(object.bytes);
        expect(copied.object.metadata["s3.content-type"]).toBe(object.metadata["s3.content-type"]);
        expect(copied.object.metadata["s3.user.witness"]).toBe(object.metadata["s3.user.witness"]);
      }
      return result;
    };
    expect(await stage("preliminary", preliminary.mapped, targetBucket, true)).toMatchObject({ replayed: 1, copied: 1 });
    const token = supplied?.customerToken ?? "synthetic-customer-with-no-serving-route";
    const targetObjectUrl = `${targetEndpoint}/${targetBucket}/first.txt`;
    for (const [url, headers] of [
      [targetObjectUrl, {}], [targetObjectUrl, { Authorization: `Bearer ${token}` }],
    ] as const) expect([400, 401, 403, 404]).toContain((await fetch(url, { headers })).status);
    expect([400, 401, 403, 404]).toContain((await fetch(targetObjectUrl, { method: "PUT", body: "unauthorized" })).status);
    expect((await sourceReader.read("first.txt")).object.sha256).toBe(sha(first));
    expect((await objectReader(targetS3, targetBucket).read("first.txt")).object.sha256).toBe(sha(first));

    // Both relations must retain row security for policy-free admission.
    for (const relation of ["storage.buckets", "storage.objects"]) {
      await managed.query(`ALTER TABLE ${relation} DISABLE ROW LEVEL SECURITY`);
      try { await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.objects" }); }
      finally { await managed.query(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY`); }
    }

    await managed.query("UPDATE storage.buckets SET file_size_limit=1 WHERE id=$1", [bucket]);
    await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.buckets" });
    await managed.query("UPDATE storage.buckets SET file_size_limit=NULL WHERE id=$1", [bucket]);
    const originalUserMetadata = (await managed.query<{ user_metadata: unknown }>(
      "SELECT user_metadata FROM storage.objects WHERE bucket_id=$1 AND name='first.txt'", [bucket])).rows[0]!.user_metadata;
    await managed.query("UPDATE storage.objects SET user_metadata=$1::jsonb WHERE bucket_id=$2 AND name='first.txt'",
      [JSON.stringify({ nested: { value: "unsupported" } }), bucket]);
    // The service returns this unsupported field to the S3 reader; Versity's
    // independent bytes expose the row/response conflict at the mapper instead.
    await expect(project()).rejects.toMatchObject({ code: supplied ? "integrity_conflict" : "target_conflict" });
    await managed.query("UPDATE storage.objects SET user_metadata=$1::jsonb WHERE bucket_id=$2 AND name='first.txt'",
      [JSON.stringify(originalUserMetadata), bucket]);
    await managed.query("UPDATE storage.objects SET owner=$1 WHERE bucket_id=$2 AND name='first.txt'",
      [randomUUID(), bucket]);
    await expect(project()).rejects.toMatchObject({ code: "invalid_input", table: "storage.objects" });
    await managed.query("UPDATE storage.objects SET owner=NULL WHERE bucket_id=$1 AND name='first.txt'", [bucket]);
    await managed.query("UPDATE storage.buckets SET public=true WHERE id=$1", [bucket]);
    await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.buckets" });
    await managed.query("UPDATE storage.buckets SET public=false WHERE id=$1", [bucket]);
    await managed.query("CREATE POLICY m14_storage_probe ON storage.objects FOR SELECT TO service_role USING (true)");
    await expect(project()).resolves.toBeDefined();
    await managed.query("DROP POLICY m14_storage_probe ON storage.objects");
    for (const roles of ["authenticated", "PUBLIC", "service_role,authenticated"]) {
      await managed.query(`CREATE POLICY m14_storage_probe ON storage.objects FOR SELECT TO ${roles} USING (true)`);
      await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.objects" });
      await managed.query("DROP POLICY m14_storage_probe ON storage.objects");
    }
    await managed.query("UPDATE public.clients SET email=$1,auth_user_id=NULL WHERE id=$2",
      [`erased+${clientId}@identity.invalid`, clientId]);
    await managed.query("DELETE FROM auth.users WHERE id=$1", [customer]);
    await expect(project()).rejects.toMatchObject({ code: "invalid_input" });
    await managed.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [customer, customerEmail]);
    await managed.query("UPDATE public.clients SET email=$1,auth_user_id=$2 WHERE id=$3", [customerEmail, customer, clientId]);

    // Collect both guard discriminators so one guard-removal run must expose
    // both failures rather than stopping after the first unexpectedly admitted owner.
    const ownerRefusalFailures: string[] = [];
    const expectOwnerRefusal = async (label: string) => {
      try { await expect(project()).rejects.toMatchObject({ code: "target_conflict", table: "storage.objects" }); }
      catch (error) { ownerRefusalFailures.push(`${label}: ${String(error)}`); }
    };
    const unmappedOwner = randomUUID();
    await managed.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2 AND name='first.txt'", [unmappedOwner, bucket]);
    await expectOwnerRefusal("sole-unmapped-owner");
    await managed.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2 AND name='first.txt'", [customer, bucket]);

    const erasureId = randomUUID();
    const operator = (await managed.query<{ id: string }>(
      "SELECT id FROM public.admin_users WHERE is_machine_actor=false AND membership_state='active' ORDER BY id LIMIT 1")).rows[0]!;
    await managed.query(`INSERT INTO public.identity_privacy_erasures
      (erasure_id,idempotency_key,client_id,principal_id,actor_principal_id,contract_version,
       contributor_versions,dispositions,retained_obligations,completed_at)
      VALUES($1,$2,$3,$4,$5,'identity.erasure.v1','{"identity":1}',
        '[{"resource":"contact","disposition":"erased"}]','[]','2025-02-01T00:00:00.123456Z')`,
    [erasureId, randomUUID(), clientId, customer, operator.id]);
    await managed.query(`UPDATE public.clients SET email=$1,auth_user_id=NULL,first_name=NULL,
      last_name=NULL,phone=NULL,country=NULL,lifecycle_stage='inactive' WHERE id=$2`,
    [`erased+${clientId}@identity.invalid`, clientId]);
    await managed.query("DELETE FROM auth.users WHERE id=$1", [customer]);
    const erasedCapture = await capture(managed);
    const identity = await mapManagedIdentityForConnectedRestore({
      source: managedIdentityEvidence(erasedCapture, "https://issuer.example.invalid/managed"),
      freshTarget: await fresh(target), targetOwner: target });
    expect(identity.subjects.some(subject => subject.managedId === customer)).toBe(true);
    await expectOwnerRefusal("completed-erasure-owner");
    await managed.query("DELETE FROM public.identity_privacy_erasures WHERE erasure_id=$1", [erasureId]);
    await managed.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [customer, customerEmail]);
    await managed.query("UPDATE public.clients SET email=$1,auth_user_id=$2,lifecycle_stage='customer' WHERE id=$3",
      [customerEmail, customer, clientId]);
    expect(ownerRefusalFailures).toEqual([]);

    await remove("first.txt");
    await remove("second.txt");
    const empty = await project();
    expect(empty.mapped.storageObjects[0]!.inventory.objects).toEqual([]);
    await put("second.txt", second);
    const updated = Buffer.from("managed updated bytes");
    await put("first.txt", updated);
    await managed.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2 AND name='first.txt'", [customer, bucket]);
    await remove("second.txt");
    const final = await project();
    expect(final.mapped.storageObjects[0]!.inventory.objects.map(object => object.key)).toEqual(["first.txt"]);
    expect(await stage("final", final.mapped, finalBucket)).toMatchObject({ copied: 1, replayed: 0 });
    await expect(objectReader(targetS3, finalBucket).read("second.txt")).rejects.toMatchObject({ code: "absent" });
    expect((await objectReader(targetS3, finalBucket).read("first.txt")).object.sha256).toBe(sha(updated));
    expect(await restoreConnectedNativeStore({ owner: target, installation: selection,
      packet: final.mapped.packet, freshTarget: final.baseline })).toMatchObject({ replayed: false });
  } finally {
    try {
      if (erasureFixtureCreated) await managed!.query("DROP TABLE public.identity_privacy_erasures");
    } finally {
      sourceS3?.destroy(); targetS3?.destroy();
      await managed?.end(); await target?.end(); await bootstrap?.end();
      if (targetStarted) await run("docker", ["rm", "-f", container], { timeout: 30_000 }).catch(() => {});
      await pgContainer?.remove();
      await sourceContainer?.remove();
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

await main();
process.stdout.write("managed-storage-proof PASS\n");
