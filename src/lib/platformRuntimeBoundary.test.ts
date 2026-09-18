// Boundary guard (Platform Portability, W1): the platform-runtime core stays provider-neutral.
// Capability waves put real adapters under server/adapters/* + server/infra/* — the kernel, ports,
// contracts, and composition root must NEVER import infra SDKs directly.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOTS = [
  "packages/core/src/platform-runtime",
  "src/domains/platform-runtime",
  "server/domains/platform-runtime",
  "server/runtime",
];

const FORBIDDEN: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "server/infra/*", re: /from\s+["'][^"']*server\/infra\// },
  { label: "@vercel/*", re: /from\s+["']@vercel\// },
  { label: "@supabase/* or supabase-js", re: /from\s+["'](@supabase\/|.*supabase-js)/ },
];

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("platform-runtime boundary", () => {
  it("core (kernel/ports/contracts/composeBundle/dispatch) imports no infra SDKs", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const src = readFileSync(file, "utf8");
        for (const { label, re } of FORBIDDEN) {
          if (re.test(src)) offenders.push(`${file} imports ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually scanned the platform-runtime source tree", () => {
    const total = ROOTS.reduce((n, root) => n + collectSourceFiles(root).length, 0);
    expect(total).toBeGreaterThanOrEqual(5);
  });
});
