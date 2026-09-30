import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scanner = join(repository, "node_modules/.bin/ast-grep");

it.each([
  ["packages/core/src/contracts.ts", true],
  ["packages/ui/src/components/Contract.tsx", true],
  ["packages/core/src/testing.ts", true],
  ["packages/core/src/contracts.test.ts", false],
  ["packages/ui/src/components/Contract.spec.tsx", false],
  ["packages/core/src/contracts.fixture.ts", false],
  ["packages/ui/src/contracts.fixtures.tsx", false],
  ["packages/core/src/__tests__/contracts.ts", false],
  ["packages/ui/src/fixtures/Contract.tsx", false],
  ["src/domains/legacy/contracts.ts", false],
  ["docs/platform/examples/Contract.tsx", false],
] as const)("applies industry policy to %s: %s", (file, blocked) => {
  const root = mkdtempSync(join(tmpdir(), "openlup-industry-"));
  try {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export interface Input { petId: string; }\n");
    const config = join(root, "sgconfig.yml");
    writeFileSync(config, `ruleDirs:\n  - ${JSON.stringify(join(repository, "scripts/ast-grep/rules"))}\n`);
    const result = spawnSync(scanner, ["scan", "--config", config, "--json=compact", "."], {
      cwd: root, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(blocked ? 1 : 0);
    const findings = JSON.parse(result.stdout) as { ruleId: string }[];
    if (blocked) {
      expect(findings.map((finding) => finding.ruleId)).toEqual([
        file.endsWith(".tsx") ? "portable-no-industry-contracts-tsx" : "portable-no-industry-contracts",
      ]);
    } else {
      expect(findings).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
