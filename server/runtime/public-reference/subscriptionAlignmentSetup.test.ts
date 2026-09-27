import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_ALIGNMENT_FORWARD,
  assertSubscriptionAlignmentControl,
  readManagedForward,
  subscriptionAlignmentSeedSql,
  verifySubscriptionAlignmentControl,
} from "../../../scripts/public-reference/subscription-alignment.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS public;
    CREATE TABLE public.subscription_delivery_alignment_control (
      singleton boolean PRIMARY KEY CHECK (singleton),
      mode text NOT NULL CHECK (mode IN ('off', 'shadow', 'protect', 'auto_align'))
    );`);
  return db;
}

// An adopter's own migration carrying the managed forward, as its hosted chain names it.
const COMPANION = `-- Adopter header: the platform's alignment seed, under this chain's own name.
-- migration:platform-companion: openlup:${MANAGED_ALIGNMENT_FORWARD}

${subscriptionAlignmentSeedSql.trim()}
`;

function withMigrations(files: Record<string, string>, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "managed-forward-"));
  try {
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(root, "supabase", "migrations", name), sql);
    check(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("subscription reference alignment prerequisite", () => {
  it("keeps the reference seed identical to the managed forward and makes it a no-op", () => {
    const forward = readManagedForward(repositoryRoot, MANAGED_ALIGNMENT_FORWARD);
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

  // Only where the platform file is present; a tree that carries a companion has none to compare.
  it.skipIf(!existsSync(join(repositoryRoot, MANAGED_ALIGNMENT_FORWARD)))("reads this repository's managed forward file byte for byte", () => {
    expect(readManagedForward(repositoryRoot, MANAGED_ALIGNMENT_FORWARD))
      .toBe(readFileSync(join(repositoryRoot, MANAGED_ALIGNMENT_FORWARD), "utf8"));
  });

  it("falls back to the one adopter migration that carries the forward as its platform companion", () => {
    withMigrations({
      "20260101000000_adopter_history.sql": "CREATE TABLE app.history (id int);\n",
      "20260928000000_adopter_named_seed.sql": COMPANION,
      // A marker for another forward, and one below the leading comment block, name nothing.
      "20260929000000_other_companion.sql": `-- migration:platform-companion: openlup:supabase/migrations/20260101000000_other.sql\n${subscriptionAlignmentSeedSql}`,
      "20260930000000_late_marker.sql": `SELECT 1;\n-- migration:platform-companion: openlup:${MANAGED_ALIGNMENT_FORWARD}\n`,
    }, (root) => {
      const forward = readManagedForward(root, MANAGED_ALIGNMENT_FORWARD);
      expect(forward).toBe(COMPANION.replace(`-- migration:platform-companion: openlup:${MANAGED_ALIGNMENT_FORWARD}\n`, ""));
      expect(forward.replace(/^--.*$/gm, "").trim()).toBe(subscriptionAlignmentSeedSql.trim());
    });
  });

  it("removes every marker line from a companion that carries more than one", () => {
    const other = "-- migration:platform-companion: openlup:supabase/migrations/20260101000000_other.sql\n";
    withMigrations({ "20260928000000_adopter_named_seed.sql": COMPANION.replace("\n\n", `\n${other}\n`) }, (root) => {
      const forward = readManagedForward(root, MANAGED_ALIGNMENT_FORWARD);
      expect(forward).not.toContain("migration:platform-companion");
      expect(forward).toBe(COMPANION.replace(`-- migration:platform-companion: openlup:${MANAGED_ALIGNMENT_FORWARD}\n`, ""));
      expect(forward.replace(/^--.*$/gm, "").trim()).toBe(subscriptionAlignmentSeedSql.trim());
    });
  });

  it("prefers the platform file itself over a companion", () => {
    withMigrations({ "20260928000000_adopter_named_seed.sql": COMPANION, [MANAGED_ALIGNMENT_FORWARD.slice("supabase/migrations/".length)]: "SELECT 'platform';\n" }, (root) => {
      expect(readManagedForward(root, MANAGED_ALIGNMENT_FORWARD)).toBe("SELECT 'platform';\n");
    });
  });

  it("refuses when no companion or more than one names the absent forward", () => {
    withMigrations({ "20260929000000_other_companion.sql": "-- migration:platform-companion: openlup:supabase/migrations/20260101000000_other.sql\nSELECT 1;\n" }, (root) => {
      expect(() => readManagedForward(root, MANAGED_ALIGNMENT_FORWARD)).toThrow(`Managed forward ${MANAGED_ALIGNMENT_FORWARD} is absent, and no supabase/migrations/*.sql header carries`);
    });
    withMigrations({ "20260928000000_first.sql": COMPANION, "20260928000001_second.sql": COMPANION }, (root) => {
      expect(() => readManagedForward(root, MANAGED_ALIGNMENT_FORWARD)).toThrow("more than one supabase/migrations file names it as its platform companion: 20260928000000_first.sql, 20260928000001_second.sql");
    });
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
