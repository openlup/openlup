import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCheckoutRecoveryTokenPort, hashCheckoutRecoveryToken } from "@openlup/platform/commerce/server";
import { lifecycleDeclined, lifecycleInstallation, lifecycleProfiles, call, AT, later,
  type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

describe.each(lifecycleProfiles)("checkout recovery link lifecycle on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => {
    env = await lifecycleInstallation(profile);
    // Legacy has no qualified runtime bootstrap; its installer is the execution lane.
    // The service capability name is fixture-only, added after inventory verification.
    if (profile === "legacy") await env.owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS");
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);
  const port = () => createPostgresCheckoutRecoveryTokenPort({ run: async work => {
    const db = await env.runtime.connect();
    try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  } });
  const issue = (orderId: string, rawToken: string) => port().issue({ orderId, rawToken, expiresAt: "2099-01-01T00:00:00Z" });

  it("keeps both checkout links active and read-only until payment consumes both", async () => {
    const client = randomUUID(), order = randomUUID(), intent = randomUUID();
    await env.owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    const db = await env.owner.connect();
    try {
      await db.query("BEGIN");
      await db.query(`INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor)
        VALUES($1,$2,'XXX',100)`, [order, client]);
      await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        VALUES($1,1,1,100,100)`, [order]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    const raw = [randomUUID(), randomUUID()];
    const ids = [await issue(order, raw[0]!), await issue(order, raw[1]!)];
    const rows = async () => (await env.owner.query("SELECT to_jsonb(t) AS value,xmin::text AS version FROM public.commerce_checkout_recovery_tokens t WHERE order_id=$1 ORDER BY id", [order])).rows;
    const before = await rows();
    for (const [index, value] of raw.entries()) {
      expect(await port().inspect(value)).toMatchObject({ tokenId: ids[index], tokenState: "active" });
      expect(await port().validate(value)).toMatchObject({ orderId: order });
      expect(await issue(order, value)).toBe(ids[index]);
    }
    expect(await rows()).toEqual(before);
    expect(await port().inspect("unknown-link")).toBeNull();
    await env.owner.query(`INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
      VALUES($1,$2,'sandbox',100,'XXX',$3)`, [intent, order, `intent:${intent}`]);
    await call(env.runtime, "commerce_record_settlement", [`paid:${intent}`, intent, "succeeded"]);
    for (const value of raw) {
      expect(await call(env.runtime, "customer_checkout_recovery_token_inspect", [hashCheckoutRecoveryToken(value)]))
        .toMatchObject({ tokenState: "consumed", status: "paid" });
      expect(await port().validate(value)).toBeNull();
    }
    expect(await rows()).toEqual(before);
  });

  it("refuses renewal checkout issuance while retaining case rotation and console replay", async () => {
    const f = await lifecycleDeclined(env.owner);
    const before = (await env.owner.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [f.original.orderId])).rows;
    await expect(issue(f.original.orderId, randomUUID())).rejects.toThrow("checkout_recovery_order_not_recoverable");
    expect((await env.owner.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [f.original.orderId])).rows).toEqual(before);
    await env.owner.query("UPDATE public.clients SET lifecycle_stage='customer' WHERE id=$1", [f.client]);
    const operator = randomUUID();
    await env.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [operator, `${operator}@example.invalid`]);
    await env.owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
    const expiry = (await env.owner.query("SELECT now()+interval '1 day' AS at")).rows[0].at.toISOString();
    const invoke = (key: string, raw: string) => call(env.runtime, "customer_support_issue_recovery",
      [operator, f.client, f.caseId, key, hashCheckoutRecoveryToken(key), hashCheckoutRecoveryToken(raw), expiry, "/recover"]);
    const key = `console:${randomUUID()}`, first = randomUUID(), second = randomUUID();
    const result = await invoke(key, first);
    expect(result).toMatchObject({ outcome: "issued" });
    expect(await invoke(key, first)).toEqual({ ...result, outcome: "replayed" });
    await invoke(`console:${randomUUID()}`, second);
    expect(await port().inspect(first)).toMatchObject({ tokenState: "revoked" });
    expect(await port().inspect(second)).toMatchObject({ tokenState: "active" });
    expect((await env.owner.query("SELECT count(*)::int AS n FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 AND revoked_at IS NULL", [f.original.orderId])).rows[0].n).toBe(1);
  });

  it("serializes two case issuances on separate connections before revoke and insert", async () => {
    const f = await lifecycleDeclined(env.owner), first = randomUUID(), second = randomUUID();
    const a = await env.runtime.connect(), b = await env.runtime.connect();
    let issuance: Promise<unknown> | undefined;
    try {
      await a.query("BEGIN"); await b.query("BEGIN");
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await call(a, "dunning_lifecycle_issue_recovery_token", [f.caseId, hashCheckoutRecoveryToken(first), "2099-01-01T00:00:00Z"]);
      issuance = call(b, "dunning_lifecycle_issue_recovery_token", [f.caseId, hashCheckoutRecoveryToken(second), "2099-01-01T00:00:00Z"]);
      issuance.catch(() => {});
      let blocked = false;
      for (let tries = 0; tries < 100 && !blocked; tries++) {
        blocked = (await env.owner.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await a.query("COMMIT");
      expect(await issuance).toMatchObject({ issued: true, orderId: f.original.orderId });
      await b.query("COMMIT");
      expect(await port().inspect(first)).toMatchObject({ tokenState: "revoked" });
      expect(await port().inspect(second)).toMatchObject({ tokenState: "active" });
      expect((await env.owner.query("SELECT count(*)::int AS n FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 AND revoked_at IS NULL", [f.original.orderId])).rows[0].n).toBe(1);
    } finally { await a.query("ROLLBACK"); await issuance?.catch(() => {}); await b.query("ROLLBACK"); a.release(); b.release(); }
  });

  it("rolls failed issuance back before a later case link rotates the prior link", async () => {
    const f = await lifecycleDeclined(env.owner);
    const rows = async () => (await env.owner.query("SELECT to_jsonb(t) AS value,xmin::text AS version FROM public.commerce_checkout_recovery_tokens t WHERE order_id=$1 ORDER BY id", [f.original.orderId])).rows;
    const before = await rows();
    await expect(call(env.runtime, "dunning_lifecycle_issue_recovery_token", [f.caseId, hashCheckoutRecoveryToken(randomUUID()), "2000-01-01T00:00:00Z"]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await rows()).toEqual(before);
    const raw = randomUUID();
    await call(env.runtime, "dunning_lifecycle_issue_recovery_token", [f.caseId, hashCheckoutRecoveryToken(raw), "2099-01-01T00:00:00Z"]);
    expect((await env.owner.query("SELECT revoked_at IS NOT NULL AS revoked FROM public.commerce_checkout_recovery_tokens WHERE id=$1", [f.token])).rows)
      .toEqual([{ revoked: true }]);
    expect(await port().inspect(raw)).toMatchObject({ tokenState: "active" });
  });

  it.each(["cancel", "recover", "authorize"])("retains %s revocation", async action => {
    const f = await lifecycleDeclined(env.owner);
    if (action === "cancel") {
      expect(await call(env.runtime, "subscription_command_apply", [f.actor, f.client, `cancel:${f.subscription}`, f.subscription, "cancel", {}, AT]))
        .toMatchObject({ status: "applied" });
    } else if (action === "recover") {
      await call(env.runtime, "dunning_lifecycle_record_recovery", [f.caseId, AT, "recovered"]);
    } else {
      await call(env.runtime, "subscription_retry_authorize_recovery", [f.operation, f.token, "method", "healthy-method", later(1)]);
    }
    expect((await env.owner.query("SELECT revoked_at IS NOT NULL AS revoked FROM public.commerce_checkout_recovery_tokens WHERE id=$1", [f.token])).rows)
      .toEqual([{ revoked: true }]);
    if (profile !== "legacy") {
      expect((await env.runtime.query("SELECT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged")).rows)
        .toEqual([{ privileged: false }]);
    }
  });
});
