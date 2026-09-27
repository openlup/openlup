import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  assertSubscriptionAlignmentControl,
  subscriptionAlignmentSeedSql,
  verifySubscriptionAlignmentControl,
} from "../../../scripts/public-reference/subscription-alignment.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS public;
    CREATE TABLE public.subscription_delivery_alignment_control (
      singleton boolean PRIMARY KEY CHECK (singleton),
      mode text NOT NULL CHECK (mode IN ('off', 'shadow', 'protect', 'auto_align'))
    );`);
  return db;
}

describe("subscription reference alignment prerequisite", () => {
  it("keeps the reference seed identical to the managed forward and makes it a no-op", () => {
    const forward = readFileSync(new URL("../../../supabase/migrations/20260927131453_seed_subscription_delivery_alignment_control.sql", import.meta.url), "utf8");
    expect(forward.replace(/^--.*$/gm, "").trim()).toBe(subscriptionAlignmentSeedSql.trim());
    const db = database();
    try {
      db.exec(forward);
      const before = db.prepare("SELECT singleton, mode FROM public.subscription_delivery_alignment_control").all();
      db.exec(subscriptionAlignmentSeedSql);
      expect(db.prepare("SELECT singleton, mode FROM public.subscription_delivery_alignment_control").all()).toEqual(before);
      expect(before).toEqual([{ singleton: 1, mode: "auto_align" }]);
    } finally { db.close(); }
  });

  it("seeds the absent singleton as auto_align and is safe to replay", () => {
    const db = database();
    try {
      db.exec(subscriptionAlignmentSeedSql);
      db.exec(subscriptionAlignmentSeedSql);
      expect(db.prepare("SELECT singleton, mode FROM public.subscription_delivery_alignment_control").all())
        .toEqual([{ singleton: 1, mode: "auto_align" }]);
    } finally { db.close(); }
  });

  it.each(["off", "shadow", "protect", "auto_align"])("preserves an existing %s choice", (mode) => {
    const db = database();
    try {
      db.prepare("INSERT INTO public.subscription_delivery_alignment_control VALUES (true, ?)").run(mode);
      db.exec(subscriptionAlignmentSeedSql);
      expect(db.prepare("SELECT mode FROM public.subscription_delivery_alignment_control").all()).toEqual([{ mode }]);
    } finally { db.close(); }
  });

  it("refuses a missing row rather than interpreting it as off", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("[]"));
    await expect(verifySubscriptionAlignmentControl({ origin: "http://127.0.0.1:56821", serviceRoleKey: "fixture-service" }, fetcher))
      .rejects.toThrow("singleton row is missing");
  });

  it.each(["off", "shadow", "protect", null])("refuses mode %s for the reference invariant", (mode) => {
    expect(() => assertSubscriptionAlignmentControl([{ singleton: true, mode }])).toThrow("requires alignment mode auto_align");
  });

  it.each([[null], [{}], [[{ singleton: false, mode: "auto_align" }]],
    [[{ singleton: true, mode: "auto_align" }, { singleton: true, mode: "auto_align" }]]])("refuses invalid readback %j", (rows) => {
    expect(() => assertSubscriptionAlignmentControl(rows)).toThrow("readback is invalid");
  });

  it("reads the actual singleton with a bounded read-only local request", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ singleton: true, mode: "auto_align" }])));
    await expect(verifySubscriptionAlignmentControl({ origin: "http://127.0.0.1:56821", serviceRoleKey: "fixture-service" }, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:56821/rest/v1/subscription_delivery_alignment_control?singleton=eq.true&select=singleton,mode",
      expect.objectContaining({ method: "GET", redirect: "error", headers: { apikey: "fixture-service", authorization: "Bearer fixture-service" }, signal: expect.any(AbortSignal) }),
    );
  });

  it.each([new Response("denied", { status: 403 }), new Response("not json")])("fails on unavailable HTTP readback", async (response) => {
    await expect(verifySubscriptionAlignmentControl({ origin: "http://127.0.0.1:56821", serviceRoleKey: "fixture-service" }, vi.fn().mockResolvedValue(response)))
      .rejects.toThrow("control readback is unavailable");
  });

  it("sanitizes transport errors", async () => {
    await expect(verifySubscriptionAlignmentControl({ origin: "http://127.0.0.1:56821", serviceRoleKey: "fixture-service" }, vi.fn().mockRejectedValue(new Error("sensitive transport detail"))))
      .rejects.toThrow("control readback is unavailable");
  });

  it.each(["https://remote.example", "http://127.0.0.1:56821/path", "http://user@localhost:56821"])("refuses an unsafe origin before fetching: %s", async (origin) => {
    const fetcher = vi.fn();
    await expect(verifySubscriptionAlignmentControl({ origin, serviceRoleKey: "fixture-service" }, fetcher)).rejects.toThrow("loopback HTTP origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the owned readback credential before fetching", async () => {
    const fetcher = vi.fn();
    await expect(verifySubscriptionAlignmentControl({ origin: "http://127.0.0.1:56821", serviceRoleKey: "" }, fetcher)).rejects.toThrow("credential is unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
