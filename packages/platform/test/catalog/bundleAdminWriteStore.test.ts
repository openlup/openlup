import { expect, it } from "vitest";
import { BundleRpcError, DomainRpcError, createBundleAdminWriteStore } from "../../src/catalog/index.js";

it("retains the shared SQLSTATE error identity and marshalling", async () => {
  const calls: unknown[] = [];
  const store = createBundleAdminWriteStore({
    rpc: async (name, args) => { calls.push([name, args]); return { data: null, error: { code: "42501", message: "actor_required" } }; },
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  });
  await expect(store.activate("actor", { code: "SET", mode: "commit" })).rejects.toBeInstanceOf(DomainRpcError);
  await expect(store.loadCompositionConstraint("ABSENT")).rejects.toBeInstanceOf(BundleRpcError);
  expect(calls).toEqual([["admin_activate_bundle", { p_actor_id: "actor", p_code: "SET", p_mode: "commit", p_idempotency_key: null }]]);
});
