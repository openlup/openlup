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
    '{"kind":"kernel","packageSurface":{"./subscription":{"role":"kernel","maturity":"candidate","packageSmokeEvidence":["docs/guide.md"]}}}\n',
  );
  mkdirSync(join(root, "smoke"));
  writeFileSync(join(root, "smoke", "agentsWiringExample.ts"), wiringExample);
  writeFileSync(join(root, "AGENTS.md"), agentGuide());
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- A change.\n");
  writeFileSync(join(root, ".gitignore"), "/coverage/\n/dist/\n/node_modules/\n/release/\n");
  writeFileSync(join(root, "README.md"), `${readme}\n${surfaceTable()}`);
  writeFileSync(join(root, "MAINTAINERS.md"), "# Maintainers\n");
  writeFileSync(join(root, "docs", "SPLIT_AND_UPGRADE.md"), "# Split and Upgrade\n");
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
  return root;
}

const wiringExample = 'import { kernel } from "@scope/package";\n\nexport const wired = kernel;\n';

function agentGuide(overrides: { kind?: string; row?: string; example?: string } = {}): string {
  return [
    "# Agent guide",
    "",
    "## Purpose and kind",
    "",
    `Kind: \`${overrides.kind ?? "kernel"}\`.`,
    "",
    "## Subpath maturity",
    "",
    "| Export | Role | Maturity |",
    "| --- | --- | --- |",
    overrides.row ?? "| `./subscription` | kernel | candidate |",
    "",
    "## Wiring example",
    "",
    "```ts",
    `${overrides.example ?? wiringExample}\`\`\``,
    "",
    "## Sources and declarations",
    "",
    "Sources ship under `src/`.",
    "",
    "## Readiness codes",
    "",
    "None.",
    "",
    "## Using this package in an application",
    "",
    "Do not edit the installed package.",
    "",
  ].join("\n");
}

