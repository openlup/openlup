import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
export type ReferenceEgressLedgerEntry = {
  layer: "node";
  api: "fetch" | "http" | "https" | "socket" | "tls";
  target: string;
  decision: "allowed" | "blocked";
};
declare global {
  // Deliberately process-local: the runner reads and redacts this ledger before
  // emitting its external artifact.
  var __REFERENCE_EGRESS_LEDGER__: ReferenceEgressLedgerEntry[] | undefined;
}
const ledger = globalThis.__REFERENCE_EGRESS_LEDGER__ ?? [];
globalThis.__REFERENCE_EGRESS_LEDGER__ = ledger;
function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
function record(
  api: ReferenceEgressLedgerEntry["api"],
  target: string,
  decision: ReferenceEgressLedgerEntry["decision"],
): void {
  ledger.push({ layer: "node", api, target, decision });
}
function assertUrlAllowed(api: "fetch" | "http" | "https", raw: string | URL): void {
  const url = raw instanceof URL ? raw : new URL(raw);
  const target = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname)) {
    record(api, target, "allowed");
    return;
  }
  record(api, target, "blocked");
  throw new Error(`REFERENCE_EGRESS_BLOCKED:${api}:${target}`);
}
function requestUrl(args: unknown[]): URL {
  const first = args[0];
  if (first instanceof URL) return first;
  if (typeof first === "string") return new URL(first);
  const options = (first ?? {}) as http.RequestOptions;
  const protocol = options.protocol ?? "http:";
  const hostname = options.hostname ?? options.host ?? "localhost";
  const port = options.port ? `:${String(options.port)}` : "";
  const path = options.path ?? "/";
  return new URL(`${protocol}//${String(hostname)}${port}${String(path)}`);
}
function socketHost(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") return null; // Unix-domain socket path.
  if (typeof first === "number") {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  if (first && typeof first === "object") {
    const options = first as net.NetConnectOpts;
    if ("path" in options && options.path) return null;
    return "host" in options && typeof options.host === "string" ? options.host : "localhost";
  }
  return "localhost";
}
function assertSocketAllowed(api: "socket" | "tls", args: unknown[]): void {
  const host = socketHost(args);
  if (host === null) {
    record(api, "unix-socket", "allowed");
    return;
  }
  const target = host.toLowerCase();
  if (isLoopbackHost(target)) {
    record(api, target, "allowed");
    return;
  }
  record(api, target, "blocked");
  throw new Error(`REFERENCE_EGRESS_BLOCKED:${api}:${target}`);
}
const originalFetch = globalThis.fetch.bind(globalThis);
function fetchTarget(input: unknown): string | URL {
  if (typeof input === "string" || input instanceof URL) return input;
  if (input && typeof input === "object" && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  throw new Error("REFERENCE_EGRESS_BLOCKED:fetch:invalid-target");
}
globalThis.fetch = (async (
  input: Parameters<typeof originalFetch>[0],
  init?: Parameters<typeof originalFetch>[1],
) => {
  assertUrlAllowed("fetch", fetchTarget(input));
  return originalFetch(input, init);
}) as typeof globalThis.fetch;
function guardRequest(
  api: "http" | "https",
  original: typeof http.request,
): typeof http.request {
  return function guardedRequest(...args: unknown[]) {
    assertUrlAllowed(api, requestUrl(args));
    return original.apply(api === "http" ? http : https, args as never);
  } as typeof http.request;
}
http.request = guardRequest("http", http.request);
http.get = ((...args: unknown[]) => {
  const request = http.request(...(args as Parameters<typeof http.request>));
  request.end();
  return request;
}) as typeof http.get;
https.request = guardRequest("https", https.request as typeof http.request) as typeof https.request;
https.get = ((...args: unknown[]) => {
  const request = https.request(...(args as Parameters<typeof https.request>));
  request.end();
  return request;
}) as typeof https.get;
const originalNetConnect = net.connect.bind(net);
const guardedNetConnect = ((...args: unknown[]) => {
  assertSocketAllowed("socket", args);
  return originalNetConnect(...(args as Parameters<typeof net.connect>));
}) as typeof net.connect;
net.connect = guardedNetConnect;
net.createConnection = guardedNetConnect;
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args: unknown[]) {
  assertSocketAllowed("socket", args);
  return originalSocketConnect.apply(this, args as never);
} as typeof net.Socket.prototype.connect;
const originalTlsConnect = tls.connect.bind(tls);
tls.connect = ((...args: unknown[]) => {
  assertSocketAllowed("tls", args);
  return originalTlsConnect(...(args as Parameters<typeof tls.connect>));
}) as typeof tls.connect;
