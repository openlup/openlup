import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { assertDocumentationContract } from "../scripts/documentation-contract.ts";

const roots: string[] = [];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(readme: string): string {
  const root = mkdtempSync(join(tmpdir(), "core-doc-contract-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(
    join(root, "package.json"),
    [
      '{',
      '  "scripts": { "ci": "echo ok" },',
      '  "exports": { "./subscription": {} }',
      '}\n',
    ].join("\n"),
  );
  writeFileSync(
    join(root, "release-gates.json"),
    '{"packageSurface":{"./subscription":{"role":"kernel","maturity":"candidate","packageSmokeEvidence":["docs/guide.md"]}}}\n',
  );
  writeFileSync(join(root, ".gitignore"), "/coverage/\n/dist/\n/node_modules/\n/release/\n");
  writeFileSync(join(root, "README.md"), `${readme}\n${surfaceTable()}`);
  writeFileSync(join(root, "MAINTAINERS.md"), "# Maintainers\n");
  writeFileSync(join(root, "docs", "SPLIT_AND_UPGRADE.md"), "# Split and Upgrade\n");
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
  return root;
}

function surfaceTable(): string {
  return [
    "## Package Surface Maturity",
    "",
    "| Export | Role | Maturity | Package smoke |",
    "| --- | --- | --- | --- |",
    "| `./subscription` | kernel | candidate | `docs/guide.md` |",
    "",
  ].join("\n");
}

describe("extracted-root documentation contract", () => {
  it("accepts the current package surface from release-gates.json", () => {
    expect(() => assertDocumentationContract(packageRoot)).not.toThrow();
  });

  it("keeps downstream documentation identifiers readable in the production contract", () => {
    const source = readFileSync(join(packageRoot, "scripts", "documentation-contract.ts"), "utf8");

    expect(source).toContain('const downstreamRepositoryCommand = "veli";');
    expect(source).toContain('const retiredPackageScope = "veli";');
  });

  it("accepts package-local links and declared commands", () => {
    const root = fixture("[Guide](docs/guide.md)\n\n```sh\nnpm run ci\n```\n");
    expect(() => assertDocumentationContract(root)).not.toThrow();
  });

  it("rejects dangling links, unknown commands, and monorepo paths", () => {
    const root = fixture("[Missing](docs/missing.md)\n\nnpm run ghost\n\npackages/core\n");
    expect(() => assertDocumentationContract(root)).toThrow(
      /monorepo package path[\s\S]*dangling local link[\s\S]*unknown npm script/,
    );
  });

  it("rejects a stale command even inside historical evidence", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(
      join(root, "docs", "REPOSITORY_BOOTSTRAP.md"),
      "# Historical evidence\n\nnpm run release:policy-snapshot\n",
    );
    expect(() => assertDocumentationContract(root)).toThrow(
      /docs\/REPOSITORY_BOOTSTRAP\.md: unknown npm script release:policy-snapshot/,
    );
  });

  it("rejects links outside the package and inline downstream commands", () => {
    const downstreamCommand = "veli";
    const root = fixture(`[Outside](..)\n\nDo not run \`./${downstreamCommand} verify\`.\n`);
    expect(() => assertDocumentationContract(root)).toThrow(
      /downstream repository command[\s\S]*local link escapes package/,
    );
  });

  it("rejects stale downstream product references", () => {
    const root = fixture("Velipet downstream notes\n");
    const retiredPackageScope = "veli";
    mkdirSync(join(root, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(
      join(root, ".github", "ISSUE_TEMPLATE", "bug_report.yml"),
      `example: @${retiredPackageScope}-commerce/core/pricing\n`,
    );
    writeFileSync(
      join(root, "package.json"),
      '{"scripts":{"ci":"echo ok"},"exports":{"./subscription":{}}}\n',
    );

    expect(() => assertDocumentationContract(root)).toThrow(
      /downstream product reference[\s\S]*retired package identity/,
    );
  });

  it.each([
    [".github/pull_request_template.md", "Stable API changes require review.", "retired stable API claim"],
    [".github/ISSUE_TEMPLATE/bug_report.yml", "description: public package subpath", "retired public package-subpath claim"],
    [".github/pull_request_template.md", "Surface: stable headline", "retired stable headline claim"],
    [".github/ISSUE_TEMPLATE/feature_request.yml", "label: Adopter evidence", "retired adopter-evidence claim"],
  ])("rejects retired package-contribution language in %s", (path, source, violation) => {
    const root = fixture("# Fixture\n");
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);

    expect(() => assertDocumentationContract(root)).toThrow(`${path}: ${violation}`);
  });

  it("allows an explicit negation of a retired contribution claim", () => {
    const root = fixture("# Fixture\n");
    const target = join(root, ".github", "pull_request_template.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "This is not a stable API change.\n");

    expect(() => assertDocumentationContract(root)).not.toThrow();
  });

  it("rejects an extracted root that exposes generated release state", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, ".gitignore"), "/dist/\n/node_modules/\n");

    expect(() => assertDocumentationContract(root)).toThrow(
      /.gitignore: expected exactly \/coverage\/, \/dist\/, \/node_modules\/, \/release\//,
    );
  });

  it("rejects overbroad or negated extracted-root ignore rules", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(
      join(root, ".gitignore"),
      "/coverage/\n/dist/\n/node_modules/\n/release/\n*\n!/src/\n",
    );

    expect(() => assertDocumentationContract(root)).toThrow(
      /received \/coverage\/, \/dist\/, \/node_modules\/, \/release\/, \*, !\/src\//,
    );
  });
});
