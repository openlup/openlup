import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { request } from "./subscriptionNativeFixture.js";
import { call, later, lifecycleDeclined, lifecycleInstallation, lifecycleProfiles, lifecycleRows, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

// Opaque references are exact strings. These witnesses add no SQL and do not
// duplicate the existing canonical-only sandbox evidence/refusal matrix.
describe.each(lifecycleProfiles)("payment reference contract witnesses on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (env) await env.close(); }, postgresTeardownTimeoutMs);
  it("refuses a re-spelled authorized method with no prepare receipt, dispatch or settlement", async () => {
    const f = await lifecycleDeclined(env.owner), method = `Method-${randomUUID()}`;
    const authorization = await call(env.runtime, "subscription_retry_authorize_recovery", [f.operation.toUpperCase(), f.token.toUpperCase(), method, "verified-method", later(1)]);
    await call(env.runtime, "subscription_retry_schedule_recovery", [f.operation.toUpperCase(), `schedule:${f.operation}`, authorization.id, later(1)]);
    const before = await lifecycleRows(env.owner), execute = vi.fn();
    const prepareAndDispatch = async () => {
      const prepared = await call(env.runtime, "subscription_retry_prepare", [f.operation.toUpperCase(), `mismatch:${f.operation}`, { ...request(f), paymentMethodRef: method.toUpperCase() }, later(1)]);
      if (prepared.execute) execute();
    };
    await expect(prepareAndDispatch()).rejects.toThrow("subscription_retry_method_mismatch");
    expect(execute).not.toHaveBeenCalled();
    expect(await lifecycleRows(env.owner)).toEqual(before);
  }, 30_000);
  it.each(["UPPERCASE-METHOD", "Opaque-{ReSpelled}-Method"])("replays a stored %s prepare exactly and refuses changed spelling under its key", async method => {
    const f = await lifecycleDeclined(env.owner), input = { ...request(f), paymentMethodRef: method }, key = `opaque:${f.operation}`;
    const prepared = await call(env.runtime, "subscription_retry_prepare", [f.operation.toUpperCase(), key, input, later(24)]);
    expect(prepared).toMatchObject({ execute: true, request: input });
    const before = await lifecycleRows(env.owner);
    expect(await call(env.runtime, "subscription_retry_prepare", [f.operation.toUpperCase(), key, input, later(25)]))
      .toEqual({ ...prepared, execute: false, replayed: true });
    await expect(call(env.runtime, "subscription_retry_prepare", [f.operation.toUpperCase(), key, { ...input, paymentMethodRef: method.toLowerCase() }, later(25)]))
      .rejects.toMatchObject({ code: "23505" });
    expect(await lifecycleRows(env.owner)).toEqual(before);
  }, 30_000);
});
