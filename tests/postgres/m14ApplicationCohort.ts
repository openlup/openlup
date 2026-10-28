// Source-only H1/H2 composition, called by the handover entrypoint after the
// canonical 91-unit and transfer predecessors have actually been integrated.
// This fixture creates neither databases nor roles, SQL units or grants.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { Pool, TypeOverrides } from "pg";
import { createPostgresGatewayTypeOverrides } from "@openlup/platform/data";
import { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { executor, fixture } from "../helpers/fulfillmentNative.js";
import type { M14ApplicationInput } from "./fixtures/m14ApplicationActor.js";

interface OwnedSourceInput {
  worktree: string;
  scratch: string;
  owner: string;
  network: string;
  image: string;
  sourceContainerId: string;
  sourceContainerName: string;
  sourceOwner: Pool; // Paid parents/provenance only, before actor admission.
  runtime: { hostConnectionString: string; actorConnectionString: string; login: string; database: string };
}
type Event = { sequence: number; elapsedMs: number; kind: string; outcome?: string; tasks?: number; removed?: boolean };
interface Status { boot: string; node: string; uid: number; gid: number; observations: Event[] }
export interface M14ActorBackend {
  pid: number; backendStart: string; database: string; principal: string; applicationName: string; boot: string;
}
const ownerLabel = "openlup.m14-effect-owner", roleLabel = "openlup.m14-effect-role";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Complete valid CRC PNG from the actual raw-handler witness, without altered
// dimensions, abbreviated headers, validators or timeout options.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZMBgAoXkL9VMpiWIAAAAASUVORK5CYII=", "base64");
png.writeUInt32BE(2, 16);
png.writeUInt32BE(3, 20);
png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
const inspect = (id: string) => JSON.parse(docker(["inspect", id]))[0];
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, allowanceMs = 10_000): Promise<T> {
  const deadline = performance.now() + allowanceMs;
  while (true) {
    const value = await read(); if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error("M14 application observation deadline");
    await delay(25);
  }
}

