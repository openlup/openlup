import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const platformDir = join(root, "packages/platform");
const scriptSource = join(platformDir, "scripts/api-contract.ts");

function createFixture(
  files: Record<string, string>,
  subpaths: Record<string, { entrypoint: string; snapshot: string; maturity?: "stable" | "experimental" | "testing" }>,
): { dir: string; cleanup: () => void; run: (...args: string[]) => ReturnType<typeof spawnSync> } {
  const base = join(root, ".context/scratch/platform-api-scoping");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "case-"));
  const write = (rel: string, content: string) => {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const exportsField: Record<string, unknown> = { "./package.json": "./package.json" };
  const packageSurface: Record<string, unknown> = {};
  for (const [subpath, contract] of Object.entries(subpaths)) {
    const jsEntry = `./${contract.entrypoint.replace(/\.d\.ts$/, ".js")}`;
    const maturity = contract.maturity ?? "stable";
    exportsField[subpath] = {
      types: `./${contract.entrypoint}`,
      import: jsEntry,
      default: jsEntry,
    };
    packageSurface[subpath] = {
      role: "capability",
      maturity,
      compatibilityPolicy: maturity,
      entrypoint: contract.entrypoint,
      snapshot: contract.snapshot,
    };
  }

  write("package.json", JSON.stringify({ name: "@openlup/platform-fixture", type: "module", exports: exportsField }, null, 2));
  write("release-gates.json", JSON.stringify({
    kind: "rail",
    compatibilityPolicies: {
      stable: "Stable API fixture policy.",
      experimental: "Experimental API fixture policy.",
      testing: "Testing API fixture policy.",
    },
    packageSurface,
  }, null, 2));

  const targetScript = join(dir, "scripts/api-contract.ts");
  mkdirSync(dirname(targetScript), { recursive: true });
  cpSync(scriptSource, targetScript);

  for (const [rel, content] of Object.entries(files)) {
    write(rel, content);
  }

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    run: (...args: string[]) => spawnSync(
      process.execPath,
      ["--experimental-strip-types", targetScript, ...args],
      { cwd: dir, encoding: "utf8", timeout: 15_000 },
    ),
  };
}

