import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { TransferObject } from "@openlup/platform/portability";
import { createOrderReviewMediaBffHandler } from "../../bff/order-review/media.js";
import { createAdminOrderReviewMediaBffHandler } from "../../bff/admin/order-review/media.js";
import { OrderReviewMediaObjectStore } from "./orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem, reconcileOrderReviewMediaFilesystem,
  type OrderReviewMediaSourceReference } from "./orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "./orderReviewMediaTransferReader.js";
import { stageOrderReviewMediaFilesystem } from "./orderReviewMediaTransferRestore.js";
import { reconcileOrderReviewMediaServing, type MediaServingProbe } from "./orderReviewMediaTransferAccess.js";

const ref = "order-review-media:123e4567-e89b-12d3-a456-426614174000";
const grant = "review-grant:123e4567-e89b-12d3-a456-426614174001";
const bytes = Buffer.from("private media bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const object: TransferObject = { key: "review/media", version: `sha256:${digest}`, bytes: bytes.length,
  sha256: digest, metadata: {}, access: "posix-owner-mode" };
const media = { state: "confirmed", observedContentType: "image/webp", observedByteLength: bytes.length, observedDigest: digest };
const reference: OrderReviewMediaSourceReference = { mediaReference: ref, state: "confirmed", objectKey: object.key,
  observedDigest: digest, observedByteLength: bytes.length, observedContentType: "image/webp",
  tempKey: null, writerReference: null, cleanupReceipt: null, nextAttemptAt: null };

