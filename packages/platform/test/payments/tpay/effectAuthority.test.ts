import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createTpayHttpClient, type TpayFetchLike, type TpayTransactionCreateInput } from "../../../src/payments/tpay/tpayHttpClient.js";

// An owned local provider fixture. Its HTTP responses are synthetic; this does
// not establish any hosted provider's token revocation or drain semantics.
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});
function latch() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}
async function provider() {
  const effects = new Map<string, { transactionId: string; status: string }>();
  let oldTokenRevoked = false, oauthCalls = 0, requests = 0;
  const server = createServer((request, response) => { void handle(request, response); });
  servers.push(server);
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url === "/oauth/auth") {
      oauthCalls++;
      return json(response, { access_token: "synthetic-old-token", expires_in: 7200 });
    }
    if (request.url === "/transactions/channels") return json(response, { channels: [] });
    if (request.url?.startsWith("/transactions/")) {
      const effect = effects.get(decodeURIComponent(request.url.slice("/transactions/".length)));
      return json(response, effect ? { ...effect, title: "synthetic", amount: 1, currency: "PLN" } : {}, effect ? 200 : 404);
    }
    if (request.url !== "/transactions") return json(response, {}, 404);
    requests++;
    if (oldTokenRevoked && request.headers.authorization === "Bearer synthetic-old-token") {
      return json(response, { error: "revoked" }, 401);
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const input = JSON.parse(text) as { hiddenDescription: string };
    const effect = { transactionId: input.hiddenDescription, status: "pending" };
    effects.set(input.hiddenDescription, effect);
    // Durable provider acceptance precedes a lost acknowledgement.
    if (input.hiddenDescription === "accepted-before-ack") return response.destroy();
    return json(response, { ...effect, title: "synthetic" });
  }
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  return { url: `http://127.0.0.1:${address.port}`, effects,
    revokeOldToken: () => { oldTokenRevoked = true; },
    observations: () => ({ oauthCalls, requests }) };
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
const input = (key: string): TpayTransactionCreateInput => ({ amount: 1, currency: "PLN", description: "Synthetic transfer probe",
  hiddenDescription: key, payer: { email: "customer@example.invalid", name: "Synthetic Customer" },
  notificationUrl: "https://example.invalid/notify", successUrl: "https://example.invalid/success", errorUrl: "https://example.invalid/error" });

it("demonstrates that a cloned local admission cannot exclude an old worker at actual HTTP dispatch", async () => {
  const p = await provider(), admitted = latch(), resume = latch();
  // Both restored databases hold the same pre-cutover generation. Neither can
  // modify the other; changing only the target's admission does not fence old.
  const oldDatabase = { generation: 7, subscription: "active", duty: "owed" };
  const targetDatabase = structuredClone(oldDatabase);
  const client = createTpayHttpClient({ baseUrl: p.url, clientId: "synthetic", clientSecret: "synthetic",
    fetchImpl: (async (url, init) => {
      if (url.endsWith("/transactions")) { admitted.release(); await resume.ready; }
      return fetch(url, init);
    }) satisfies TpayFetchLike });
  await client.listPaymentChannels(); // A cached, still-valid bearer survives.
  const dispatch = client.createTransaction(input("old-admitted"));
  await admitted.ready;
  targetDatabase.generation++;
  resume.release();
  await dispatch;
  expect(p.effects.has("old-admitted")).toBe(true);
  expect(p.observations()).toEqual({ oauthCalls: 1, requests: 1 });
  expect(oldDatabase.generation).toBe(7);
  expect(targetDatabase).toEqual({ generation: 8, subscription: "active", duty: "owed" });
});

it("excludes resumed old HTTP effects only at external token enforcement and reconciles lost ACK plus late observation", async () => {
  const p = await provider(), admitted = latch(), resume = latch();
  const old = createTpayHttpClient({ baseUrl: p.url, clientId: "synthetic", clientSecret: "synthetic",
    fetchImpl: (async (url, init) => {
      if (url.endsWith("/transactions") && init?.body?.includes("old-paused")) { admitted.release(); await resume.ready; }
      return fetch(url, init);
    }) satisfies TpayFetchLike });
  await expect(old.createTransaction(input("accepted-before-ack"))).rejects.toMatchObject({ dispatchState: "unknown" });
  const paused = old.createTransaction(input("old-paused"));
  // Attach the rejection before resuming, so it cannot become unhandled.
  const refused = expect(paused).rejects.toMatchObject({ dispatchState: "unknown" });
  await admitted.ready;
  p.revokeOldToken(); // Synthetic provider enforces this on every actual POST.
  const target = createTpayHttpClient({ baseUrl: p.url, clientId: "synthetic", clientSecret: "synthetic",
    fetchImpl: (async (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Authorization: "Bearer synthetic-new-token" } })) satisfies TpayFetchLike });
  const before = await target.getTransaction("accepted-before-ack");
  expect(before.status).toBe("pending");
  resume.release(); await refused;
  expect(p.effects.has("old-paused")).toBe(false);
  // Late provider observation updates the original effect. Target uses exact
  // readback instead of minting a second create request after unknown ACK.
  p.effects.get("accepted-before-ack")!.status = "success";
  expect((await target.getTransaction("accepted-before-ack")).status).toBe("success");
  expect(p.effects.size).toBe(1);
  expect(p.observations().requests).toBe(2);
});
