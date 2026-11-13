import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { agentsFileCap, assertDocumentationContract, assertPackageDocumentation } from "../scripts/documentation-contract.ts";

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
  writeFileSync(join(root, "smoke", "readmeExample.ts"), readmeExample);
  writeFileSync(join(root, "AGENTS.md"), agentGuide());
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- A change.\n");
  writeFileSync(join(root, ".gitignore"), "/coverage/\n/dist/\n/node_modules/\n/release/\n");
  writeFileSync(join(root, "README.md"), `\`\`\`ts\n${readmeExample}\`\`\`\n\n${readme}\n${surfaceTable()}`);
  writeFileSync(join(root, "MAINTAINERS.md"), "# Maintainers\n");
  writeFileSync(join(root, "docs", "SPLIT_AND_UPGRADE.md"), "# Split and Upgrade\n");
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
  return root;
}

const wiringExample = 'import { kernel } from "@scope/package";\n\nexport const wired = kernel;\n';
const readmeExample = 'import { kernel } from "@scope/package";\n';

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

  it.each(["Guide [subscription]", "Guide \\] subscription", "Guide [nested [label]]"])("checks packed destinations with the inline label %s", (label) => {
    const root = fixture(`[${label}](docs/guide.md)\n[${label}](https://example.invalid/guide)\n[${label}](#setup)\n`);
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md targets a file missing from npm pack",
    );
    expect(() => check(root)).not.toThrow();
  });

  it.each(["> ", "- ", "1. ", "> - ", "- Parent\n\n    "])("checks packed reference destinations in the container %s", (prefix) => {
    const root = fixture(`[Guide][target]\n[Website][url]\n[Section][anchor]\n\n${prefix}[target]: docs/guide.md\n${prefix}[url]: https://example.invalid/guide\n${prefix}[anchor]: #setup\n`);
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md targets a file missing from npm pack",
    );
    expect(() => check(root)).not.toThrow();
  });

  it("checks packed reference destinations with an escaped bracket in the label", () => {
    const root = fixture("[Guide][tar\\]get]\n\n> [tar\\]get]: docs/guide.md\n");
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md targets a file missing from npm pack",
    );
    expect(() => check(root)).not.toThrow();
  });

  it.each(["```", "~~~"])("does not read index signatures as link definitions inside %s fences", (fence) => {
    const root = fixture(`${fence}ts nocheck\n// A declaration excerpt; MissingType is not declared.\nexport type Data = {\n    [key: string]: MissingType;\n};\n${fence}\n[Guide][target]\n\n> [target]: docs/guide.md\n`);
    expect(() => check(root)).not.toThrow();
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow(
      "README.md: local link docs/guide.md targets a file missing from npm pack",
    );
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

  it.each([
    "<docs/guide\\>extra.md>",
    "docs/guide.md\u00a0'Title'",
    "docs/guide&#46;md",
    "docs/guide&period;md",
  ])("explicitly refuses the ambiguous destination %s even with a packed decoy", (destination) => {
    const root = fixture(`[Guide](${destination})\n[Guide][ref]\n\n> [ref]: ${destination}\n`);
    writeFileSync(join(root, "docs", "guide>extra.md"), "# Guide\n");
    writeFileSync(join(root, "docs", "guide&"), "# Decoy\n");
    const packed = ["AGENTS.md", "README.md", "package.json", "docs/guide.md", "docs/guide&"];
    expect(() => check(root, packed)).toThrow("unsupported local link destination");
  });

  it.each(["docs/guide.md", "<docs/guide.md>"])("checks inline and reference targets before optional titles for %s", (destination) => {
    const root = fixture(`[Guide](${destination} 'Title')\n[Guide][ref]\n\n[ref]: ${destination} "Title"\n`);
    expect(() => check(root)).not.toThrow();
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json"])).toThrow("targets a file missing from npm pack");
  });

  it.each(["<docs/guide.md", "docs/guide(unbalanced.md"])("explicitly refuses an unsupported destination boundary %s", (destination) => {
    const root = fixture(`[Guide](${destination} 'Title')\n`);
    expect(() => check(root)).toThrow("unsupported Markdown link destination boundary");
  });

  it("resolves encoded reserved filename characters before checking the packed inventory", () => {
    const root = fixture("[Guide](docs/a%23b%26c%3Ed.md#section)\n[Guide][ref]\n\n[ref]: docs/a%23b%26c%3Ed.md\n");
    const target = "docs/a#b&c>d.md";
    writeFileSync(join(root, target), "# Guide\n");
    expect(() => check(root)).toThrow("targets a file missing from npm pack");
    expect(() => check(root, ["AGENTS.md", "README.md", "package.json", target])).not.toThrow();
  });

  it("reports malformed local percent encoding as an actionable contract violation", () => {
    const root = fixture("[Guide](docs/guide%ZZ.md)\n");
    expect(() => check(root)).toThrow("malformed percent encoding in local link");
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

  it("refuses a README example that differs from the type-checked source", () => {
    const root = fixture("# Fixture\n");
    writeFileSync(join(root, "smoke", "readmeExample.ts"), readmeExample.replace("kernel", "other"));
    expect(() => check(root)).toThrow("README.md: first TypeScript example differs from smoke/readmeExample.ts");
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

// The reader guide: a package fixture inside a repository fixture, so links and regions resolve.
const tag = "openlup-core-v1.2.3";
const repositoryLink = (path: string, ref = tag) => `https://github.com/openlup/openlup/blob/${ref}/${path}`;
const surface = '{"kind":"rail","packageSurface":{".":{"role":"rail","maturity":"experimental"}}}\n';

function guideFixture(index: string, pages: Record<string, string> = {}) {
  const repository = mkdtempSync(join(tmpdir(), "core-guide-contract-"));
  roots.push(repository);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), contents);
  };
  write("README.md", "# Repository\n");
  write("AGENTS.md", "# Agents\n");
  write("config/documentation-guide-allowlist.json", '{"schemaVersion":1,"terms":["S3"]}\n');
  write("config/environment-variables.json", JSON.stringify({ schemaVersion: 1, variables: [
    { name: "APP_BASE_URL", owner: "platform", category: "server-runtime", requiredIn: ["production"], secret: false },
    { name: "SESSION_KEY", owner: "platform", category: "server-runtime", requiredIn: [], secret: true },
  ] }));
  for (const name of ["outbox", "platform"]) write(`packages/${name}/release-gates.json`, surface);
  const packageRoot = fixture("# Fixture\n");
  const core = join(repository, "packages", "core");
  // Copy the package fixture into the repository fixture.
  mkdirSync(core, { recursive: true });
  for (const entry of ["package.json", "release-gates.json", "smoke", "AGENTS.md", "CHANGELOG.md", ".gitignore", "README.md", "MAINTAINERS.md", "docs"]) {
    cpSync(join(packageRoot, entry), join(core, entry), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
  writeFileSync(join(core, "package.json"), JSON.stringify({ ...manifest, version: "1.2.3" }));
  write("packages/core/docs/guide/README.md", index);
  for (const [path, contents] of Object.entries(pages)) write(`packages/core/docs/guide/${path}`, contents);
  return { repository, core };
}

const cpDir = (from: string, to: string) => cpSync(from, to, { recursive: true });

function checkGuide(fixtureRoots: { repository: string; core: string }, write = false): void {
  assertDocumentationContract(fixtureRoots.core, () => ["AGENTS.md", "README.md", "package.json", "docs/guide.md"], { repositoryRoot: fixtureRoots.repository, write });
}

const coreRegion = (body: string) => `<!-- generated:maturity:outbox -->\n${body}<!-- /generated:maturity:outbox -->\n`;
const freshMaturity = "| Export | Role | Maturity |\n| --- | --- | --- |\n| `.` | rail | experimental |\n";

describe("reader guide contract", { timeout: 60_000 }, () => {
  it("accepts relative links, pinned repository links, fresh regions, allowed terms and compiled fences", () => {
    const roots = guideFixture(
      `# Guide\n\n[Start](start/tutorial.md) and [the README](${repositoryLink("README.md")}) store files in S3.\n\n${coreRegion(freshMaturity)}\n\`\`\`ts\nconst total: number = 1 + 1;\nexport const doubled = total * 2;\n\`\`\`\n`,
      { "start/tutorial.md": "# Tutorial\n\n[Back](../README.md)\n" },
    );
    expect(() => checkGuide(roots)).not.toThrow();
  });

  it("refuses a relative link that leaves the guide", () => {
    const roots = guideFixture("# Guide\n\n[Changelog](../../CHANGELOG.md)\n");
    expect(() => checkGuide(roots)).toThrow(`docs/guide/README.md: link ../../CHANGELOG.md leaves the guide; use https://github.com/openlup/openlup/blob/${tag}/<path>`);
  });

  it("refuses a repository link off the release tag, and --write pins it", () => {
    const roots = guideFixture(`# Guide\n\n[README](${repositoryLink("README.md", "openlup-core-v1.0.0")})\n`);
    expect(() => checkGuide(roots)).toThrow("must pin openlup-core-v1.2.3");
    expect(() => checkGuide(roots, true)).not.toThrow();
    expect(readFileSync(join(roots.core, "docs/guide/README.md"), "utf8")).toContain(repositoryLink("README.md"));
  });

  it("refuses a repository link at a branch", () => {
    const roots = guideFixture(`# Guide\n\n[README](${repositoryLink("README.md", "main")})\n`);
    expect(() => checkGuide(roots)).toThrow("must pin openlup-core-v1.2.3");
    expect(() => checkGuide(roots, true)).toThrow("must pin openlup-core-v1.2.3");
  });

  it("refuses a repository link to a missing path or back into the guide", () => {
    const missing = guideFixture(`# Guide\n\n[Gone](${repositoryLink("docs/missing.md")})\n`);
    expect(() => checkGuide(missing)).toThrow("targets a path missing from the repository");
    const inward = guideFixture(`# Guide\n\n[Self](${repositoryLink("packages/core/docs/guide/README.md")})\n`);
    expect(() => checkGuide(inward)).toThrow("points into the guide; use a relative link");
  });

  it("refuses a stale generated region and --write regenerates it from release gates", () => {
    const roots = guideFixture(`# Guide\n\n${coreRegion("| Export | Role | Maturity |\n| --- | --- | --- |\n| `.` | rail | stable |\n")}`);
    expect(() => checkGuide(roots)).toThrow("generated region maturity:outbox is stale");
    expect(() => checkGuide(roots, true)).not.toThrow();
    expect(readFileSync(join(roots.core, "docs/guide/README.md"), "utf8")).toContain(coreRegion(freshMaturity));
  });

  it("generates configuration keys from the environment-variable catalogue", () => {
    const roots = guideFixture("# Guide\n\n<!-- generated:configuration-keys -->\n<!-- /generated:configuration-keys -->\n");
    expect(() => checkGuide(roots)).toThrow("generated region configuration-keys is stale");
    checkGuide(roots, true);
    expect(readFileSync(join(roots.core, "docs/guide/README.md"), "utf8")).toContain(
      "| `APP_BASE_URL` | platform | server-runtime | production | no |\n| `SESSION_KEY` | platform | server-runtime | none | yes |\n",
    );
  });

  it.each([
    ["<!-- generated:exports-count -->\n<!-- /generated:exports-count -->\n", "unknown generated region exports-count"],
    ["<!-- generated:maturity:ui -->\n<!-- /generated:maturity:ui -->\n", "unknown generated region maturity:ui"],
    ["<!-- generated:configuration-keys -->\nno end marker\n", "a generated region is not closed"],
  ])("refuses the malformed region %#", (region, message) => {
    expect(() => checkGuide(guideFixture(`# Guide\n\n${region}`))).toThrow(message);
  });

  it.each([
    ["Delivered in M19 with G18.", "task or milestone ID): M19, G18"],
    ["See oss-m19-g18 for the reasons.", "plan name): oss-m19-g18"],
    ["The proof is in tests/postgres/ today.", "path into tests, plans or agent scratch): tests/"],
    ["Wait for the merge queue and install-proof.", "CI or delivery-process vocabulary): merge queue, install-proof"],
    ["Open /Users/someone/store first.", "absolute filesystem path): /Users/someone"],
  ])("refuses repository-internal language: %s", (line, message) => {
    expect(() => checkGuide(guideFixture(`# Guide\n\n${line}\n`))).toThrow(`docs/guide/README.md: repository-internal language (${message}`);
  });

  it("refuses a guide without its allow-list or outside a repository", () => {
    const roots = guideFixture("# Guide\n");
    rmSync(join(roots.repository, "config/documentation-guide-allowlist.json"));
    expect(() => checkGuide(roots)).toThrow("missing reader-language allow-list");
    expect(() => assertDocumentationContract(roots.core, () => ["AGENTS.md", "README.md", "package.json"], {})).toThrow("no repository root was found");
  });

  it("refuses a TypeScript fence that does not compile and a nocheck fence without a reason", () => {
    const broken = guideFixture("# Guide\n\n```ts\nconst total: number = \"two\";\n```\n");
    expect(() => checkGuide(broken)).toThrow(/docs\/guide\/README\.md:4: TypeScript fence does not compile: Type 'string' is not assignable to type 'number'/);
    const unexplained = guideFixture("# Guide\n\n```ts nocheck\nconst total: number = \"two\";\n```\n");
    expect(() => checkGuide(unexplained)).toThrow("docs/guide/README.md:4: a ts nocheck fence must open with a // reason line");
    const explained = guideFixture("# Guide\n\n```ts nocheck\n// Fragment: the host supplies the total.\nconst total: number = \"two\";\n```\n");
    expect(() => checkGuide(explained)).not.toThrow();
  });

  it("refuses a README fence that does not compile, beyond the smoke example", () => {
    const roots = guideFixture("# Guide\n");
    const readme = readFileSync(join(roots.core, "README.md"), "utf8");
    writeFileSync(join(roots.core, "README.md"), `${readme}\n\`\`\`ts\nundeclaredName();\n\`\`\`\n`);
    expect(() => checkGuide(roots)).toThrow("README.md:");
    expect(() => checkGuide(roots)).toThrow("Cannot find name 'undeclaredName'");
  });

  it("caps package and repository AGENTS.md by lines and bytes", () => {
    const roots = guideFixture("# Guide\n");
    const guide = readFileSync(join(roots.core, "AGENTS.md"), "utf8");
    writeFileSync(join(roots.core, "AGENTS.md"), guide + "line\n".repeat(agentsFileCap.lines));
    expect(() => checkGuide(roots)).toThrow(/AGENTS\.md: \d+ lines and \d+ bytes exceed the cap of 200 lines and 10240 bytes/);
    writeFileSync(join(roots.core, "AGENTS.md"), guide);
    writeFileSync(join(roots.repository, "AGENTS.md"), `# Agents\n\n${"x".repeat(agentsFileCap.bytes)}\n`);
    expect(() => checkGuide(roots)).toThrow("repository AGENTS.md: 3 lines");
  });

  it("checks another package's guide, size and fences without a separate example file", () => {
    const roots = guideFixture("# Guide\n");
    const outbox = join(roots.repository, "packages", "outbox");
    for (const file of ["AGENTS.md", "README.md", "package.json"]) cpDir(join(roots.core, file), join(outbox, file));
    writeFileSync(join(outbox, "release-gates.json"), '{"kind":"kernel","packageSurface":{"./subscription":{"role":"kernel","maturity":"candidate"}}}\n');
    const packed = () => ["AGENTS.md", "README.md", "package.json"];
    // The fixture's example imports a placeholder package, so without an example file it must compile and fails.
    expect(() => assertPackageDocumentation(outbox, null, packed)).toThrow("Cannot find module '@scope/package'");
    mkdirSync(join(outbox, "smoke"));
    cpDir(join(roots.core, "smoke/agentsWiringExample.ts"), join(outbox, "smoke/agentsWiringExample.ts"));
    cpDir(join(roots.core, "smoke/readmeExample.ts"), join(outbox, "smoke/readmeExample.ts"));
    expect(() => assertPackageDocumentation(outbox, "smoke/agentsWiringExample.ts", packed)).toThrow("README.md:2: TypeScript fence does not compile");
  });

  it("refuses an agent guide whose wiring example has no ts fence when no example file backs it", () => {
    const roots = guideFixture("# Guide\n");
    const outbox = join(roots.repository, "packages", "outbox");
    cpDir(join(roots.core, "package.json"), join(outbox, "package.json"));
    writeFileSync(join(outbox, "release-gates.json"), '{"kind":"kernel","packageSurface":{"./subscription":{"role":"kernel","maturity":"candidate"}}}\n');
    writeFileSync(join(outbox, "AGENTS.md"), readFileSync(join(roots.core, "AGENTS.md"), "utf8").replace(/```ts\n[\s\S]*?```\n/, "Wire the kernel.\n"));
    expect(() => assertPackageDocumentation(outbox, null, () => ["AGENTS.md", "package.json"])).toThrow("AGENTS.md: wiring example has no ts fence");
  });
});