function probes(): MediaServingProbe[] {
  return (["anonymous", "customer-owner", "customer-other", "operator"] as const).map(actor => {
    const route = actor === "operator" ? `/api/bff/admin/order-review/media/${ref}` : `/api/bff/order-review/media/${ref}`;
    const bearer = actor === "customer-owner" ? grant : actor === "customer-other"
      ? "review-grant:123e4567-e89b-12d3-a456-426614174002" : actor === "operator" ? "operator" : undefined;
    return { key: object.key, actor, expectedAllowed: actor === "customer-owner" || actor === "operator",
      source: new Request(`https://source.test${route}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }),
      target: new Request(`https://target.test${route}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }) };
  });
}

function routeFetch(options: { widenTarget?: boolean; loseTarget?: boolean; loseSource?: boolean; corruptTarget?: boolean;
  sourceStore?: OrderReviewMediaObjectStore; targetStore?: OrderReviewMediaObjectStore } = {}): typeof fetch {
  return (async (request: Request) => {
    const target = new URL(request.url).hostname === "target.test";
    const admin = new URL(request.url).pathname.includes("/admin/");
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const permitted = admin ? token === "operator" : token === grant;
    const allowed = target && options.widenTarget ? true : target && options.loseTarget ? false
      : !target && options.loseSource ? false : permitted;
    const binding = {
      authorizeCustomerMedia: async () => allowed ? { media, open: async () => target && options.corruptTarget
        ? (async function* () { yield Buffer.from("changed media bytes"); })()
        : (target ? options.targetStore : options.sourceStore)?.open(object.key)
          ?? (async function* () { yield bytes; })() } : null,
      authorizeAdminMedia: async () => allowed ? { media, open: async () => (target ? options.targetStore : options.sourceStore)?.open(object.key)
        ?? (async function* () { yield bytes; })() } : null,
    };
    const handler = admin ? createAdminOrderReviewMediaBffHandler({
      env: { PLATFORM_BUNDLE: "node-postgres" }, authorize: async () => token === "operator" ? "operator" : null,
      resolveBinding: async () => binding as never,
    }) : createOrderReviewMediaBffHandler(async () => binding as never, { PLATFORM_BUNDLE: "node-postgres" });
    const headers = new Headers(); const chunks: Uint8Array[] = []; let status = 200;
    const res = Object.assign(new EventEmitter(), {
      setHeader(name: string, value: string) { headers.set(name, value); return res; },
      status(value: number) { status = value; return res; },
      json(value: unknown) { chunks.push(Buffer.from(JSON.stringify(value))); return res; },
      write(value: Uint8Array) { chunks.push(Buffer.from(value)); return true; },
      end() { return res; }, destroy() { return res; },
    });
    await handler({ method: "GET", headers: { authorization: request.headers.get("authorization") ?? undefined },
      query: { mediaRef: ref } } as never, res as never);
    return new Response(Uint8Array.from(Buffer.concat(chunks)), { status, headers });
  }) as typeof fetch;
}

it("compares effective anonymous, owner, cross-customer and operator access through both serving handlers", async () => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "openlup-media-serving-"));
  try {
    const sourceRoot = join(parent, "source"), servingRoot = join(parent, "active");
    const sourceStore = await OrderReviewMediaObjectStore.create(sourceRoot);
    const uploaded = await sourceStore.writeTemp("transfer", (async function* () { yield bytes; })(), bytes.length,
      "2999-01-01T00:00:00Z");
    await sourceStore.promote(uploaded.tempRef, object.key);
    const limits = { maximumObjectBytes: 1024, maximumTotalBytes: 4096, maximumFiles: 10 };
    const census = await captureOrderReviewMediaFilesystem({ root: sourceRoot, ...limits });
    expect(reconcileOrderReviewMediaFilesystem({ census, references: [reference] }).physicalObjects).toBe(1);
    const staged = await stageOrderReviewMediaFilesystem({ servingRoot, generationId: "verified", census,
      objects: createOrderReviewMediaTransferReader({ root: sourceRoot, maximumObjectBytes: 1024 }),
      temporary: createOrderReviewMediaTransferReader({ root: sourceRoot, maximumObjectBytes: 1024, area: "tmp" }), ...limits });
    const targetStore = await OrderReviewMediaObjectStore.create(staged.generationRoot);
    expect(await reconcileOrderReviewMediaServing({ objects: census.objects, references: [reference], probes: probes(),
      fetchRoute: routeFetch({ sourceStore, targetStore }) })).toEqual({ observed: 4, allowed: 2, denied: 2 });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it("refuses target access widening, loss and divergent served bytes", async () => {
  await expect(reconcileOrderReviewMediaServing({ objects: [object], references: [reference], probes: probes(), fetchRoute: routeFetch({ widenTarget: true }) }))
    .rejects.toMatchObject({ code: "denied" });
  await expect(reconcileOrderReviewMediaServing({ objects: [object], references: [reference], probes: probes(), fetchRoute: routeFetch({ loseTarget: true }) }))
    .rejects.toMatchObject({ code: "denied" });
  await expect(reconcileOrderReviewMediaServing({ objects: [object], references: [reference], probes: probes(), fetchRoute: routeFetch({ loseSource: true, loseTarget: true }) }))
    .rejects.toMatchObject({ code: "denied" });
  await expect(reconcileOrderReviewMediaServing({ objects: [object], references: [reference], probes: probes(), fetchRoute: routeFetch({ corruptTarget: true }) }))
    .rejects.toMatchObject({ code: "integrity_conflict" });
});

it("binds every route probe to the retained media reference and observed type", async () => {
  const otherRef = "order-review-media:123e4567-e89b-12d3-a456-426614174099";
  const wrong = probes().map(probe => ({ ...probe,
    source: new Request(probe.source.url.replace(ref, otherRef), { headers: probe.source.headers }),
    target: new Request(probe.target.url.replace(ref, otherRef), { headers: probe.target.headers }) }));
  await expect(reconcileOrderReviewMediaServing({ objects: [object], references: [reference], probes: wrong,
    fetchRoute: routeFetch() })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(reconcileOrderReviewMediaServing({ objects: [object], references: [{ ...reference, observedContentType: "image/jpeg" }],
    probes: probes(), fetchRoute: routeFetch() })).rejects.toMatchObject({ code: "denied" });
});
