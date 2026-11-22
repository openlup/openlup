import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVENTORY_CONCURRENCY,
  MAX_INVENTORY_CONCURRENCY,
  mapWithConcurrency,
  parseInventoryConcurrency,
  resolveInventoryResourceGate,
} from "./installation-inventory-refresh.ts";

describe("installation-inventory-refresh concurrency and resource gating", () => {
  it("parses OPENLUP_INVENTORY_CONCURRENCY with default 3 and refuses invalid values", () => {
    expect(parseInventoryConcurrency(undefined)).toBe(DEFAULT_INVENTORY_CONCURRENCY);
    expect(parseInventoryConcurrency("")).toBe(DEFAULT_INVENTORY_CONCURRENCY);
    expect(parseInventoryConcurrency("   ")).toBe(DEFAULT_INVENTORY_CONCURRENCY);
    for (let value = 1; value <= MAX_INVENTORY_CONCURRENCY; value += 1) {
      expect(parseInventoryConcurrency(String(value))).toBe(value);
      expect(parseInventoryConcurrency(` ${value} `)).toBe(value);
    }
    for (const invalid of ["0", "-1", "6", "10", "1.5", "3px", "abc", "Infinity"]) {
      expect(() => parseInventoryConcurrency(invalid)).toThrow(
        "OPENLUP_INVENTORY_CONCURRENCY must be a positive integer between 1 and 5.",
      );
    }
  });

  it("bounds active workers, preserves input order, and waits for in-flight cleanup on failure", async () => {
    let active = 0;
    let peak = 0;
    const delays = [40, 10, 30, 5, 15];
    const items = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"];
    const results = await mapWithConcurrency(items, 3, async (item, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, delays[index]!));
      active -= 1;
      return `${index}:${item}`;
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(results).toEqual([
      "0:legacy",
      "1:bootstrap",
      "2:separate",
      "3:admin-managed",
      "4:admin-operator",
    ]);

    const cleaned: string[] = [];
    const started: string[] = [];
    await expect(mapWithConcurrency(items, 2, async (item) => {
      started.push(item);
      if (item === "legacy") {
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error("boom-legacy");
      }
      try {
        await new Promise(resolve => setTimeout(resolve, 40));
        return item;
      } finally {
        cleaned.push(item);
      }
    })).rejects.toThrow("boom-legacy");
    // The in-flight sibling finishes its finally cleanup before rejection propagates,
    // and queued items after the failure never start.
    expect(started).toEqual(["legacy", "bootstrap"]);
    expect(cleaned).toEqual(["bootstrap"]);

    await expect(mapWithConcurrency(items, 0, async item => item)).rejects.toThrow(
      "concurrency must be a positive integer.",
    );
  });

  it("gates local runs through ai-resource-gate on docker-heavy and bypasses in CI, nested gate, opt-out, or absence", () => {
    const argv = ["scripts/installation-inventory-refresh.ts"];
    const baseEnv = { PATH: "/custom/bin:/usr/bin" };
    const hit = (candidate: string) => candidate === "/custom/bin/ai-resource-gate";

    const invocation = resolveInventoryResourceGate("/tmp/wt-a", "/usr/bin/node", ["--import", "tsx"], argv, baseEnv, hit);
    expect(invocation).not.toBeNull();
    expect(invocation!.command).toBe("/custom/bin/ai-resource-gate");
    expect(invocation!.args.slice(0, 4)).toEqual(["run", "--wait", "--lane", "docker-heavy"]);
    expect(invocation!.args[4]).toMatch(/^openlup:inventory-refresh:wt\d+$/u);
    expect(invocation!.args.slice(5)).toEqual(["--", "/usr/bin/node", "--import", "tsx", "scripts/installation-inventory-refresh.ts"]);

    // Distinct worktrees produce distinct numeric suffixes.
    const other = resolveInventoryResourceGate("/tmp/wt-b", "/usr/bin/node", ["--import", "tsx"], argv, baseEnv, hit);
    expect(other!.args[4]).not.toBe(invocation!.args[4]);

    // Bypasses cleanly in CI, inside an already-active gate, with opt-out, or when broker is absent.
    expect(resolveInventoryResourceGate("/tmp/wt-a", "/usr/bin/node", [], argv, { ...baseEnv, CI: "true" }, hit)).toBeNull();
    expect(resolveInventoryResourceGate("/tmp/wt-a", "/usr/bin/node", [], argv, { ...baseEnv, AI_RESOURCE_GATE_ACTIVE: "1" }, hit)).toBeNull();
    expect(resolveInventoryResourceGate("/tmp/wt-a", "/usr/bin/node", [], argv, { ...baseEnv, OPENLUP_DISABLE_RESOURCE_GATE: "1" }, hit)).toBeNull();
    expect(resolveInventoryResourceGate("/tmp/wt-a", "/usr/bin/node", [], argv, baseEnv, () => false)).toBeNull();
  });
});
