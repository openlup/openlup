import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Dormancy tripwire for the back-in-stock alert (intentionally NOT wired).
//
// The full path exists — subscribers are recorded (commerce_product_stock_notifications),
// the outbox handler + email renderer are built and flag-gated — but NOTHING calls the
// enqueue_back_in_stock(sku) RPC on a restock, so the alert can never fire and pending
// subscriptions accumulate with notified_at = NULL forever. This is a deliberate parked
// state, not an oversight.
//
// This test fails the moment a runtime caller of enqueue_back_in_stock appears.
// That is the signal to consciously finish the wiring: add the restock cron +
// COMMERCE_BACK_IN_STOCK_* flag, thread a locale into the handler (today it is
// hard-coded PL), update the email canon, and delete this guard. It exists so
// the dormancy can never be silently assumed to be "live".

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scanDirs = ["server", "api", "src"].map((d) => join(repoRoot, d));
const ENQUEUE_RPC = "enqueue_back_in_stock";

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "coverage") continue;
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      if (full === join(repoRoot, "src/integrations/supabase/types.ts")) continue;
      acc.push(full);
    }
  }
  return acc;
}

describe("back-in-stock dormancy", () => {
  it("has NO runtime caller of enqueue_back_in_stock (intentionally parked)", () => {
    const callers = scanDirs
      .flatMap((dir) => collectTsFiles(dir))
      .filter((file) => hasActiveTokenReference(file, ENQUEUE_RPC))
      .map((file) => file.replace(`${repoRoot}/`, ""));

    expect(
      callers,
      `enqueue_back_in_stock is now called from: ${callers.join(", ")}. ` +
        "If wiring the restock trigger is intended, finish the path (cron + flag + handler locale + canon) and delete this dormancy guard.",
    ).toEqual([]);
  });
});

function hasActiveTokenReference(file: string, token: string): boolean {
  return readFileSync(file, "utf8").split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return line.includes(token) &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("/*");
  });
}
