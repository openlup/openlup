import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TSBUILDINFO_FILENAME,
  buildPackageIncremental,
  hasOrphanDistFiles,
} from "./build-packages-incremental.mjs";

const tempDirs: string[] = [];

function createTempPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), "openlup-inc-build-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(dir, "tsconfig.build.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          declaration: true,
          declarationMap: true,
          sourceMap: false,
          rootDir: "src",
          outDir: "dist",
          resolveJsonModule: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "src/index.ts"), 'export const answer = 42;\nexport * from "./extra.js";\n');
  writeFileSync(join(dir, "src/extra.ts"), 'export const extra = "ok";\n');
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("build-packages-incremental", () => {
  it("reuses .tsbuildinfo-build on unchanged second run without rewriting dist outputs", () => {
    const dir = createTempPackage();

    const first = buildPackageIncremental(dir, { stdio: "pipe" });
    expect(first.resetReason).toBeNull();
    expect(existsSync(join(dir, "dist/index.js"))).toBe(true);
    expect(existsSync(join(dir, "dist/index.d.ts"))).toBe(true);
    expect(existsSync(join(dir, TSBUILDINFO_FILENAME))).toBe(true);
    expect(hasOrphanDistFiles(dir)).toBe(false);

    const mtimeBefore = statSync(join(dir, "dist/index.js")).mtimeMs;
    const second = buildPackageIncremental(dir, { stdio: "pipe" });
    expect(second.resetReason).toBeNull();
    expect(statSync(join(dir, "dist/index.js")).mtimeMs).toBe(mtimeBefore);
  });

  it("recovers from stale .tsbuildinfo-build when dist/ is deleted", () => {
    const dir = createTempPackage();
    buildPackageIncremental(dir, { stdio: "pipe" });

    rmSync(join(dir, "dist"), { recursive: true, force: true });
    expect(existsSync(join(dir, TSBUILDINFO_FILENAME))).toBe(true);

    const rebuilt = buildPackageIncremental(dir, { stdio: "pipe" });
    expect(rebuilt.resetReason).toBe("stale-tsbuildinfo");
    expect(existsSync(join(dir, "dist/index.js"))).toBe(true);
    expect(existsSync(join(dir, "dist/extra.js"))).toBe(true);
  });

  it("cleans orphan dist files and rebuilds cleanly when a source file is removed", () => {
    const dir = createTempPackage();
    buildPackageIncremental(dir, { stdio: "pipe" });
    expect(existsSync(join(dir, "dist/extra.js"))).toBe(true);

    rmSync(join(dir, "src/extra.ts"));
    writeFileSync(join(dir, "src/index.ts"), "export const answer = 42;\n");
    expect(hasOrphanDistFiles(dir)).toBe(true);

    const rebuilt = buildPackageIncremental(dir, { stdio: "pipe" });
    expect(rebuilt.resetReason).toBe("orphan-dist");
    expect(existsSync(join(dir, "dist/index.js"))).toBe(true);
    expect(existsSync(join(dir, "dist/extra.js"))).toBe(false);
    expect(existsSync(join(dir, "dist/extra.d.ts"))).toBe(false);
    expect(hasOrphanDistFiles(dir)).toBe(false);
  });

  it("treats JSON files emitted alongside src JSON as valid non-orphans", () => {
    const dir = createTempPackage();
    writeFileSync(join(dir, "src/data.json"), '{"v":1}\n');
    writeFileSync(join(dir, "src/index.ts"), 'import data from "./data.json" with { type: "json" };\nexport const v = data.v;\n');
    rmSync(join(dir, "src/extra.ts"));

    buildPackageIncremental(dir, { stdio: "pipe" });
    expect(existsSync(join(dir, "dist/data.json"))).toBe(true);
    expect(hasOrphanDistFiles(dir)).toBe(false);
  });
});
