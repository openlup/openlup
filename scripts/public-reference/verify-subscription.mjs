#!/usr/bin/env node
// HTTP acceptance for one owned disposable subscription reference installation.
// Usage: node scripts/public-reference/verify-subscription.mjs --env-file /absolute/subscription.env [--origin LOOPBACK_ORIGIN]
// Restart proof: add --resume-order UUID --resume-subscription UUID --resume-date ISO_TIMESTAMP.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fail = (message) => { throw new Error(message); };
const requireFact = (value, message) => { if (!value) fail(message); };
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const loopback = (value) => {
  const url = new URL(value);
  requireFact(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && url.port,
  "Expected a bare loopback HTTP origin");
  return url.origin;
};
function args() {
  const pairs = process.argv.slice(2);
  requireFact(pairs.length >= 2 && pairs.length <= 10 && pairs.length % 2 === 0,
    "Usage: --env-file ABSOLUTE/subscription.env [--origin LOOPBACK_ORIGIN] [--resume-order UUID --resume-subscription UUID --resume-date ISO_TIMESTAMP]");
  const options = new Map();
  for (let i = 0; i < pairs.length; i += 2) {
    requireFact(["--env-file", "--origin", "--resume-order", "--resume-subscription", "--resume-date"].includes(pairs[i])
      && pairs[i + 1] && !options.has(pairs[i]), "Invalid or repeated option");
    options.set(pairs[i], pairs[i + 1]);
  }
  requireFact(options.has("--env-file"), "An owned --env-file is required");
  const resumeKeys = ["--resume-order", "--resume-subscription", "--resume-date"];
  requireFact(resumeKeys.every((key) => options.has(key)) || resumeKeys.every((key) => !options.has(key)),
    "Restart proof requires order, subscription and date together");
  return options;
}
function setup() {
  const options = args();
  const file = realpathSync(options.get("--env-file"));
  requireFact(basename(file) === "subscription.env" && !(statSync(file).mode & 0o077), "Use the private generated subscription.env");
  const env = parseEnv(readFileSync(file, "utf8"));
  const owned = realpathSync(env.OPENLUP_REFERENCE_SUPABASE_DIR ?? "");
  requireFact(owned === dirname(file) && env.OPENLUP_REFERENCE_PROFILE === "subscription"
    && env.OPENLUP_REFERENCE_DISPOSABLE === "1", "Environment is not the owned subscription setup");
  const marker = JSON.parse(readFileSync(join(owned, "subscription-owner.json"), "utf8"));
  requireFact(marker.phase === "sealed" && marker.projectId === env.OPENLUP_REFERENCE_PROJECT_ID,
    "Subscription owner marker does not match");
  const origin = loopback(options.get("--origin") ?? env.APP_BASE_URL);
  requireFact(origin === loopback(env.APP_BASE_URL), "Origin differs from the owned setup");
  const auth = loopback(env.SUPABASE_URL);
  const config = readFileSync(join(owned, "supabase/config.toml"), "utf8");
  const section = config.match(/^\[inbucket\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const port = section?.match(/^port\s*=\s*(\d+)\s*$/m)?.[1];
  requireFact(section && /^enabled\s*=\s*true\s*$/m.test(section) && port, "Owned local mailbox is unavailable");
  const mail = loopback(`http://127.0.0.1:${port}`);
  const resume = options.has("--resume-order") ? {
    orderId: options.get("--resume-order"), subscriptionId: options.get("--resume-subscription"),
    date: options.get("--resume-date"),
  } : null;
  if (resume) requireFact(uuid(resume.orderId) && uuid(resume.subscriptionId)
    && Number.isFinite(Date.parse(resume.date)), "Invalid restart-proof IDs or date");
  return { file, origin, auth, mail, resume };
}
async function request(url, { method = "GET", body, bearer, origin } = {}) {
  const response = await fetch(url, {
    method, redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", origin }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await response.json(); } catch { /* A non-JSON response fails the caller's contract check. */ }
  return { status: response.status, json };
}
function accepted(result, stage) {
  requireFact(result.status === 200 && result.json?.ok === true && result.json.data, `${stage}: expected HTTP 200 success`);
  return result.json.data;
}
function denied(result, stage, allowed = [400, 401, 403, 404, 409]) {
  requireFact(allowed.includes(result.status) && result.json?.ok === false, `${stage}: expected an explicit refusal (HTTP ${result.status})`);
}
const emailOf = (person) => {
  const addresses = person.To ?? person.to ?? [];
  return Array.isArray(addresses) ? addresses.map((entry) => typeof entry === "string" ? entry : entry.Address ?? entry.address).filter(Boolean) : [];
};
async function capturedMessage(mail, email, seen) {
  for (let tries = 0; tries < 30; tries += 1) {
    const list = await request(`${mail}/api/v1/messages`);
    requireFact(list.status === 200 && Array.isArray(list.json?.messages), "Local mailbox listing unavailable");
    const item = list.json.messages.find((candidate) => {
      const id = candidate.ID ?? candidate.id;
      return typeof id === "string" && !seen.has(id)
        && emailOf(candidate).some((address) => address.toLowerCase() === email);
    });
    if (item) {
      const id = item.ID ?? item.id;
      seen.add(id);
      const detail = await request(`${mail}/api/v1/message/${encodeURIComponent(id)}`);
      requireFact(detail.status === 200 && detail.json, "Captured local message unavailable");
      return detail.json;
    }
    await delay(1000);
  }
  fail("No new captured local sign-in message arrived");
}
function confirmationLink(message, auth) {
  const content = [message.HTML, message.Text, message.html, message.text].filter((entry) => typeof entry === "string").join("\n")
    .replaceAll("&amp;", "&").replaceAll("&#38;", "&");
  for (const candidate of content.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    let link;
    try { link = new URL(candidate); } catch { continue; }
    if (link.origin === auth && link.pathname === "/auth/v1/verify" && link.searchParams.has("token")) return link;
  }
  fail("Captured message lacks a local Auth confirmation link");
}
async function signIn({ origin, auth, mail }, email, seen) {
  accepted(await request(`${origin}/api/bff/customers/magic-link`, {
    method: "POST", origin, body: { email },
  }), "sign-in request");
  const link = confirmationLink(await capturedMessage(mail, email, seen), auth);
  const response = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  requireFact([302, 303].includes(response.status), "Local Auth confirmation did not redirect");
  const target = new URL(response.headers.get("location") ?? "", origin);
  requireFact(target.origin === origin && target.pathname === "/account/auth/callback", "Auth redirected outside the owned account callback");
  const token = new URLSearchParams(target.hash.slice(1)).get("access_token");
  requireFact(typeof token === "string" && token.length > 20, "Auth callback has no access token");
  return token;
}
const bff = (origin, path, options) => request(`${origin}${path}`, { origin, ...options });

async function verifyAfterRestart(setupData) {
  const list = await request(`${setupData.mail}/api/v1/messages`);
  requireFact(list.status === 200 && Array.isArray(list.json?.messages), "Local mailbox listing unavailable");
  const seen = new Set(list.json.messages.map((item) => item.ID ?? item.id));
  const recipients = list.json.messages.flatMap(emailOf);
  const pairs = new Map();
  for (const email of recipients) {
    const match = typeof email === "string" && email.match(/^(buyer|operator)-([0-9a-f]{8}-[0-9a-f]{3})@example\.test$/);
    if (match) pairs.set(match[2], { ...pairs.get(match[2]), [match[1]]: email });
  }
  const matched = [...pairs.values()].filter((pair) => pair.buyer && pair.operator);
  requireFact(matched.length === 1, "Restart proof needs one captured synthetic buyer/operator pair");
  const buyerToken = await signIn(setupData, matched[0].buyer, seen);
  const operatorToken = await signIn(setupData, matched[0].operator, seen);
  const account = accepted(await bff(setupData.origin, "/api/bff/customers/account", { bearer: buyerToken }),
    "post-restart customer readback");
  const order = account.recentOrders?.find((entry) => entry.orderId === setupData.resume.orderId);
  const subscription = account.subscriptions?.find((entry) => entry.subscriptionId === setupData.resume.subscriptionId);
  requireFact(order?.subscriptionId === setupData.resume.subscriptionId && order.paymentStatus === "succeeded"
    && subscription?.status === "active"
    && new Date(subscription.nextCycleAt).getTime() === Date.parse(setupData.resume.date),
  "Post-restart customer readback changed paid order, subscription or date");
  const path = `/api/bff/reference-journey/operator/subscription-readback?orderId=${encodeURIComponent(setupData.resume.orderId)}`;
  const proof = accepted(await bff(setupData.origin, path, { bearer: operatorToken }), "post-restart operator readback");
  requireFact(proof.order?.orderId === order.orderId && proof.payment?.status === "succeeded"
    && proof.subscription?.subscriptionId === subscription.subscriptionId
    && proof.subscription.status === subscription.status
    && new Date(proof.subscription.nextRenewalAt).getTime() === Date.parse(setupData.resume.date),
  "Post-restart operator readback changed paid subscription or date");
  console.log(`restart persisted order=${order.orderId} subscription=${subscription.subscriptionId} nextRenewalAt=${subscription.nextCycleAt}`);
}

async function main() {
  const setupData = setup();
  if (setupData.resume) return verifyAfterRestart(setupData);
  const { origin, mail } = setupData;
  const seen = new Set();
  const suffix = randomUUID().slice(0, 12);
  const buyer = `buyer-${suffix}@example.test`;
  const operator = `operator-${suffix}@example.test`;
  const catalog = accepted(await bff(origin, "/api/bff/catalog/items"), "catalog");
  const item = catalog.items?.find((entry) => entry.permittedPurchaseModes?.includes("subscription"));
  requireFact(item?.sku && catalog.profile?.currency && catalog.profile?.country, "Catalog has no recurring item");
  const command = { version: "commerce.checkout_command.v1", idempotencyKey: `reference:http:${randomUUID()}`,
    mode: "subscription", cadenceDays: 28, lines: [{ sku: item.sku, quantity: 1 }],
    customer: { firstName: "Reference", lastName: "Buyer", email: buyer, phone: "+48123456789" },
    shippingAddress: { street: "Example Street 12", postalCode: "00-001", city: "Warsaw", country: catalog.profile.country },
    currency: catalog.profile.currency };
  const checkout = (body) => bff(origin, "/api/bff/commerce/checkouts", { method: "POST", body });
  denied(await checkout({ command, paid: true }), "forged paid field", [400]);
  denied(await checkout({ command, provider: "caller" }), "forged provider field", [400]);
  const first = accepted(await checkout({ command }), "initial checkout");
  requireFact(uuid(first.orderId) && uuid(first.clientId) && uuid(first.paymentIntentId)
    && uuid(first.paymentAttemptId) && first.paymentStatus === "succeeded" && first.paymentAttemptStatus === "succeeded"
    && first.replayed === false, "Checkout lacks captured durable receipt");
  const retry = accepted(await checkout({ command }), "checkout retry");
  const concurrent = (await Promise.all([checkout({ command }), checkout({ command })]))
    .map((result) => accepted(result, "concurrent checkout retry"));
  for (const result of [retry, ...concurrent]) {
    requireFact(result.replayed === true && result.orderId === first.orderId
      && result.paymentAttemptId === first.paymentAttemptId && result.paymentIntentId === first.paymentIntentId,
    "Checkout retry changed durable order or attempt identity");
  }
  console.log(`checkout captured/replayed order=${first.orderId} attempt=${first.paymentAttemptId}`);

  const buyerToken = await signIn(setupData, buyer, seen);
  const outsiderToken = await signIn(setupData, operator, seen);
  const linked = accepted(await bff(origin, "/api/bff/customers/reconcile-account", {
    method: "POST", body: {}, bearer: buyerToken,
  }), "buyer reconcile");
  requireFact(uuid(linked.accountId), "Reconcile did not link an account");
  const account = () => bff(origin, "/api/bff/customers/account", { bearer: buyerToken });
  const before = accepted(await account(), "buyer account");
  const ownedOrder = before.recentOrders?.find((entry) => entry.orderId === first.orderId);
  const subscription = before.subscriptions?.find((entry) => entry.subscriptionId === ownedOrder?.subscriptionId);
  requireFact(ownedOrder?.paymentStatus && subscription?.status === "active" && subscription.nextCycleAt
    && subscription.canEditUpcomingPackage === true, "Buyer account lacks an editable paid subscription");
  const previous = new Date(subscription.nextCycleAt).getTime();
  const next = new Date(previous + 7 * 86_400_000).toISOString();
  const dateBody = { action: "slide_next_cycle", subscriptionId: subscription.subscriptionId,
    newNextCycleAt: next, idempotencyKey: `reference:date:${randomUUID()}` };
  const invalidDate = await bff(origin, "/api/bff/customers/subscriptions/action", {
    method: "POST", body: { ...dateBody, idempotencyKey: `reference:bad-date:${randomUUID()}`,
      newNextCycleAt: new Date(Date.now() + 86_400_000).toISOString() }, bearer: buyerToken,
  });
  denied(invalidDate, "invalid renewal date", [400, 409]);
  requireFact(["customer_self_service_invalid_slide", "subscription_lifecycle_invalid_slide"].includes(invalidDate.json.error?.details?.reason),
    "Invalid date refusal lacked its date rule");
  const outsider = await bff(origin, "/api/bff/customers/subscriptions/action", {
    method: "POST", body: dateBody, bearer: outsiderToken,
  });
  denied(outsider, "outsider renewal action", [409]);
  requireFact(["customer_self_service_not_found", "customer_self_service_forbidden"].includes(outsider.json.error?.details?.reason),
    "Outsider refusal lacked the ownership reason");
  const changed = accepted(await bff(origin, "/api/bff/customers/subscriptions/action", {
    method: "POST", body: dateBody, bearer: buyerToken,
  }), "owner renewal action");
  requireFact(changed.subscriptionAction?.subscriptionId === subscription.subscriptionId
    && changed.subscriptionAction?.status === "applied", "Renewal action did not apply");
  const after = accepted(await account(), "owner renewal readback");
  const updated = after.subscriptions?.find((entry) => entry.subscriptionId === subscription.subscriptionId);
  requireFact(new Date(updated?.nextCycleAt).getTime() === new Date(next).getTime(), "Owner readback did not retain new renewal date");
  console.log(`account linked subscription=${subscription.subscriptionId} nextRenewalAt=${updated.nextCycleAt}`);

  const readback = `/api/bff/reference-journey/operator/subscription-readback?orderId=${encodeURIComponent(first.orderId)}`;
  denied(await bff(origin, readback), "anonymous operator readback", [401, 403]);
  denied(await bff(origin, readback, { bearer: buyerToken }), "buyer operator readback", [401, 403]);
  execFileSync(process.execPath, ["--conditions=core-source", "--import", "tsx",
    "scripts/public-reference/grant-operator.mjs", "--env-file", setupData.file, "--email", operator],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const proof = accepted(await bff(origin, readback, { bearer: outsiderToken }), "operator readback");
  requireFact(proof.order?.orderId === first.orderId && proof.order.status === ownedOrder.status
    && proof.payment?.status === ownedOrder.paymentStatus
    && proof.subscription?.subscriptionId === subscription.subscriptionId
    && proof.subscription.status === updated.status
    && new Date(proof.subscription.nextRenewalAt).getTime() === new Date(next).getTime(),
  "Operator readback differs from customer paid subscription");
  console.log(`operator persisted readback paid=${proof.payment.status} subscription=${proof.subscription.subscriptionId} nextRenewalAt=${proof.subscription.nextRenewalAt}`);
}

main().catch((error) => {
  // Never print request URLs, captured mail, Auth tokens, or child-process output.
  console.error(error instanceof Error && !("stdout" in error) ? error.message : "Local operator setup failed");
  process.exitCode = 1;
});