// The fixture's packed file list stands in for `npm pack --dry-run`.
function check(root: string, packed = ["AGENTS.md", "README.md", "package.json", "docs/guide.md"]): void {
  assertDocumentationContract(root, () => packed);
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
    expect(() => check(root)).not.toThrow();
  });

  it("refuses a shipped link to documentation present in source but absent from the tarball", () => {
    const root = fixture("[Guide](docs/guide.md#setup)\n");
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md#setup targets a file missing from npm pack",
    );
  });

  it.each(['"Guide title"', "'Guide title'", "(Guide title)"])("checks packed inline links with the title %s", (title) => {
    const root = fixture(`[Guide](docs/guide.md ${title})\n[Website](https://example.invalid/guide ${title})\n[Section](#setup ${title})\n`);
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md targets a file missing from npm pack",
    );
    expect(() => check(root)).not.toThrow();
  });

  it.each([0, 1, 2, 3])("checks packed reference links with %s spaces before the definition", (indent) => {
    const spaces = " ".repeat(indent);
    const root = fixture(`[Guide][target]\n[Website][url]\n[Section][anchor]\n\n${spaces}[target]: docs/guide.md\n${spaces}[url]: https://example.invalid/guide\n${spaces}[anchor]: #setup\n`);
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md targets a file missing from npm pack",
    );
    expect(() => check(root)).not.toThrow();
  });

  it.each(["docs/guide(extra).md", "docs/guide(extra(details)).md"])("preserves the balanced-parentheses destination %s", (target) => {
    const root = fixture(`[Guide](${target})\n`);
    writeFileSync(join(root, target), "# Guide\n");
    const packed = ["AGENTS.md", "README.md", "package.json"];
    expect(() => check(root, packed)).toThrow(
      `README.md: local link ${target} targets a file missing from npm pack`,
    );
    expect(() => check(root, [...packed, target])).not.toThrow();
  });

  it("resolves escaped parentheses without treating them as destination nesting", () => {
    const target = "docs/guide(extra.md";
    const root = fixture("[Guide](docs/guide\\(extra.md 'Guide')\n");
    writeFileSync(join(root, target), "# Guide\n");
    const packed = ["AGENTS.md", "README.md", "package.json"];
    expect(() => check(root, packed)).toThrow(`README.md: local link docs/guide\\(extra.md targets a file missing from npm pack`);
    expect(() => check(root, [...packed, target])).not.toThrow();
  });

  it("checks nested shipped Markdown and resolves reference links relative to that file", () => {
    const root = fixture("[Guide](docs/guide.md)\n");
    writeFileSync(join(root, "docs", "guide.md"), "[Back][readme]\n\n[readme]: ../README.md#package-surface-maturity\n\n[Upgrade](SPLIT_AND_UPGRADE.md)\n");
    expect(() => check(root)).toThrow(
      "docs/guide.md: local link SPLIT_AND_UPGRADE.md targets a file missing from npm pack",
    );
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json", "docs/guide.md", "docs/SPLIT_AND_UPGRADE.md"])).not.toThrow();
  });

  it("accepts external URLs, anchors and encoded packed paths without requiring their targets in source", () => {
    const root = fixture("[Website](https://example.invalid/guide)\n[CDN](//example.invalid/guide)\n[Email](mailto:maintainer@example.invalid)\n[Section](#setup)\n[Guide](docs/a%20guide.md?view=full#setup)\n");
    writeFileSync(join(root, "docs", "a guide.md"), "# Guide\n");
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json", "docs/a guide.md"])).not.toThrow();
  });

  it("rejects dangling links, unknown commands, and monorepo paths", () => {
    const root = fixture("[Missing](docs/missing.md)\n\nnpm run ghost\n\npackages/core\n");
    expect(() => check(root)).toThrow(
      /monorepo package path[\s\S]*dangling local link[\s\S]*unknown npm script/,
    );
  });

  it("rejects a stale command even inside historical evidence", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(
      join(root, "docs", "REPOSITORY_BOOTSTRAP.md"),
      "# Historical evidence\n\nnpm run release:policy-snapshot\n",
    );
    expect(() => check(root)).toThrow(
      /docs\/REPOSITORY_BOOTSTRAP\.md: unknown npm script release:policy-snapshot/,
    );
  });

  it("rejects links outside the package and inline downstream commands", () => {
    const downstreamCommand = "veli";
    const root = fixture(`[Outside](..)\n\nDo not run \`./${downstreamCommand} verify\`.\n`);
    expect(() => check(root)).toThrow(
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

    expect(() => check(root)).toThrow(
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

    expect(() => check(root)).toThrow(`${path}: ${violation}`);
  });

  it("allows an explicit negation of a retired contribution claim", () => {
    const root = fixture("# Fixture\n");
    const target = join(root, ".github", "pull_request_template.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "This is not a stable API change.\n");

    expect(() => check(root)).not.toThrow();
  });

  it("rejects an extracted root that exposes generated release state", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, ".gitignore"), "/dist/\n/node_modules/\n");

    expect(() => check(root)).toThrow(
      /.gitignore: expected exactly \/coverage\/, \/dist\/, \/node_modules\/, \/release\//,
    );
  });

  it("rejects overbroad or negated extracted-root ignore rules", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(
      join(root, ".gitignore"),
      "/coverage/\n/dist/\n/node_modules/\n/release/\n*\n!/src/\n",
    );

    expect(() => check(root)).toThrow(
      /received \/coverage\/, \/dist\/, \/node_modules\/, \/release\/, \*, !\/src\//,
    );
  });

  it("refuses a tarball without AGENTS.md", () => {
    const root = fixture("# Fixture\n");
    expect(() => check(root, ["README.md", "package.json"])).toThrow(
      "npm pack: tarball is missing AGENTS.md",
    );
  });

  it("refuses a package without a kind", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(
      join(root, "release-gates.json"),
      '{"packageSurface":{"./subscription":{"role":"kernel","maturity":"candidate","packageSmokeEvidence":["docs/guide.md"]}}}\n',
    );
    expect(() => check(root)).toThrow(
      "release-gates.json: package kind must be one of kernel, rail, capability, implementation",
    );
  });

  it("refuses a package without an agent guide", () => {
    const root = fixture("# Fixture\n");
    rmSync(join(root, "AGENTS.md"));
    expect(() => check(root)).toThrow("AGENTS.md: missing agent guide");
  });

  it("refuses an agent guide whose kind differs from the release gates", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, "AGENTS.md"), agentGuide({ kind: "rail" }));
    expect(() => check(root)).toThrow("AGENTS.md: kind differs from release gates");
  });

  it("refuses an agent guide without a required section", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, "AGENTS.md"), agentGuide().replace("## Readiness codes", "## Codes"));
    expect(() => check(root)).toThrow("AGENTS.md: missing Readiness codes section");
  });

  it("refuses an agent guide without the application-use section", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, "AGENTS.md"), agentGuide().replace("## Using this package in an application", "## Usage"));
    expect(() => check(root)).toThrow("AGENTS.md: missing Using this package in an application section");
  });

  it("refuses an agent guide whose maturity row differs from the release gates", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, "AGENTS.md"), agentGuide({ row: "| `./subscription` | kernel | experimental |" }));
    expect(() => check(root)).toThrow("AGENTS.md: maturity row differs from release gates for ./subscription");
  });

  it("refuses a wiring example that differs from the type-checked source", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, "AGENTS.md"), agentGuide({ example: wiringExample.replace("wired", "unwired") }));
    expect(() => check(root)).toThrow(
      "AGENTS.md: wiring example differs from smoke/agentsWiringExample.ts",
    );
  });

  it("refuses a changelog with two Unreleased sections", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased — one topic\n\n- A.\n\n## [Unreleased]\n\n- B.\n",
    );
    expect(() => check(root)).toThrow("CHANGELOG.md: 2 Unreleased sections; keep one");
  });
});
