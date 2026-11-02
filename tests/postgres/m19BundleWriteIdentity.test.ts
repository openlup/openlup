import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as packaged from "@openlup/platform/catalog";
import { createBundleAdminWriteStore } from "../../server/adapters/bundleAdminWriteStore.js";
import { createPostgresBundleAdminWriteStore } from "../../server/adapters/postgres/bundleAdminWriteStore.js";
import { BundleRpcError } from "../../server/domains/bundle/adminBundleWritePort.js";
import { DomainRpcError, mapRpcError } from "../../server/_lib/admin-domain/rpcErrors.js";
import type { VercelResponse } from "../../server/_lib/types/vercel.js";

it("preserves old-path constructors, factory identity and response mapping for errors thrown by packaged code", async () => {
  expect(BundleRpcError).toBe(packaged.BundleRpcError);
  expect(DomainRpcError).toBe(packaged.DomainRpcError);
  expect(createBundleAdminWriteStore).toBe(packaged.createBundleAdminWriteStore);
  expect(createPostgresBundleAdminWriteStore).toBe(packaged.createPostgresBundleAdminWriteStore);
  for (const [sqlstate, message, status, code, reason] of [
    ["42501", "actor_required", 403, "FORBIDDEN", "actor_required"],
    ["P0001", "min_components", 409, "CONFLICT", "min_components"],
    ["P0002", "bundle_not_found", 404, "NOT_FOUND", "bundle_not_found"],
    ["23505", "duplicate", 409, "CONFLICT", "already_exists"],
    ["XX000", "opaque", 503, "UPSTREAM_UNAVAILABLE", undefined],
  ] as const) {
    const store = packaged.createBundleAdminWriteStore({
      rpc: async () => ({ data: null, error: { code: sqlstate, message } }),
      from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    });
    const error = await store.activate("actor", { code: "SET", mode: "commit" }).catch(error => error);
    expect(error).toBeInstanceOf(BundleRpcError);
    expect(error).toBeInstanceOf(DomainRpcError);
    expect(error).toMatchObject({ sqlstate, pgMessage: message });
    let observedStatus: number | undefined, observedBody: unknown;
    const response = { setHeader() {}, status(value: number) { observedStatus = value; return this; }, json(body: unknown) { observedBody = body; return this; } } as unknown as VercelResponse;
    mapRpcError(response, error, "Write failed");
    expect(observedStatus).toBe(status);
    expect(observedBody).toEqual({ ok: false, error: { code, message: reason ?? "Write failed", ...(reason ? { details: { reason } } : {}) } });
  }
});

it("uses the same constructors in a real root Node runtime and direct built modules", () => {
  const source = `
    import assert from 'node:assert/strict';
    import { DomainRpcError as oldBase } from './server/_lib/admin-domain/rpcErrors.ts';
    import { BundleRpcError as oldBundle } from './server/domains/bundle/adminBundleWritePort.ts';
    import { createBundleAdminWriteStore } from './packages/platform/dist/catalog/bundleAdminWriteStore.js';
    import { BundleRpcError, DomainRpcError } from '@openlup/platform/catalog';
    assert.equal(oldBase,DomainRpcError);assert.equal(oldBundle,BundleRpcError);
    const store=createBundleAdminWriteStore({rpc:async()=>({data:null,error:{code:'42501',message:'actor_required'}})});
    await assert.rejects(store.activate('actor',{code:'SET',mode:'commit'}),e=>e instanceof oldBase && e instanceof oldBundle && e.sqlstate==='42501');
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), stdio: "pipe" });
  // Confirm this witness actually used emitted JavaScript, without a bundled per-entry class copy.
  expect(readFileSync("packages/platform/dist/catalog/bundleAdminWriteStore.js", "utf8")).toContain('from "./bundleRpcError.js"');
});