/** Call only with an actually qualified, owned source R binding; never owner. */
export async function prepareM14ApplicationCohort(input: OwnedSourceInput) {
  assert.equal(process.version, "v24.21.0");
  assert.match(input.owner, /^[0-9a-f-]{36}$/);
  assert.match(input.image, /^sha256:[0-9a-f]{64}$/);
  assert.match(input.sourceContainerId, /^[0-9a-f]{64}$/);
  assert.equal(realpathSync(input.worktree), input.worktree);
  const scratch = realpathSync(input.scratch), worktree = input.worktree;
  assert.equal(realpathSync(join(worktree, "node_modules")), join(worktree, "node_modules"));
  for (const name of ["core", "outbox", "platform"]) {
    assert.equal(realpathSync(join(worktree, "node_modules", "@openlup", name)), join(worktree, "packages", name));
  }
  const uid = process.getuid?.(), gid = process.getgid?.();
  assert(uid !== undefined && gid !== undefined);
  if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^(unix:\/\/|npipe:\/\/)/);
  assert.match(JSON.parse(docker(["context", "inspect"]))[0].Endpoints.docker.Host, /^(unix:\/\/|npipe:\/\/)/);
  docker(["image", "inspect", input.image]); // Already local: no pull/build route.
  const network = JSON.parse(docker(["network", "inspect", input.network]))[0];
  assert.equal(network.Labels[ownerLabel], input.owner);
  const source = inspect(input.sourceContainerId);
  assert.equal(source.Id, input.sourceContainerId); assert.equal(source.Name, `/${input.sourceContainerName}`);
  assert(source.NetworkSettings.Networks[network.Name]?.Aliases.includes("source-db"));
  const actorUrl = new URL(input.runtime.actorConnectionString), hostUrl = new URL(input.runtime.hostConnectionString);
  assert.equal(actorUrl.hostname, "source-db"); assert.equal(actorUrl.port, "5432");
  assert.equal(decodeURIComponent(actorUrl.username), input.runtime.login);
  assert.equal(decodeURIComponent(hostUrl.username), input.runtime.login);
  assert.equal(decodeURIComponent(actorUrl.pathname.slice(1)), input.runtime.database);
  assert.equal(decodeURIComponent(hostUrl.pathname.slice(1)), input.runtime.database);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(hostUrl.hostname));
  const sourcePorts = source.NetworkSettings.Ports["5432/tcp"] as { HostIp: string; HostPort: string }[];
  assert(sourcePorts.some(port => port.HostPort === hostUrl.port && ["127.0.0.1", "::1"].includes(port.HostIp)));
  const directory = join(scratch, "application-control"), mediaRoot = join(scratch, "application-media");
  const bundleRoot = join(scratch, "application-bundle"), actorBundle = join(bundleRoot, "application.mjs");
  assert(!existsSync(directory) && !existsSync(mediaRoot) && !existsSync(bundleRoot), "One application cohort per owned run; no overwrite/retry");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(bundleRoot, { mode: 0o700 });
  // HOST esbuild consumes this finite local TS chain. The Linux child receives
  // only ESM and uses plain Node, never host tsx/esbuild binaries or TS stripping.
  const actorEntry = "tests/postgres/fixtures/m14ApplicationActor.ts";
  const actorInputs = [actorEntry,
    "server/adapters/filesystem/orderReviewMediaObjectStore.ts",
    "server/runtime/commerce/orderReviewBinding.ts", "server/domains/platform-runtime/platformKernel.ts"];
  const sourceInputs = actorInputs.map(path => ({ path, sha256: sha(readFileSync(join(worktree, path))) }));
  const portableExternals = ["pg", "@openlup/platform/data", "@openlup/platform/commerce/server", "@openlup/platform/kernel"];
  const { build, version: esbuildVersion } = await import("esbuild");
  const compiled = await build({ absWorkingDir: worktree, entryPoints: [actorEntry],
    outfile: actorBundle, bundle: true, platform: "node", target: "node24", format: "esm",
    external: portableExternals, write: false, metafile: true, sourcemap: false, logLevel: "silent" });
  assert(compiled.metafile); assert.equal(compiled.outputFiles.length, 1);
  const output = compiled.outputFiles[0]; assert(output);
  assert.deepEqual(Object.keys(compiled.metafile.inputs).sort(), [...actorInputs].sort());
  for (const sourceInput of sourceInputs) {
    assert.equal(sha(readFileSync(join(worktree, sourceInput.path))), sourceInput.sha256, "Actor source changed during host compilation");
  }
  const externalImports = [...new Set(Object.values(compiled.metafile.outputs)
    .flatMap(output => output.imports.filter(value => value.external).map(value => value.path)))].sort();
  assert(externalImports.every(path => path.startsWith("node:") || portableExternals.includes(path)), "Unexpected actor external dependency");
  const externalInputs = ["node_modules/pg/package.json", "node_modules/pg/esm/index.mjs",
    "packages/platform/package.json", "packages/platform/dist/data/index.js",
    "packages/platform/dist/commerce/server/index.js", "packages/platform/dist/kernel/index.js",
    "packages/core/package.json", "packages/outbox/package.json", "package-lock.json"]
    .map(path => ({ path, sha256: sha(readFileSync(join(worktree, path))) }));
  writeFileSync(actorBundle, output.contents, { mode: 0o600 });
  writeFileSync(join(bundleRoot, "metafile.json"), JSON.stringify(compiled.metafile, null, 2), { mode: 0o600 });
  const compilation = { host: { platform: process.platform, arch: process.arch, node: process.version, esbuildVersion },
    options: { bundle: true, platform: "node", target: "node24", format: "esm" }, sourceInputs, externalInputs, externalImports,
    actorSha256: sha(output.contents), metafileSha256: sha(readFileSync(join(bundleRoot, "metafile.json"))),
    runtime: "plain Node; pure-JS pg Pool and existing built package exports; no tsx/native pg" };
  writeFileSync(join(directory, "compilation.json"), JSON.stringify(compilation, null, 2), { mode: 0o600 });
  const runtime = new Pool({ connectionString: input.runtime.hostConnectionString,
    types: createPostgresGatewayTypeOverrides(TypeOverrides), connectionTimeoutMillis: 2_000, query_timeout: 3_000 });
  const types = { async run<T>(work: (db: ReturnType<typeof executor>) => Promise<T>): Promise<T> {
    const client = await runtime.connect();
    try { await client.query("BEGIN"); const result = await work(executor(client)); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  } };
  const lifecycle = createPostgresOrderReviewLifecyclePort(executor(runtime));
  const media = createPostgresOrderReviewMediaPort(executor(runtime), types);
  const actorName = `m14-application-${input.owner}-${randomUUID()}`;
  let id: string | undefined, partialRequest: ClientRequest | undefined, retired = false, runtimeClosed = false, launchAttempted = false;
  async function closeRuntime() { if (!runtimeClosed) { runtimeClosed = true; await runtime.end(); } }
  function ownedActorIdentity() {
    assert(id); const info = inspect(id);
    assert.equal(info.Id, id); assert.equal(info.Config.Labels[ownerLabel], input.owner);
    assert.equal(info.Name, `/${actorName}`);
    assert.equal(info.Config.Labels[roleLabel], "application");
    return info;
  }
  function ownedActor() {
    const info = ownedActorIdentity();
    assert.equal(info.Config.User, `${uid}:${gid}`);
    assert.equal(info.HostConfig.Privileged, false); assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.equal(info.HostConfig.RestartPolicy.Name, "no"); assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(info.HostConfig.CapAdd ?? [], []);
    assert(info.HostConfig.SecurityOpt.some((option: string) => /^no-new-privileges(?::true)?$/.test(option)));
    assert(!["host", "container"].some(mode => info.HostConfig.NetworkMode.startsWith(mode)));
    assert(info.Mounts.every((mount: { Destination: string }) => !mount.Destination.includes("docker.sock")));
    assert.deepEqual(info.Mounts.filter((mount: { RW: boolean; Type: string }) => mount.Type === "bind" && mount.RW)
      .map((mount: { Destination: string }) => mount.Destination).sort(), ["/control", "/media"]);
    assert(info.HostConfig.Tmpfs["/tmp"].includes("noexec") && info.HostConfig.Tmpfs["/tmp"].includes("nosuid"));
    return info;
  }
  function retire() {
    const found = docker(["ps", "--all", "--no-trunc", "--filter", `name=^/${actorName}$`, "--format", "{{.ID}}"]);
    if (!found) { assert.equal(id, undefined, "Previously observed application unexpectedly absent"); retired = true; return; }
    assert.match(found, /^[0-9a-f]{64}$/);
    if (id) assert.equal(found, id);
    id = found;
    ownedActorIdentity(); docker(["rm", "--force", "--volumes", id]);
    assert.equal(docker(["ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]), "");
    retired = true;
  }
  const status = (): Status | null => existsSync(join(directory, "status.json"))
    ? JSON.parse(readFileSync(join(directory, "status.json"), "utf8")) : null;
  const observed = (kind: string) => status()?.observations.find(event => event.kind === kind);
  try {
    const facts = (await runtime.query(`SELECT current_user,session_user,current_database() AS database,
      r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])
        AND pg_catalog.pg_has_role(current_user,c.relowner,'USAGE')) AS nonowner,
      NOT pg_catalog.pg_has_role(current_user,d.datdba,'USAGE') AS database_nonowner
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user`, [["public.commerce_order_reviews", "public.commerce_order_review_media",
      "public.commerce_order_review_command_receipts", "public.commerce_order_review_audit"]])).rows;
    assert.deepEqual(facts, [{ current_user: input.runtime.login, session_user: input.runtime.login,
      database: input.runtime.database, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
      nonowner: true, database_nonowner: true }]);
    // Host R reaches the exact owned source endpoint; the actor checks its own
    // actual R sessions again before any resources/store/startup composition.
    const store = await OrderReviewMediaObjectStore.create(mediaRoot);
    async function grant() {
      const graph = await fixture(input.sourceOwner), reference = `review-grant:${randomUUID()}`;
      const subject = `client:${graph.client}`;
      await input.sourceOwner.query("INSERT INTO public.subscriber_profiles(subject_reference,revision,fingerprint) VALUES($1,1,$2)", [subject, "a".repeat(64)]);
      await input.sourceOwner.query("INSERT INTO public.subscriber_review_access_grants(order_id,kind,grant_reference,expires_at) VALUES($1,'review_request',$2,'2999-01-01')", [graph.order, reference]);
      await input.sourceOwner.query(`INSERT INTO public.subscriber_retention_intents(idempotency_key,subject_reference,subscription_id,source_reference,
        access_grant_reference,kind,template_reference,fingerprint,expected_revision,recipient_fingerprint,control_key,status,delivery_reference,attempt_count)
        VALUES($1,$2,$3,$4,$5,'review_request','retained.review',$6,1,$7,'retained.review','accepted','retained-delivery',1)`,
      [`retained-${graph.order}`, subject, graph.subscription, `order:${graph.order}`, reference, "b".repeat(64), "c".repeat(64)]);
      return reference;
    }
    const startupGrant = await grant(), customerGrant = await grant();
    const comment = "Synthetic owned application review", fingerprint = sha(`5\n${comment}`);
    await lifecycle.submit({ grant: startupGrant, rating: 5, comment, fingerprint });
    const startupCapability = `order-review-upload:${randomUUID()}`, startupDigest = sha(startupCapability);
    const startup = await lifecycle.createMediaIntent({ grant: startupGrant, contentType: "image/png", byteLength: png.length,
      capabilityDigest: startupDigest, commandKey: "m14-startup-intent" });
    const writerRef = `m14-startup:${randomUUID()}`;
    const admission = await media.admitUpload({ capabilityDigest: startupDigest, declaredContentType: "image/png", declaredByteLength: png.length, writerRef });
    assert.equal(admission.kind, "lease"); assert(admission.kind === "lease");
    const receipt = await store.writeTemp(writerRef, (async function* () { yield png; })(), png.length, admission.reservation.leaseExpiresAt);
    assert(await media.finalizeUpload({ capabilityDigest: startupDigest, writerRef, leaseVersion: admission.reservation.leaseVersion,
      digest: receipt.sha256, byteLength: receipt.bytes, promote: () => store.promote(receipt.tempRef, admission.reservation.objectKey) }));
    await lifecycle.confirmMedia({ grant: startupGrant, mediaRef: startup.media.mediaRef, digest: receipt.sha256, commandKey: "m14-startup-confirm" });
    const control = randomUUID();
    const actorInput: M14ApplicationInput = { connectionString: input.runtime.actorConnectionString,
      runtimeLogin: input.runtime.login, database: input.runtime.database, control,
      startupDelete: { actorRef: "m14-fixture-admin", mediaRef: startup.media.mediaRef } };
    writeFileSync(join(directory, "input.json"), JSON.stringify(actorInput), { mode: 0o600 });
    const mounts = ["packages", "node_modules"].flatMap(path => ["--mount", `type=bind,src=${join(worktree, path)},dst=/workspace/${path},readonly`]);
    // The reserved name remains discoverable if Docker creates the container
    // and then refuses OCI startup before returning its ID.
    launchAttempted = true;
    id = docker(["run", "--detach", "--name", actorName, "--pull=never", "--restart=no", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--user", `${uid}:${gid}`, "--cpus=1", "--memory=256m", "--pids-limit=64",
      "--label", `${ownerLabel}=${input.owner}`, "--label", `${roleLabel}=application`,
      "--network", network.Name, "--publish", "127.0.0.1::8080", "--workdir", "/workspace", ...mounts,
      "--mount", `type=bind,src=${actorBundle},dst=/workspace/application.mjs,readonly`,
      "--mount", `type=bind,src=${directory},dst=/control`, "--mount", `type=bind,src=${mediaRoot},dst=/media`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--env", "NODE_PG_FORCE_NATIVE=", input.image,
      "node", "/workspace/application.mjs"]);
    assert.match(id, /^[0-9a-f]{64}$/);
    writeFileSync(join(directory, "owned-application.json"), JSON.stringify({ id, owner: input.owner,
      sourceContainerId: input.sourceContainerId, network: network.Name, mediaRoot, role: "application", compilation }), { mode: 0o600 });
    const info = ownedActor(); assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [network.Name]);
    const port = info.NetworkSettings.Ports["8080/tcp"][0]; assert.equal(port.HostIp, "127.0.0.1");
    const url = `http://127.0.0.1:${port.HostPort}`;
    async function call(path: string, body: unknown) {
      const response = await fetch(`${url}${path}`, { method: "POST", headers: { "x-m14-control": control, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, path); return response.json();
    }
    await until(status, value => {
      assert(!value?.observations.some(event => event.kind === "startup-failed"), "actual R startup refused; no fallback");
      return !!value?.observations.some(event => event.kind === "http-listening");
    });
    assert.equal(status()!.node, "v24.21.0"); assert.equal(status()!.uid, uid); assert.equal(status()!.gid, gid);
    await until(status, value => !!value?.observations.some(event => event.kind === "reconcile-complete" && event.outcome === "returned"));
    assert.equal((await runtime.query("SELECT state FROM public.commerce_order_review_media WHERE media_reference=$1", [startup.media.mediaRef])).rows[0].state, "deleted");
    assert.equal((await store.inspect(admission.reservation.objectKey)).exists, false);
    const submitted = await call("/review/submit", { grant: customerGrant, rating: 5, comment, fingerprint }) as { ok: boolean; replayed: boolean };
    assert.equal(submitted.ok, true); assert.equal(submitted.replayed, false);
    const submitReplay = await call("/review/submit", { grant: customerGrant, rating: 5, comment, fingerprint }) as { ok: boolean; replayed: boolean };
    assert.equal(submitReplay.ok, true); assert.equal(submitReplay.replayed, true);
    async function intent(name: string) {
      const capability = `order-review-upload:${randomUUID()}`;
      const result = await call("/review/media-intent", { grant: customerGrant, contentType: "image/png", byteLength: png.length,
        capabilityDigest: sha(capability), commandKey: `m14-intent:${name}` }) as { ok: boolean; value: { media: { mediaRef: string } } };
      assert.equal(result.ok, true);
      const mediaRef = result.value.media.mediaRef;
      const row = (await runtime.query("SELECT object_key FROM public.commerce_order_review_media WHERE media_reference=$1", [mediaRef])).rows[0];
      assert(row && typeof row.object_key === "string");
      return { mediaRef, capability, objectKey: row.object_key as string };
    }
    async function upload(value: Awaited<ReturnType<typeof intent>>) {
      const response = await fetch(`${url}/raw`, { method: "PUT", headers: { "x-m14-control": control,
        Authorization: `Bearer ${value.capability}`, "Content-Type": "image/png", "Content-Length": String(png.length) },
      body: png, signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 201);
      const result = await call("/review/media-confirm", { grant: customerGrant, mediaRef: value.mediaRef, digest: sha(png), commandKey: `m14-confirm:${value.mediaRef}` }) as { ok: boolean };
      assert.equal(result.ok, true);
    }
    const natural = await intent("natural-interval"); await upload(natural);
    const queue = await call("/fixture/queue-delete", { actorRef: "m14-fixture-admin", mediaRef: natural.mediaRef, idempotencyKey: "m14-natural-cleanup" });
    assert(queue);
    const completedBefore = status()!.observations.filter(event => event.kind === "reconcile-complete" && event.outcome === "returned").length;
    // This one bounded 45s observation includes the real 30s production interval.
    // It precedes the dispatch cohort's 30s holds. No manual reconcile call.
    await until(status, value => (value?.observations.filter(event => event.kind === "reconcile-complete" && event.outcome === "returned").length ?? 0) > completedBefore, 45_000);
    const claims = status()!.observations.filter(event => event.kind === "reconcile-claim" && event.outcome === "returned");
    assert(claims.length >= 2); assert(claims[0].tasks! > 0); assert(claims[1].tasks! > 0);
    const composed = observed("binding-composed")!;
    assert(claims[1].elapsedMs - composed.elapsedMs >= 29_900, "natural interval must not be accelerated");
    assert.equal((await runtime.query("SELECT state FROM public.commerce_order_review_media WHERE media_reference=$1", [natural.mediaRef])).rows[0].state, "deleted");
    assert.equal((await store.inspect(natural.objectKey)).exists, false);
    const deletion = await intent("inflight-admin-delete"); await upload(deletion);
    const promotion = await intent("inflight-raw-promote"), partial = await intent("incomplete-raw-body");
    writeFileSync(join(directory, "gate-remove.json"), JSON.stringify({ objectKey: deletion.objectKey }), { mode: 0o600 });
    writeFileSync(join(directory, "gate-promote.json"), JSON.stringify({ objectKey: promotion.objectKey }), { mode: 0o600 });
    // Start these holds only when the caller is ready to fence all old actors.
    // The returned controller performs no target activation or connected import.
    let callsStarted = false;
    return {
      id, directory, mediaRoot, startup: startup.media.mediaRef, natural: natural.mediaRef,
      retained: { grant: customerGrant, pendingRef: promotion.mediaRef, incompleteRef: partial.mediaRef, cleanupRef: deletion.mediaRef },
      writer: { id, boot: status()!.boot, uid, gid, runtimeLogin: input.runtime.login,
        entrypoints: ["/review/submit", "/review/media-intent", "/review/media-confirm", "PUT /raw", "/admin/media-delete"],
        scheduling: "binding queueMicrotask plus natural 30000ms interval", recreation: "exclusive owned witness host",
        exclusions: ["moderate", "revoke", "source webhooks", "unregistered jobs", "other application modules", "other Docker operators"] },
      async fenceAndRetire() {
        assert(!callsStarted && !retired); callsStarted = true;
        // Admit and observe partial bytes BEFORE finalize holds FOR UPDATE on
        // the shared authorizing grant. Admission commits before body streaming;
        // leaving the body incomplete retains no grant-row transaction lock.
        let finishPartial!: () => void;
        const partialDone = new Promise<void>(resolve => { finishPartial = resolve; });
        partialRequest = httpRequest(`${url}/raw`, { method: "PUT", headers: { "x-m14-control": control,
          Authorization: `Bearer ${partial.capability}`, "Content-Type": "image/png", "Content-Length": String(png.length) } }, response => {
          response.resume(); response.once("end", finishPartial); response.once("error", finishPartial);
        });
        partialRequest.once("error", finishPartial);
        partialRequest.once("close", finishPartial);
        partialRequest.write(png.subarray(0, 45));
        const partialBefore = await until(async () => {
          const row = (await runtime.query("SELECT temp_key FROM public.commerce_order_review_media WHERE media_reference=$1", [partial.mediaRef])).rows[0];
          if (typeof row?.temp_key !== "string") return null;
          const object = await store.inspect(row.temp_key);
          return object.exists && object.bytes === 45 ? { tempKey: row.temp_key, ...object } : null;
        }, value => value !== null);
        const heldRaw = fetch(`${url}/raw`, { method: "PUT", headers: { "x-m14-control": control,
          Authorization: `Bearer ${promotion.capability}`, "Content-Type": "image/png", "Content-Length": String(png.length) },
        body: png, signal: AbortSignal.timeout(30_000) }).then(response => response.arrayBuffer()).catch(() => undefined);
        const heldDelete = call("/admin/media-delete", { actorRef: "m14-fixture-admin", mediaRef: deletion.mediaRef, idempotencyKey: "m14-held-delete" }).catch(() => undefined);
        await until(status, () => !!observed("gate-promote-entered") && !!observed("gate-remove-entered"));
        const before = (await runtime.query(`SELECT media_reference,state,temp_key,writer_reference,writer_lease_expires_at,cleanup_receipt
          FROM public.commerce_order_review_media WHERE media_reference=ANY($1::text[]) ORDER BY media_reference`, [[promotion.mediaRef, deletion.mediaRef, partial.mediaRef]])).rows;
        assert.equal(before.find(row => row.media_reference === deletion.mediaRef)?.state, "cleanup_pending");
        assert.equal(before.find(row => row.media_reference === promotion.mediaRef)?.state, "pending");
        assert(before.find(row => row.media_reference === promotion.mediaRef)?.temp_key);
        await call("/fixture/stop-admission", {});
        ownedActor(); docker(["network", "disconnect", "--force", network.Name, id!]);
        assert.deepEqual(Object.keys(ownedActor().NetworkSettings.Networks), []);
        const egressExcludedSequence = status()!.observations.at(-1)!.sequence;
        writeFileSync(join(directory, "release-promote"), "release", { mode: 0o600 });
        writeFileSync(join(directory, "release-remove"), "release", { mode: 0o600 });
        await until(status, value => !!value?.observations.some(event => event.kind === "filesystem-promoted" && event.sequence > egressExcludedSequence)
          && !!value.observations.some(event => event.kind === "filesystem-remove" && event.removed === true && event.sequence > egressExcludedSequence));
        const postFence = status()!;
        // Observe actual server sessions while this exact process still exists.
        // Process removal after veth exclusion need not notify the remote backend;
        // the caller retires only these identities after all four processes die.
        const applicationName = `m14-app:${postFence.boot}`;
        const observedBackends: M14ActorBackend[] = (await runtime.query<Omit<M14ActorBackend, "boot">>(`SELECT pid,
          backend_start::text AS "backendStart",datname AS database,usename AS principal,application_name AS "applicationName"
          FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND application_name=$1`, [applicationName])).rows.map(row => {
          assert.equal(row.database, input.runtime.database); assert.equal(row.principal, input.runtime.login);
          assert.equal(row.applicationName, applicationName); assert(Number.isInteger(row.pid) && row.pid > 0);
          assert.equal(typeof row.backendStart, "string"); return { ...row, boot: postFence.boot };
        });
        retire(); // Kills admitted raw/admin handlers, timer, clients and descriptors.
        partialRequest.destroy();
        await Promise.all([heldRaw, heldDelete, partialDone]);
        const endpointAvailable = await fetch(`${url}/fixture/status`, { headers: { "x-m14-control": control }, signal: AbortSignal.timeout(1_000) })
          .then(() => true).catch(() => false);
        assert.equal(endpointAvailable, false);
        const after = (await runtime.query(`SELECT media_reference,state,temp_key,writer_reference,writer_lease_expires_at,cleanup_receipt
          FROM public.commerce_order_review_media WHERE media_reference=ANY($1::text[]) ORDER BY media_reference`, [[promotion.mediaRef, deletion.mediaRef, partial.mediaRef]])).rows;
        assert.deepEqual(after.map(row => row.media_reference).sort(), [promotion.mediaRef, deletion.mediaRef, partial.mediaRef].sort());
        const mediaStat = lstatSync(mediaRoot);
        assert(mediaStat.isDirectory() && !mediaStat.isSymbolicLink()); assert.equal(mediaStat.mode & 0o777, 0o700);
        assert.equal(mediaStat.uid, uid); assert.equal(mediaStat.gid, gid);
        const census = ["objects", "tmp"].flatMap(kind => {
          const root = join(mediaRoot, kind), rootStat = lstatSync(root);
          assert(rootStat.isDirectory() && !rootStat.isSymbolicLink()); assert.equal(rootStat.mode & 0o777, 0o700);
          assert.equal(rootStat.uid, uid); assert.equal(rootStat.gid, gid);
          return readdirSync(root, { recursive: true, withFileTypes: true }).flatMap(entry => {
            const path = join(entry.parentPath, entry.name), stat = lstatSync(path);
            assert(!stat.isSymbolicLink()); assert.equal(stat.uid, uid); assert.equal(stat.gid, gid);
            if (stat.isDirectory()) { assert.equal(stat.mode & 0o777, 0o700); return []; }
            assert(stat.isFile() && stat.nlink === 1); assert.equal(stat.mode & 0o777, 0o600);
            const bytes = readFileSync(path); return [{ key: path.slice(mediaRoot.length + 1), bytes: bytes.length, sha256: sha(bytes) }];
          });
        }).sort((a, b) => a.key.localeCompare(b.key));
        assert(census.some(object => object.key === `objects/${promotion.objectKey}` && object.bytes === png.length && object.sha256 === sha(png)));
        assert(!census.some(object => object.key === `objects/${deletion.objectKey}`));
        // A real request abort may already have removed the incomplete temp.
        // Preserve its observed state; never manufacture a complete upload.
        const retainedPartial = census.find(object => object.key === partialBefore!.tempKey);
        if (retainedPartial) { assert.equal(retainedPartial.bytes, 45); assert.equal(retainedPartial.sha256, sha(png.subarray(0, 45))); }
        await closeRuntime();
        const evidence = { outcome: "SELECTED_APPLICATION_PROCESS_RETIRED", id, compilation, before, after, partialBefore, postFence, observedBackends, census,
          endpointAvailable, uid, gid, root: mediaRoot, egressExcludedSequence,
          boundary: "Application actor only; handover caller retires the three dispatch actors and closes coordinator source mutation clients before final graph+FS capture",
          qualification: "Actual R fixture operations only; installed-profile admission and additional host ACL qualification remain separate",
          connectedRestore: "Handover caller owns canonical graph/private-root publication after whole-cohort retirement", wholeStoreRtoMs: null };
        writeFileSync(join(directory, "retirement.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
        return evidence;
      },
      async cleanup() { try { if (!retired) retire(); } finally { partialRequest?.destroy(); await closeRuntime(); } },
    };
  } catch (error) {
    try { if (launchAttempted && !retired) retire(); } finally { await closeRuntime(); }
    throw error;
  }
}