describe("platform api-contract subpath scoping", () => {
  it("stops pure imports at stable sibling and nested subpath boundaries while keeping local and unowned helpers", () => {
    const fixture = createFixture(
      {
        "dist/shared/internal.d.ts": "export type SharedInternal = string;\n",
        "dist/sibling/index.d.ts": "export interface SiblingExecutor { query(sql: string): Promise<void>; }\n",
        "dist/parent/child/index.d.ts": "export interface ChildContract { id: string; }\n",
        "dist/parent/helper.d.ts": "import type { SharedInternal } from '../shared/internal.js';\nexport type ParentHelper = SharedInternal;\n",
        "dist/parent/index.d.ts": [
          "import type { SiblingExecutor } from '../sibling/index.js';",
          "import type { ChildContract } from './child/index.js';",
          "import type { ParentHelper } from './helper.js';",
          "export type InlineImport = import('../sibling/index.js').SiblingExecutor;",
          "export declare function runParent(exec: SiblingExecutor, child: ChildContract, helper: ParentHelper): void;",
          "",
        ].join("\n"),
      },
      {
        "./sibling": { entrypoint: "dist/sibling/index.d.ts", snapshot: "api/sibling.api.md" },
        "./parent": { entrypoint: "dist/parent/index.d.ts", snapshot: "api/parent.api.md" },
        "./parent/child": { entrypoint: "dist/parent/child/index.d.ts", snapshot: "api/parent-child.api.md" },
      },
    );

    try {
      const updated = fixture.run("--update");
      expect(updated.stderr).toBe("");
      expect(updated.status).toBe(0);

      const parentApi = readFileSync(join(fixture.dir, "api/parent.api.md"), "utf8");
      expect(parentApi).toContain("## dist/parent/index.d.ts");
      expect(parentApi).toContain("## dist/parent/helper.d.ts");
      expect(parentApi).toContain("## dist/shared/internal.d.ts");
      expect(parentApi).not.toContain("## dist/sibling/index.d.ts");
      expect(parentApi).not.toContain("## dist/parent/child/index.d.ts");

      const check = fixture.run();
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["experimental", "testing"] as const)("retains stable pure imports from a %s sibling", (maturity) => {
    const fixture = createFixture(
      {
        "dist/contracts/index.d.ts": "export interface Input { id: string; }\n",
        "dist/consumer/index.d.ts": "import type { Input } from '../contracts/index.js';\nexport declare function accept(input: Input): void;\n",
      },
      {
        "./contracts": { entrypoint: "dist/contracts/index.d.ts", snapshot: "api/contracts.api.md", maturity },
        "./consumer": { entrypoint: "dist/consumer/index.d.ts", snapshot: "api/consumer.api.md" },
      },
    );
    try {
      const result = fixture.run("--update");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(join(fixture.dir, "api/consumer.api.md"), "utf8")).toContain("## dist/contracts/index.d.ts");
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses declarations omitted from all snapshots and names the missing files and fix", () => {
    const fixture = createFixture(
      {
        "dist/contracts/index.d.ts": "export type PublicInput = string;\n",
        "dist/contracts/detail.d.ts": "export type Detail = string;\n",
        "dist/contracts/private.d.ts": "import type { Detail } from './detail.js';\nexport type Input = Detail;\n",
        "dist/consumer/index.d.ts": "import type { Input } from '../contracts/private.js';\nexport declare function accept(input: Input): void;\n",
      },
      {
        "./contracts": { entrypoint: "dist/contracts/index.d.ts", snapshot: "api/contracts.api.md" },
        "./consumer": { entrypoint: "dist/consumer/index.d.ts", snapshot: "api/consumer.api.md" },
      },
    );
    try {
      const result = fixture.run("--update");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("API snapshots omit declarations: dist/contracts/detail.d.ts, dist/contracts/private.d.ts; make each missing declaration reachable from its owning subpath entrypoint or move it to a shared directory outside declared subpath roots");
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses duplicate entrypoint directories and names the directory, subpaths and fix", () => {
    const fixture = createFixture(
      {
        "dist/shared/a.d.ts": "export type A = string;\n",
        "dist/shared/b.d.ts": "export type B = string;\n",
      },
      {
        "./a": { entrypoint: "dist/shared/a.d.ts", snapshot: "api/a.api.md" },
        "./b": { entrypoint: "dist/shared/b.d.ts", snapshot: "api/b.api.md" },
      },
    );
    try {
      const result = fixture.run("--update");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("duplicate declaration entrypoint directory dist/shared for ./a and ./b; give each subpath its own entrypoint directory");
    } finally {
      fixture.cleanup();
    }
  });

  it("retains explicitly re-exported sibling declarations across export-from, local export, and default export", () => {
    const fixture = createFixture(
      {
        "dist/contracts/direct.d.ts": "export type DirectContract = 'direct';\n",
        "dist/contracts/local.d.ts": "export type LocalReexported = 'local';\n",
        "dist/contracts/def.d.ts": "declare const defaultThing: string;\nexport default defaultThing;\n",
        "dist/contracts/unused.d.ts": "export type PurelyImported = 'unused';\n",
        "dist/contracts/index.d.ts": "export * from './direct.js';\nexport * from './local.js';\nexport * from './unused.js';\n",
        "dist/consumer/index.d.ts": [
          "import type { LocalReexported as AliasedLocal } from '../contracts/local.js';",
          "import defaultThing from '../contracts/def.js';",
          "import type { PurelyImported } from '../contracts/unused.js';",
          "export type { DirectContract } from '../contracts/direct.js';",
          "export type { AliasedLocal };",
          "export default defaultThing;",
          "export declare function accept(value: PurelyImported): void;",
          "",
        ].join("\n"),
      },
      {
        "./contracts": { entrypoint: "dist/contracts/index.d.ts", snapshot: "api/contracts.api.md" },
        "./consumer": { entrypoint: "dist/consumer/index.d.ts", snapshot: "api/consumer.api.md" },
      },
    );

    try {
      const updated = fixture.run("--update");
      expect(updated.stderr).toBe("");
      expect(updated.status).toBe(0);

      const consumerApi = readFileSync(join(fixture.dir, "api/consumer.api.md"), "utf8");
      expect(consumerApi).toContain("## dist/consumer/index.d.ts");
      expect(consumerApi).toContain("## dist/contracts/direct.d.ts");
      expect(consumerApi).toContain("## dist/contracts/local.d.ts");
      expect(consumerApi).toContain("## dist/contracts/def.d.ts");
      expect(consumerApi).not.toContain("## dist/contracts/unused.d.ts");
    } finally {
      fixture.cleanup();
    }
  });

  it("still refuses broken relative imports and declarations escaping dist/", () => {
    const missingFixture = createFixture(
      {
        "dist/a/index.d.ts": "import type { Ghost } from '../b/missing.js';\nexport declare const x: Ghost;\n",
        "dist/b/index.d.ts": "export type Real = string;\n",
      },
      {
        "./a": { entrypoint: "dist/a/index.d.ts", snapshot: "api/a.api.md" },
        "./b": { entrypoint: "dist/b/index.d.ts", snapshot: "api/b.api.md" },
      },
    );
    try {
      const result = missingFixture.run("--update");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot resolve ../b/missing.js");
    } finally {
      missingFixture.cleanup();
    }

    const escapeFixture = createFixture(
      {
        "outside.d.ts": "export type Escaped = string;\n",
        "dist/a/index.d.ts": "import type { Escaped } from '../../outside.js';\nexport declare const x: Escaped;\n",
      },
      {
        "./a": { entrypoint: "dist/a/index.d.ts", snapshot: "api/a.api.md" },
      },
    );
    try {
      const result = escapeFixture.run("--update");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("declaration escaped dist");
    } finally {
      escapeFixture.cleanup();
    }
  });

  it("keeps real platform snapshots scoped without losing explicit re-exports", () => {
    const schedulerApi = readFileSync(join(platformDir, "api/scheduler.api.md"), "utf8");
    expect(schedulerApi).toContain("## dist/scheduler/index.d.ts");
    expect(schedulerApi).not.toContain("## dist/data/index.d.ts");

    const communicationsApi = readFileSync(join(platformDir, "api/communications.api.md"), "utf8");
    expect(communicationsApi).toContain("## dist/communications/contracts/marketingSync.d.ts");
    expect(communicationsApi).not.toContain("## dist/data/index.d.ts");
  });
});
