import { createHash } from "node:crypto";
import { ObjectTransferError, type TransferObject } from "@openlup/platform/portability";

type Actor = "anonymous" | "customer-owner" | "customer-other" | "operator";
const actors: readonly Actor[] = ["anonymous", "customer-owner", "customer-other", "operator"];

export interface MediaServingProbe {
  key: string;
  actor: Actor;
  /** Independent source-domain grant fact for this actor and media reference. */
  expectedAllowed: boolean;
  source: Request;
  target: Request;
}

/**
 * Compare actual source and inactive-target serving routes under each declared
 * identity. The host supplies real route requests bound to independently
 * installed source/target generations, after excluding writers. A descriptor's
 * access label is never used as an authorization decision.
 */
export async function reconcileOrderReviewMediaServing(input: {
  objects: readonly TransferObject[];
  probes: readonly MediaServingProbe[];
  fetchRoute?: typeof fetch;
}): Promise<{ observed: number; allowed: number; denied: number }> {
  const { objects, probes } = input;
  if (!Array.isArray(objects) || objects.length > 10000 || !Array.isArray(probes)
    || probes.length !== objects.length * actors.length) {
    throw new ObjectTransferError("invalid_input");
  }
  const expected = new Map<string, TransferObject>();
  for (const object of objects) {
    if (!object || typeof object.key !== "string" || expected.has(object.key)
      || !Number.isSafeInteger(object.bytes) || object.bytes < 0 || object.bytes > 20 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(object.sha256)) {
      throw new ObjectTransferError("invalid_input");
    }
    expected.set(object.key, object);
  }
  const seen = new Set<string>();
  const identities = new Map<string, Partial<Record<"customer-owner" | "customer-other" | "operator", [string, string]>>>();
  const mediaRefs = new Map<string, string>();
  const refKeys = new Map<string, string>();
  let sourceOrigin: string | undefined, targetOrigin: string | undefined;
  let allowed = 0;
  for (const probe of probes) {
    if (!probe || !expected.has(probe.key) || !actors.includes(probe.actor)
      || typeof probe.expectedAllowed !== "boolean"
      || !(probe.source instanceof Request) || !(probe.target instanceof Request)
      || probe.source.method !== "GET" || probe.target.method !== "GET") throw new ObjectTransferError("invalid_input");
    const identity = JSON.stringify([probe.key, probe.actor]);
    if (seen.has(identity)) throw new ObjectTransferError("invalid_input");
    seen.add(identity);
    const sourceBearer = probe.source.headers.get("authorization"), targetBearer = probe.target.headers.get("authorization");
    const sourceCookie = probe.source.headers.get("cookie"), targetCookie = probe.target.headers.get("cookie");
    if (sourceBearer && sourceCookie || targetBearer && targetCookie) throw new ObjectTransferError("invalid_input");
    const sourceAuth = sourceBearer ?? sourceCookie, targetAuth = targetBearer ?? targetCookie;
    if (probe.actor === "anonymous" ? sourceAuth !== null || targetAuth !== null
      : probe.actor === "operator" ? !sourceAuth || !targetAuth
        : !sourceBearer?.startsWith("Bearer ") || !targetBearer?.startsWith("Bearer ")) {
      throw new ObjectTransferError("invalid_input");
    }
    if (probe.actor !== "anonymous") {
      const pair = identities.get(probe.key) ?? {};
      pair[probe.actor as Exclude<Actor, "anonymous">] = [sourceAuth!, targetAuth!];
      identities.set(probe.key, pair);
    }
    const admin = probe.actor === "operator";
    const sourceUrl = new URL(probe.source.url), targetUrl = new URL(probe.target.url);
    if (sourceUrl.origin === targetUrl.origin || sourceUrl.pathname !== targetUrl.pathname
      || sourceUrl.search !== "" || targetUrl.search !== ""
      || sourceUrl.username !== "" || sourceUrl.password !== "" || targetUrl.username !== "" || targetUrl.password !== ""
      || !["http:", "https:"].includes(sourceUrl.protocol) || !["http:", "https:"].includes(targetUrl.protocol)) {
      throw new ObjectTransferError("invalid_input");
    }
    sourceOrigin ??= sourceUrl.origin;
    targetOrigin ??= targetUrl.origin;
    if (sourceUrl.origin !== sourceOrigin || targetUrl.origin !== targetOrigin) throw new ObjectTransferError("invalid_input");
    const mediaRef = sourceUrl.pathname.split("/").at(-1)!;
    if (!/^order-review-media:[a-f0-9-]{36}$/.test(mediaRef)
      || mediaRefs.has(probe.key) && mediaRefs.get(probe.key) !== mediaRef
      || refKeys.has(mediaRef) && refKeys.get(mediaRef) !== probe.key) throw new ObjectTransferError("invalid_input");
    mediaRefs.set(probe.key, mediaRef);
    refKeys.set(mediaRef, probe.key);
    for (const request of [probe.source, probe.target]) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(admin ? "/api/bff/admin/order-review/media/" : "/api/bff/order-review/media/")) {
        throw new ObjectTransferError("invalid_input");
      }
    }
    const source = await observe(() => (input.fetchRoute ?? fetch)(probe.source), expected.get(probe.key)!);
    const target = await observe(() => (input.fetchRoute ?? fetch)(probe.target), expected.get(probe.key)!);
    if ((source !== null) !== probe.expectedAllowed || source !== target) throw new ObjectTransferError("denied");
    if (source !== null) allowed++;
  }
  for (const pair of identities.values()) {
    const owner = pair["customer-owner"], other = pair["customer-other"], operator = pair.operator;
    if (!owner || !other || !operator
      || owner[0] === other[0] || owner[1] === other[1]
      || owner[0] === operator[0] || owner[1] === operator[1]
      || other[0] === operator[0] || other[1] === operator[1]) throw new ObjectTransferError("invalid_input");
  }
  return { observed: probes.length, allowed, denied: probes.length - allowed };
}

async function observe(request: () => Promise<Response>, object: TransferObject): Promise<string | null> {
  let response: Response;
  try { response = await request(); } catch { throw new ObjectTransferError("unavailable"); }
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (response.status !== 200 || Number(response.headers.get("content-length")) !== object.bytes) {
    throw new ObjectTransferError("integrity_conflict");
  }
  const contentType = response.headers.get("content-type");
  if (!contentType || response.headers.get("cache-control") !== "private, no-store"
    || response.headers.get("vary") !== "Authorization"
    || response.headers.get("x-content-type-options") !== "nosniff") throw new ObjectTransferError("denied");
  if (!response.body) throw new ObjectTransferError("integrity_conflict");
  let bytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > object.bytes) throw new ObjectTransferError("integrity_conflict");
    hash.update(chunk);
  }
  if (bytes !== object.bytes || hash.digest("hex") !== object.sha256) {
    throw new ObjectTransferError("integrity_conflict");
  }
  return contentType;
}
