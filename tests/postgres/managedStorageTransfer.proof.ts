import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { expect } from "vitest";
import { copyTransferObjects, createFilesystemTransferObjects, type CompatiblePostgresSnapshot } from "@openlup/platform/portability";
import { captureManagedSourceGraph, mapManagedRetainedBusiness } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createS3TransferObjectSource } from "../../server/adapters/s3/transferObjectSource.js";
import { deriveCliImages } from "../../scripts/ci-image-mirror.mjs";
import { disposableLabelArgs } from "../../scripts/disposable-docker.mjs";
import { prePullCliImages } from "../../scripts/public-ci-pgtap.mjs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
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
function snapshot(pool: Pool): CompatiblePostgresSnapshot {
  return { async withSnapshot(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } };
}
const capture = (pool: Pool) => captureManagedSourceGraph({ source: snapshot(pool), sourceId: "managed-storage-source",
  maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 });
const fresh = (pool: Pool) => captureConnectedNativeStore({ source: snapshot(pool),
  sourceId: `qualified-target-${randomUUID()}`, catalogueId: selected.objectInventorySha256,
  maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 });
const objectReader = (client: S3Client, bucket: string) => createS3TransferObjectSource({ client, bucket, ...limits });

async function main() {
  const awsModule = ["@aws-sdk", "client-s3"].join("/");
  const sdk = createRequire(import.meta.url)(awsModule) as typeof import("@aws-sdk/client-s3");
  const scratch = await mkdtemp(join(process.cwd(), ".context/scratch/m14-managed-storage-"));
  const sourceDirectory = join(scratch, "source"), projectId = `m14objects${process.pid}${randomBytes(3).toString("hex")}`;
  const port = await block();
  let targetPort = await block();
  while (Math.abs(targetPort - port) < 11) targetPort = await block();
  const bucket = `managed${randomBytes(4).toString("hex")}`;
  const targetBucket = `target${randomBytes(4).toString("hex")}`;
  const finalBucket = `final${randomBytes(4).toString("hex")}`;
  const container = `m14-object-target-${process.pid}-${randomBytes(3).toString("hex")}`;
  const s3Access = `m14${randomBytes(8).toString("hex")}`, s3Secret = randomBytes(24).toString("hex");
  let registry = "", sourceStarted = false, targetStarted = false, pgContainer: Awaited<ReturnType<typeof runPostgresContainer>> | undefined;
  let managed: Pool | undefined, bootstrap: Pool | undefined, target: Pool | undefined;
  let sourceS3: S3Client | undefined, targetS3: S3Client | undefined;
  try {
    if ((await run("supabase", ["--version"])).stdout.trim() !== "2.122.0") throw new Error("Pinned Supabase CLI required");
    const replacements: Record<string, string> = { PROJECT_ID: projectId, SHADOW_PORT: String(port), API_PORT: String(port + 1),
      DB_PORT: String(port + 2), STUDIO_PORT: String(port + 3), MAIL_PORT: String(port + 4),
      POOLER_PORT: String(port + 9), APP_PORT: String(port + 10) };
    const config = readFileSync("config/public-reference-subscription-supabase.toml", "utf8")
      .replace(/\{\{([A-Z_]+)\}\}/gu, (_, key: string) => replacements[key]!)
      + "\n[storage]\nenabled = true\n[storage.s3_protocol]\nenabled = true\n";
    await mkdir(join(sourceDirectory, "supabase"), { recursive: true });
    await writeFile(join(sourceDirectory, "supabase/config.toml"), config);
    registry = await prePullCliImages(deriveCliImages(process.cwd(), sourceDirectory));
    await run("env", [`SUPABASE_INTERNAL_IMAGE_REGISTRY=${registry}`, "supabase", "start", "--workdir", sourceDirectory,
      "--exclude", "realtime,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    sourceStarted = true;
    const status = JSON.parse((await run("supabase", ["status", "--workdir", sourceDirectory, "-o", "json"])).stdout) as Record<string, string>;
    for (const name of ["API_URL", "STORAGE_S3_URL", "S3_PROTOCOL_ACCESS_KEY_ID", "S3_PROTOCOL_ACCESS_KEY_SECRET",
      "S3_PROTOCOL_REGION", "ANON_KEY", "SERVICE_ROLE_KEY"])
      if (!status[name]) throw new Error(`Pinned managed status lacks ${name}; available keys: ${Object.keys(status).sort().join(",")}`);
    managed = new Pool({ connectionString: `postgresql://supabase_admin:postgres@127.0.0.1:${port + 2}/postgres`, max: 2 });
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
    await managed.query("DELETE FROM _realtime.feature_flags");
    const admin = randomUUID(), clientId = randomUUID();
    const customerEmail = `${randomUUID()}@example.invalid`, customerPassword = `Synthetic-${randomBytes(12).toString("hex")}`;
    const authHeaders = { apikey: status.SERVICE_ROLE_KEY!, Authorization: `Bearer ${status.SERVICE_ROLE_KEY!}`,
      "Content-Type": "application/json" };
    const created = await fetch(`${status.API_URL}/auth/v1/admin/users`, { method: "POST", headers: authHeaders,
      body: JSON.stringify({ email: customerEmail, password: customerPassword, email_confirm: true }) });
    if (!created.ok) throw new Error(`Managed customer creation failed (${created.status})`);
    const customer = (await created.json() as { id: string }).id;
    await managed.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [admin, `${admin}@example.invalid`]);
    await managed.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)",
      [admin, `${admin}@example.invalid`]);
    await managed.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
      [clientId, customerEmail, customer]);
    sourceS3 = new sdk.S3Client({ region: status.S3_PROTOCOL_REGION!, endpoint: status.STORAGE_S3_URL!, forcePathStyle: true,
      credentials: { accessKeyId: status.S3_PROTOCOL_ACCESS_KEY_ID!, secretAccessKey: status.S3_PROTOCOL_ACCESS_KEY_SECRET! } });
    await sourceS3.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
    const first = Buffer.from("managed original bytes"), second = Buffer.from("managed second bytes");
    const put = (key: string, body: Buffer) => sourceS3!.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key,
      Body: body, ContentType: "application/octet-stream", CacheControl: "private, max-age=60", Metadata: { witness: "managed" } }));
    await put("first.txt", first);
    await put("second.txt", second);
    await managed.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2 AND name='first.txt'", [customer, bucket]);
    expect((await managed.query("SELECT name,owner_id FROM storage.objects WHERE bucket_id=$1 ORDER BY name", [bucket])).rows)
      .toEqual([{ name: "first.txt", owner_id: customer }, { name: "second.txt", owner_id: null }]);
    const sourceReader = objectReader(sourceS3, bucket);

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
    const signedIn = await fetch(`${status.API_URL}/auth/v1/token?grant_type=password`, { method: "POST",
      headers: { apikey: status.ANON_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ email: customerEmail, password: customerPassword }) });
    if (!signedIn.ok) throw new Error(`Managed customer sign-in failed (${signedIn.status})`);
    const token = (await signedIn.json() as { access_token: string }).access_token;
    const sourceObjectUrl = `${status.API_URL}/storage/v1/object/authenticated/${bucket}/first.txt`;
    const targetObjectUrl = `${targetEndpoint}/${targetBucket}/first.txt`;
    for (const [url, headers] of [
      [sourceObjectUrl, { apikey: status.ANON_KEY!, Authorization: `Bearer ${status.ANON_KEY!}` }],
      [sourceObjectUrl, { apikey: status.ANON_KEY!, Authorization: `Bearer ${token}` }],
      [targetObjectUrl, {}], [targetObjectUrl, { Authorization: `Bearer ${token}` }],
    ] as const) expect([400, 401, 403, 404]).toContain((await fetch(url, { headers })).status);
    expect([400, 401, 403, 404]).toContain((await fetch(targetObjectUrl, { method: "PUT", body: "unauthorized" })).status);
    const operatorRead = await fetch(sourceObjectUrl, { headers: {
      apikey: status.SERVICE_ROLE_KEY!, Authorization: `Bearer ${status.SERVICE_ROLE_KEY!}` } });
    expect(operatorRead.status).toBe(200);
    expect(sha(new Uint8Array(await operatorRead.arrayBuffer()))).toBe(sha(first));
    expect((await sourceReader.read("first.txt")).object.sha256).toBe(sha(first));
    expect((await objectReader(targetS3, targetBucket).read("first.txt")).object.sha256).toBe(sha(first));

    await managed.query("UPDATE storage.buckets SET file_size_limit=1 WHERE id=$1", [bucket]);
    await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.buckets" });
    await managed.query("UPDATE storage.buckets SET file_size_limit=NULL WHERE id=$1", [bucket]);
    const originalUserMetadata = (await managed.query<{ user_metadata: unknown }>(
      "SELECT user_metadata FROM storage.objects WHERE bucket_id=$1 AND name='first.txt'", [bucket])).rows[0]!.user_metadata;
    await managed.query("UPDATE storage.objects SET user_metadata=$1::jsonb WHERE bucket_id=$2 AND name='first.txt'",
      [JSON.stringify({ nested: { value: "unsupported" } }), bucket]);
    await expect(project()).rejects.toMatchObject({ code: "integrity_conflict" });
    await managed.query("UPDATE storage.objects SET user_metadata=$1::jsonb WHERE bucket_id=$2 AND name='first.txt'",
      [JSON.stringify(originalUserMetadata), bucket]);
    await managed.query("UPDATE storage.objects SET owner=$1 WHERE bucket_id=$2 AND name='first.txt'",
      [randomUUID(), bucket]);
    await expect(project()).rejects.toMatchObject({ code: "invalid_input", table: "storage.objects" });
    await managed.query("UPDATE storage.objects SET owner=NULL WHERE bucket_id=$1 AND name='first.txt'", [bucket]);
    await managed.query("UPDATE storage.buckets SET public=true WHERE id=$1", [bucket]);
    await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.buckets" });
    await managed.query("UPDATE storage.buckets SET public=false WHERE id=$1", [bucket]);
    await managed.query("CREATE POLICY m14_storage_probe ON storage.objects FOR SELECT TO authenticated USING (true)");
    await expect(project()).rejects.toMatchObject({ code: "unsupported_table", table: "storage.objects" });
    await managed.query("DROP POLICY m14_storage_probe ON storage.objects");
    await managed.query("UPDATE public.clients SET email=$1,auth_user_id=NULL WHERE id=$2",
      [`erased+${clientId}@identity.invalid`, clientId]);
    await managed.query("DELETE FROM auth.users WHERE id=$1", [customer]);
    await expect(project()).rejects.toMatchObject({ code: "invalid_input" });
    await managed.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [customer, customerEmail]);
    await managed.query("UPDATE public.clients SET email=$1,auth_user_id=$2 WHERE id=$3", [customerEmail, customer, clientId]);

    const updated = Buffer.from("managed updated bytes");
    await put("first.txt", updated);
    await managed.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id=$2 AND name='first.txt'", [customer, bucket]);
    await sourceS3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: "second.txt" }));
    const final = await project();
    expect(final.mapped.storageObjects[0]!.inventory.objects.map(object => object.key)).toEqual(["first.txt"]);
    expect(await stage("final", final.mapped, finalBucket)).toMatchObject({ copied: 1, replayed: 0 });
    await expect(objectReader(targetS3, finalBucket).read("second.txt")).rejects.toMatchObject({ code: "absent" });
    expect((await objectReader(targetS3, finalBucket).read("first.txt")).object.sha256).toBe(sha(updated));
    expect(await restoreConnectedNativeStore({ owner: target, installation: selection,
      packet: final.mapped.packet, freshTarget: final.baseline })).toMatchObject({ replayed: false });
  } finally {
    sourceS3?.destroy(); targetS3?.destroy();
    await managed?.end(); await target?.end(); await bootstrap?.end();
    if (sourceStarted) await run("env", [`SUPABASE_INTERNAL_IMAGE_REGISTRY=${registry}`, "supabase", "stop", "--workdir", sourceDirectory,
      "--no-backup"], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch(() => {});
    if (targetStarted) await run("docker", ["rm", "-f", container], { timeout: 30_000 }).catch(() => {});
    await pgContainer?.remove();
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
process.stdout.write("managed-storage-proof PASS\n");
