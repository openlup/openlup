import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { agentsFileCap, assertCompiledFences, assertDocumentationContract, assertGuideContract, assertPackageDocumentation, assertRefusalCodeReachability, listOpenRefusalTypes, providerSpecificKeys, refusalTypeSuffixes, renderGeneratedRegion, syncGeneratedRegions } from "../scripts/documentation-contract.ts";

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
  }, 30_000);

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
    [".github/ISSUE_TEMPLATE/documentation_problem.yml", "description: public package subpath", "retired public package-subpath claim"],
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
  write("config/openlup-packages.json", "{}\n");
  write("README.md", "# Repository\n");
  write("AGENTS.md", "# Agents\n");
  write("config/documentation-guide-allowlist.json", '{"schemaVersion":1,"terms":["S3"]}\n');
  write("config/environment-variables.json", JSON.stringify({ schemaVersion: 1, variables: [
    { name: "APP_BASE_URL", owner: "platform", category: "server-runtime", requiredIn: ["production"], secret: false },
    { name: "SESSION_KEY", owner: "platform", category: "server-runtime", requiredIn: [], secret: true },
  ] }));
  write("packages/platform/src/config.ts", "APP_BASE_URL SESSION_KEY\n");
  mkdirSync(join(repository, "packages/platform/api"), { recursive: true });
  write("packages/ui/smoke/neutrality.ts", readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../ui/smoke/neutrality.ts"), "utf8"));
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
  it("plans pending absolute and package-relative pages through the CLI without writing", () => {
    const roots = guideFixture(`# Guide\n\n[README](${repositoryLink("README.md", "openlup-core-v1.0.0")})\n`);
    const file = join(roots.core, "docs/guide/upgrade/v1-2-3.md");
    const pending = `# Upgrading to 1.2.3\n\n[README](${repositoryLink("README.md", "openlup-core-v1.0.0")})\n\n${coreRegion("old body\n")}`;
    const original = readFileSync(join(roots.core, "docs/guide/README.md"), "utf8");
    const run = (files: Record<string, string>) => spawnSync(process.execPath, ["--experimental-strip-types", join(packageRoot, "scripts/documentation-contract.ts"), "--plan-guide", "1.2.3", roots.repository], { cwd: roots.repository, input: JSON.stringify(files), encoding: "utf8" });
    const absolute = run({ [file]: pending }), relative = run({ "docs/guide/upgrade/v1-2-3.md": pending });
    expect(absolute.status, absolute.stderr).toBe(0); expect(relative.status, relative.stderr).toBe(0);
    const planned = JSON.parse(absolute.stdout);
    expect(JSON.parse(relative.stdout)).toEqual(planned);
    expect(planned.violations).toEqual([]); expect(planned.pageViolations).toEqual({ [file]: [] });
    const updates = new Map<string, string>(planned.writes);
    expect(updates.get(file)).toContain(repositoryLink("README.md"));
    expect(updates.get(file)).toContain(coreRegion(freshMaturity));
    expect(readFileSync(join(roots.core, "docs/guide/README.md"), "utf8")).toBe(original);
    expect(() => readFileSync(file)).toThrow(/ENOENT/);
    for (const [path, source] of updates) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); }
    expect(() => checkGuide(roots)).not.toThrow();
    const current = run({ [file]: updates.get(file)! });
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout)).toEqual({ writes: [], violations: [], pageViolations: { [file]: [] } });
  });

  it("reports pending-page reader and link violations as JSON, and refuses invalid pending input", () => {
    const roots = guideFixture("# Guide\n"), file = join(roots.core, "docs/guide/upgrade/v1-2-3.md");
    const run = (input: unknown) => spawnSync(process.execPath, ["--experimental-strip-types", join(packageRoot, "scripts/documentation-contract.ts"), "--plan-guide", "1.2.3", roots.repository], { cwd: roots.repository, input: JSON.stringify(input), encoding: "utf8" });
    const result = run({ [file]: "# Upgrade\n\nM19 [Changelog](../../../CHANGELOG.md)\n" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ writes: [], violations: [], pageViolations: { [file]: [expect.stringContaining("task or milestone ID): M19"), expect.stringContaining("leaves the guide")] } });
    for (const input of [[], { "../../outside.md": "# Outside\n" }, { [file]: 1 }]) {
      const refused = run(input); expect(refused.status).not.toBe(0); expect(refused.stdout).toBe("");
    }
    expect(() => readFileSync(file)).toThrow(/ENOENT/);
  });

  it("accepts relative links, pinned repository links, fresh regions, allowed terms and compiled fences", () => {
    const roots = guideFixture(
      `# Guide\n\n[Start](start/tutorial.md) and [the README](${repositoryLink("README.md")}) store files in S3.\n\n${coreRegion(freshMaturity)}\n\`\`\`ts\nconst total: number = 1 + 1;\nexport const doubled = total * 2;\n\`\`\`\n`,
      { "start/tutorial.md": "# Tutorial\n\n[Back](../README.md)\n" },
    );
    expect(() => checkGuide(roots)).not.toThrow();
  }, 30_000);

  it.each(["README.md", "AGENTS.md"])("checks and regenerates core's own %s regions", (file) => {
    const roots = guideFixture("# Guide\n");
    const path = join(roots.core, file);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original + "\n## Generated facts\n\n" + coreRegion("stale\n"));
    expect(() => checkGuide(roots)).toThrow(`${file}: generated region maturity:outbox is stale`);
    checkGuide(roots, true);
    expect(readFileSync(path, "utf8")).toBe(original + "\n## Generated facts\n\n" + coreRegion(freshMaturity));
    expect(() => checkGuide(roots)).not.toThrow();
  });

  it.each([false, true])("regenerates package regions through --package with example=%s", (withExample) => {
    const roots = guideFixture("# Guide\n");
    const outbox = join(roots.repository, "packages/outbox");
    for (const file of ["package.json", "release-gates.json", "README.md", "AGENTS.md", "smoke"]) cpDir(join(roots.core, file), join(outbox, file));
    const manifestPath = join(outbox, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), name: "fixture", version: "1.2.3" }));
    // Use valid standalone examples for both the compiler and the optional source witness.
    for (const file of ["README.md", "AGENTS.md", "smoke/agentsWiringExample.ts"]) {
      const path = join(outbox, file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(wiringExample, "export const wired = 1;\n").replaceAll(readmeExample, "export const value = 1;\n"));
    }
    const originals = ["README.md", "AGENTS.md"].map((file) => readFileSync(join(outbox, file), "utf8"));
    for (const [index, file] of ["README.md", "AGENTS.md"].entries()) writeFileSync(join(outbox, file), originals[index] + "\n" + coreRegion("stale\n"));
    const args = ["--experimental-strip-types", join(packageRoot, "scripts/documentation-contract.ts"), "--package", outbox, ...(withExample ? ["smoke/agentsWiringExample.ts"] : [])];
    const run = (extra: string[]) => spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8", timeout: 30_000 });
    const packed = () => ["README.md", "AGENTS.md", "package.json"];
    expect(() => assertPackageDocumentation(outbox, withExample ? "smoke/agentsWiringExample.ts" : null, packed)).toThrow("generated region maturity:outbox is stale");
    const written = run(["--write"]);
    expect(written.status, written.stderr).toBe(0);
    const body = renderGeneratedRegion("maturity:outbox", roots.repository)!;
    for (const [index, file] of ["README.md", "AGENTS.md"].entries()) expect(readFileSync(join(outbox, file), "utf8")).toBe(originals[index] + "\n" + coreRegion(body));
    expect(() => assertPackageDocumentation(outbox, withExample ? "smoke/agentsWiringExample.ts" : null, packed)).not.toThrow();
  }, 60_000);

  it.each([
    ["--package"], ["--package", "--write"], ["--package", ".", "--unknown"],
    ["--package", ".", "--write", "--write"], ["--package", ".", "example.ts", "--unknown"],
    ["--package", ".", "example.ts", "--write", "extra"], ["--unknown"], ["--agent-guide", ".", "--unknown"],
  ])("refuses unknown or malformed command arguments %j", (...args) => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(packageRoot, "scripts/documentation-contract.ts"), ...args], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: documentation-contract.ts");
  });

  it.each([
    `https://raw.githubusercontent.com/openlup/openlup/${tag}/README.md`,
    `http://github.com/openlup/openlup/blob/${tag}/README.md`,
    `https://www.github.com/openlup/openlup/blob/${tag}/README.md`,
    `https://github.com/openlup/openlup/tree/${tag}/README.md`,
    `https://github.com/openlup/openlup/raw/main/README.md`,
    `https://github.com/openlup/openlup/blame/main/README.md`,
    `//github.com/openlup/openlup/blob/main/README.md`,
    `https://github.com/openlup/openlup/commits/main`,
  ])("refuses non-canonical repository URL %s in Markdown and HTML without rewriting it", (url) => {
    for (const link of [`[README](${url})`, `<a href="${url}">README</a>`]) {
      const roots = guideFixture(`# Guide\n\n${link}\n`);
      for (const write of [false, true]) expect(() => checkGuide(roots, write)).toThrow(`use https://github.com/openlup/openlup/blob/${tag}/<path>`);
      expect(readFileSync(join(roots.core, "docs/guide/README.md"), "utf8")).toContain(url);
    }
  });

  it.each([
    ["an HTML decimal reference", '<a href="https://github.com/openlup/openlup&#47;blob/main/README.md">Read</a>'],
    ["an HTML hexadecimal reference", '<a href="https://github.com/openlup/openlup&#x2F;raw/main/README.md">Read</a>'],
    ["a protocol-relative HTML reference", '<a href="&#47;&#47;github.com/openlup/openlup/raw/main/README.md">Read</a>'],
    ["a named reference in Markdown", "[Read](https://github.com/openlup/openlup&sol;blob/main/README.md)"],
  ])("refuses a repository link hidden by %s", (_name, link) => {
    const roots = guideFixture(`# Guide\n\n${link}\n`);
    expect(() => checkGuide(roots)).toThrow(/character reference|non-canonical repository link|must pin/);
  });

  it("admits &amp; in an issue-tracker link", () => {
    const roots = guideFixture('# Guide\n\n<a href="https://github.com/openlup/openlup/issues/new?template=a.yml&amp;labels=docs">Report</a>\n');
    expect(() => checkGuide(roots)).not.toThrow();
  });

  it.each([
    "https://github.com/openlup/openlup",
    "https://github.com/openlup/openlup/issues",
    "https://github.com/openlup/openlup/issues/new?template=documentation_problem.yml",
  ])("admits the repository and its issue tracker %s", (url) => {
    const roots = guideFixture(`# Guide\n\n[Repository](${url})\n`);
    expect(() => checkGuide(roots)).not.toThrow();
  });

  it.each(['"', "'", ""])("checks HTML href local targets and release tags with delimiter %s", (quote) => {
    const link = (target: string) => `<A title="href='../../CHANGELOG.md' > text" HREF=${quote}${target}${quote}>Read</A>`;
    const outside = guideFixture(`# Guide\n${link("../../CHANGELOG.md")}\n`);
    expect(() => checkGuide(outside)).toThrow("leaves the guide");
    const missing = guideFixture(`# Guide\n${link("missing.md")}\n`);
    expect(() => checkGuide(missing)).toThrow("dangling local link missing.md");
    const stale = guideFixture(`# Guide\n${link(repositoryLink("README.md", "openlup-core-v0.1.0"))}\n`);
    expect(() => checkGuide(stale)).toThrow(`must pin ${tag}`);
    checkGuide(stale, true);
    expect(readFileSync(join(stale.core, "docs/guide/README.md"), "utf8")).toContain(link(repositoryLink("README.md")));
    const branch = guideFixture(`# Guide\n${link(repositoryLink("README.md", "main"))}\n`);
    expect(() => checkGuide(branch, true)).toThrow(`must pin ${tag}`);
  });

  it.each(["coordinator", "supervisor", "shard", "worktree", "self-check"])("keeps %s as repository process vocabulary", (word) => {
    expect(() => checkGuide(guideFixture(`# Guide\nAsk the ${word} before continuing.\n`))).toThrow(`CI or delivery-process vocabulary): ${word}`);
  });

  it("matches allow-list terms exactly and case-sensitively", () => {
    const roots = guideFixture("# Guide\nS3 and self-check are named here.\n");
    const path = join(roots.repository, "config/documentation-guide-allowlist.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, terms: ["s3", "self"] }));
    expect(() => checkGuide(roots)).toThrow("task or milestone ID): S3");
    expect(() => checkGuide(roots)).toThrow("CI or delivery-process vocabulary): self-check");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, terms: ["S3", "self-check"] }));
    expect(() => checkGuide(roots)).not.toThrow();
  });

  it.each(["file:///Users/someone/store", "file:///home/someone/store", "C:/Users/someone/store"])("refuses the filesystem path %s", (path) => {
    expect(() => checkGuide(guideFixture(`# Guide\nOpen ${path}.\n`))).toThrow(`absolute filesystem path): ${path.slice(0, path.lastIndexOf("/"))}`);
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
  }, 30_000);

  it("refuses a README fence that does not compile, beyond the smoke example", () => {
    const roots = guideFixture("# Guide\n");
    const readme = readFileSync(join(roots.core, "README.md"), "utf8");
    writeFileSync(join(roots.core, "README.md"), `${readme}\n\`\`\`ts\nundeclaredName();\n\`\`\`\n`);
    expect(() => checkGuide(roots)).toThrow("README.md:");
    expect(() => checkGuide(roots)).toThrow("Cannot find name 'undeclaredName'");
  }, 30_000);

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
  }, 30_000);

  it("refuses an agent guide whose wiring example has no ts fence when no example file backs it", () => {
    const roots = guideFixture("# Guide\n");
    const outbox = join(roots.repository, "packages", "outbox");
    cpDir(join(roots.core, "package.json"), join(outbox, "package.json"));
    writeFileSync(join(outbox, "release-gates.json"), '{"kind":"kernel","packageSurface":{"./subscription":{"role":"kernel","maturity":"candidate"}}}\n');
    writeFileSync(join(outbox, "AGENTS.md"), readFileSync(join(roots.core, "AGENTS.md"), "utf8").replace(/```ts\n[\s\S]*?```\n/, "Wire the kernel.\n"));
    expect(() => assertPackageDocumentation(outbox, null, () => ["AGENTS.md", "package.json"])).toThrow("AGENTS.md: wiring example has no ts fence");
  });
});


describe("TypeScript fence compilation", () => {
  it.each(["TS", "TypeScript", "TYPESCRIPT", "tsx", "TSX", "mts", "MTS", "cts", "CTS", "ts {1,3}", 'ts title="x"', 'ts title="nocheck"', "ts {nocheck}", "ts attributes nocheck"])("compiles info string %s instead of skipping invalid code", (info) => {
    const root = fixture("# Fixture\n");
    const path = join(root, "example.md");
    writeFileSync(path, `# Example\n\`\`\`${info}\n// Intentionally invalid.\nconst value: number = "bad";\n\`\`\`\n`);
    const violations: string[] = [];
    assertCompiledFences(root, [path], violations);
    expect(violations.join("\n")).toContain("Type 'string' is not assignable to type 'number'");
  }, 15_000);

  it("compiles JSX with preserve and refreshes virtual and dependency source between calls", () => {
    const root = fixture("# Fixture\n");
    const path = join(root, "example.md");
    const declaration = join(root, "value.d.ts");
    writeFileSync(declaration, "export declare const value: number;\n");
    writeFileSync(path, '```tsx title="example"\nimport { value } from "./value.js";\nconst count: number = value;\nconst View = () => null;\nconst view = <View />;\n```\n');
    const check = () => { const violations: string[] = []; assertCompiledFences(root, [path], violations); return violations; };
    expect(check()).toEqual([]);
    writeFileSync(declaration, "export declare const value: string;\n");
    expect(check().join("\n")).toContain("Type 'string' is not assignable to type 'number'");
    writeFileSync(path, "```ts\nconst count: boolean = 1;\n```\n");
    expect(check().join("\n")).toContain("Type 'number' is not assignable to type 'boolean'");
  }, 30_000);

  it.each(["TS nocheck {1}", 'tsx nocheck title="x"', "mts nocheck", "cts nocheck"])("requires a reason only for leading nocheck in %s", (info) => {
    const root = fixture("# Fixture\n");
    const path = join(root, "example.md");
    writeFileSync(path, `\`\`\`${info}\nconst value: number = "bad";\n\`\`\`\n`);
    const violations: string[] = [];
    assertCompiledFences(root, [path], violations);
    expect(violations.join("\n")).toContain("must open with a // reason line");
    writeFileSync(path, `\`\`\`${info}\n// Deliberately invalid example.\nconst value: number = "bad";\n\`\`\`\n`);
    const explained: string[] = [];
    assertCompiledFences(root, [path], explained);
    expect(explained).toEqual([]);
  });
});


const referenceRegions = [
  "exports:core", "exports:outbox", "exports:platform", "sql:outbox", "sql:platform",
  "cli:openlup", "cli:openlup-context", "versioning", "configuration-keys", "refusal-codes", "refusal-codes-open",
];

function referenceFixture() {
  const fixture = guideFixture("# Guide\n");
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(fixture.repository, path)), { recursive: true });
    writeFileSync(join(fixture.repository, path), contents);
  };
  const report = (pkg: string, name: string, code: string) => write(`packages/${pkg}/api/${name}.api.md`, `# API\n\n\`\`\`ts\n${code}\n\`\`\`\n`);
  for (const pkg of ["core", "outbox", "platform"]) {
    write(`packages/${pkg}/package.json`, JSON.stringify({ version: "1.2.3", exports: { "./z": {}, "./package.json": "./package.json", "./nested/a": {}, ".": {} } }));
    write(`packages/${pkg}/release-gates.json`, JSON.stringify({
      packageSurface: {
        "./z": { role: "testing", maturity: "testing", snapshot: "api/missing.api.md" },
        "./nested/a": { role: "kernel", maturity: "candidate", snapshot: "api/unexpected.api.md" },
        ".": { role: "rail", maturity: "experimental", snapshot: "api/root.api.md" },
      },
      packageRelease: { versionRule: "0.N.P", publicStability: "not-claimed" },
      compatibilityPolicies: { testing: "Synthetic protocol support.", candidate: "Preview API." },
    }));
    report(pkg, "unexpected", 'export type ParcelRefusal = "zebra" | null | "absent";');
    report(pkg, "root", 'export type ParcelRefusal = "absent" | "zebra";');
  }
  for (const pkg of ["outbox", "platform"]) {
    write(`packages/${pkg}/sql/manifest.json`, JSON.stringify({
      catalog: { baseline: { file: "do-not-render.sql" } },
      migrations: [{ file: "z.sql", sha256: "do-not-render" }, { file: "a.sql", sha256: "do-not-render" }],
    }));
    for (const file of ["z.sql", "a.sql"]) write(`packages/${pkg}/sql/${file}`, "select 1;\n");
  }
  write("packages/platform/src/lifecycle/openlup.mjs", 'const help = `openlup verify [--json]\n`; const a = "OPENLUP_E_CLI_INPUT"; const b = "OPENLUP_E_CLI_FAILURE"; const c = "OPENLUP_E_APP_UNKNOWN";');
  write("packages/core/src/openlup-context.js", 'import { runCli } from "../dist/agent-context-cli.js"; runCli();\n');
  write("packages/core/src/agent-context-cli.ts", 'const usage = "openlup-context search <task> [--code]\\nopenlup-context mcp\\n";');
  write(".github/VERSIONING_AND_EOL.md", "# Versioning\n");
  return { ...fixture, write, report };
}

const generatedRegion = (name: string, body: string) => `<!-- generated:${name} -->\n${body}<!-- /generated:${name} -->\n`;

describe("generated reference regions", () => {
  it.each(referenceRegions)("renders deterministic, fresh, valid Markdown for %s from its owner", (name) => {
    const fixture = referenceFixture();
    const body = renderGeneratedRegion(name, fixture.repository, "1.2.3")!;
    expect(body).toBeTypeOf("string");
    expect(body.endsWith("\n")).toBe(true);
    expect(renderGeneratedRegion(name, fixture.repository, "1.2.3")).toBe(body);
    fixture.write("packages/core/docs/guide/README.md", `# Guide\n\n${generatedRegion(name, body)}`);
    const violations: string[] = [];
    assertGuideContract(fixture.core, fixture.repository, false, violations);
    expect(violations).toEqual([]);
    const stale: string[] = [];
    syncGeneratedRegions(generatedRegion(name, "old\n"), "fixture", fixture.repository, false, stale);
    expect(stale).toContain(`fixture: generated region ${name} is stale; run docs:check -- --write`);
    const repaired: string[] = [];
    expect(syncGeneratedRegions(generatedRegion(name, "old\n"), "fixture", fixture.repository, true, repaired)).toBe(generatedRegion(name, body));
    expect(repaired).toEqual([]);
  });

  it.each(["core", "outbox", "platform"])("maps %s code exports through the declared report path", (pkg) => {
    const { repository } = referenceFixture();
    const body = renderGeneratedRegion(`exports:${pkg}`, repository, "9.8.7")!;
    expect(body).toContain(`| \`./nested/a\` | kernel | candidate | [API report](${repositoryLink(`packages/${pkg}/api/unexpected.api.md`, "openlup-core-v9.8.7")}) |`);
    expect(body).toContain("| `./z` | testing | testing | none |");
    expect(body.indexOf("| `.`")).toBeLessThan(body.indexOf("| `./nested/a`"));
    expect(body).not.toContain("package.json");
    expect(body).not.toContain("ParcelRefusal");
  });

  it.each(["exports", "maturity"])("omits and counts provider-named subpaths in %s regions", (kind) => {
    const fixture = referenceFixture();
    const provider = ["str", "ipe"].join("");
    const subpath = `./payments/${provider}`;
    const manifest = JSON.parse(readFileSync(join(fixture.repository, "packages/platform/package.json"), "utf8"));
    fixture.write("packages/platform/package.json", JSON.stringify({ ...manifest, exports: { ...manifest.exports, [subpath]: {} } }));
    const gates = JSON.parse(readFileSync(join(fixture.repository, "packages/platform/release-gates.json"), "utf8"));
    fixture.write("packages/platform/release-gates.json", JSON.stringify({ ...gates, packageSurface: { ...gates.packageSurface, [subpath]: { role: "implementation", maturity: "experimental" } } }));
    const body = renderGeneratedRegion(`${kind}:platform`, fixture.repository)!;
    expect(body).not.toContain(provider);
    expect(body).toContain("1 subpaths omitted because their names are provider-specific.");
    expect(body).toContain(repositoryLink("packages/platform/package.json"));
    expect(body).toContain(repositoryLink("packages/platform/AGENTS.md#subpath-maturity"));
    expect(body).toContain("| `./nested/a` |");
    expect(renderGeneratedRegion(`${kind}:core`, fixture.repository)).not.toContain("subpaths omitted");
  });

  it.each(["outbox", "platform"])("lists %s shipped SQL as an inventory by file name and omits source paths and hashes", (pkg) => {
    const { repository } = referenceFixture();
    expect(renderGeneratedRegion(`sql:${pkg}`, repository)).toBe(`| File |\n| --- |\n| [\`a.sql\`](${repositoryLink(`packages/${pkg}/sql/a.sql`)}) |\n| [\`z.sql\`](${repositoryLink(`packages/${pkg}/sql/z.sql`)}) |\n`);
  });

  it("reads CLI string and template constants without executing either bin", () => {
    const fixture = referenceFixture();
    expect(renderGeneratedRegion("cli:openlup", fixture.repository)).toBe("```text\nopenlup verify [--json]\n```\n");
    expect(renderGeneratedRegion("cli:openlup-context", fixture.repository)).toBe("```text\nopenlup-context search <task> [--code]\nopenlup-context mcp\n```\n");
    fixture.write("packages/platform/src/lifecycle/openlup.mjs", 'const help = `dynamic ${process.pid}`; throw new Error("must not execute");');
    expect(() => renderGeneratedRegion("cli:openlup", fixture.repository)).toThrow("expected a static help constant");
  });

  it("renders all release fields and compatibility policies, sorting fields from their owning sections", () => {
    const { repository } = referenceFixture();
    const body = renderGeneratedRegion("versioning", repository)!;
    for (const pkg of ["core", "outbox", "platform"]) {
      expect(body).toContain(`| \`@openlup/${pkg}\` | packageRelease | publicStability | not-claimed |\n| \`@openlup/${pkg}\` | packageRelease | versionRule | 0.N.P |`);
      expect(body).toContain(`| \`@openlup/${pkg}\` | compatibilityPolicies | candidate | Preview API. |\n| \`@openlup/${pkg}\` | compatibilityPolicies | testing | Synthetic protocol support. |`);
    }
    expect(body).toContain(repositoryLink(".github/VERSIONING_AND_EOL.md"));
  });

  it("reports undeclared release fields without borrowing another package's policy", () => {
    const fixture = referenceFixture();
    fixture.write("packages/outbox/release-gates.json", JSON.stringify({ packageSurface: {}, compatibilityPolicies: { preview: "No compatibility promise." } }));
    const body = renderGeneratedRegion("versioning", fixture.repository)!;
    expect(body).toContain("| `@openlup/outbox` | packageRelease | none | not declared |");
    expect(body).toContain("| `@openlup/outbox` | compatibilityPolicies | preview | No compatibility promise. |");
  });

  it("selects exact package source words and excludes scanner-counted provider key names", () => {
    const fixture = referenceFixture();
    const vendor = ["SUPA", "BASE"].join("");
    const names = ["Z_KEY", "APP_BASE_URL", "UNREAD", `BLOB_${vendor}_BUCKET`, "ALMOST", "README_ONLY"];
    fixture.write("config/environment-variables.json", JSON.stringify({ variables: names.map((name) => ({ name, owner: "platform", category: "server-runtime", requiredIn: [], secret: false })) }));
    fixture.write("packages/outbox/src/config.ts", `Z_KEY APP_BASE_URL ${names[3]} ALMOST_LONGER`);
    fixture.write("packages/outbox/README.md", "README_ONLY");
    const body = renderGeneratedRegion("configuration-keys", fixture.repository)!;
    expect(body).toContain("| `APP_BASE_URL` | platform | server-runtime | none | no |\n| `Z_KEY` | platform | server-runtime | none | no |");
    for (const name of names.slice(2)) expect(body).not.toContain(`\`${name}\``);
    expect(body).toContain("1 package-read keys omitted because their names are provider-specific.");
    expect(body).toContain(repositoryLink("config/environment-variables.json"));
    expect(body).toContain(repositoryLink("packages/platform/api/"));
    expect(providerSpecificKeys(fixture.repository, names)).toEqual(new Set([names[3]]));
  });

  it.each(refusalTypeSuffixes)("selects the suffix %s and ignores nonexported aliases and suffix misses", (suffix) => {
    const fixture = referenceFixture();
    fixture.report("core", "selection", `export type Selected${suffix} = "selected";\ntype Hidden${suffix} = "hidden";\nexport type Wrong${suffix}Extra = "wrong";`);
    const body = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    expect(body).toContain(`\`Selected${suffix}\``);
    expect(body).toContain("`selected`");
    expect(body).not.toContain("`hidden`");
    expect(body).not.toContain("`wrong`");
  });

  it("resolves both typeof tuple syntaxes across report fences and drops null", () => {
    const fixture = referenceFixture();
    fixture.report("core", "tuple", 'export type TupleCode = (typeof VALUES)[number];\nexport type OtherCode = typeof VALUES[number];\nexport type NullableRefusal = ("z" | ("a" | null));');
    const path = "packages/core/api/tuple.api.md";
    fixture.write(path, `${readFileSync(join(fixture.repository, path), "utf8")}\n\`\`\`ts\nexport declare const VALUES: readonly ["z", "a", "a"];\n\`\`\`\n`);
    const body = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    for (const name of ["TupleCode", "OtherCode", "NullableRefusal"]) expect(body).toMatch(new RegExp(`\\x60${name}\\x60[^\\n]+\\x60a\\x60, \\x60z\\x60`));
    expect(body).not.toContain("`null`");
    expect(listOpenRefusalTypes(fixture.repository)).toEqual([]);
  });

  it("keeps multiline, escaped and punctuation-bearing string literals reachable in Markdown tables", () => {
    const fixture = referenceFixture();
    const codes = ["", "a|b", "tick`value", "line\nvalue", "quote\"value"];
    fixture.report("core", "punctuation", `export type LiteralCode =\n ${codes.map((code) => JSON.stringify(code)).join(" |\n ")} | null;`);
    const body = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    const violations: string[] = [];
    assertRefusalCodeReachability(body, fixture.repository, violations);
    expect(violations).toEqual([]);
    expect(body).toContain("<code>a&#124;b</code>");
    expect(body).toContain("<code>tick&#96;value</code>");
    expect(body).toContain("<code>line&#10;value</code>");
    expect(body).toContain("<code></code>");
  });

  it("leaves tuple element unions open and resolves constants the report declares without exporting", () => {
    const fixture = referenceFixture();
    fixture.report("core", "tuple-open", 'export declare const UNION: readonly ["a" | "b"];\nexport type UnionCode = typeof UNION[number];\ndeclare const PRIVATE: readonly ["private_a", "private_b"];\nexport type PrivateCode = typeof PRIVATE[number];');
    expect(listOpenRefusalTypes(fixture.repository).map(({ typeName }) => typeName)).toEqual(["UnionCode"]);
    const body = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    expect(body).toContain("`PrivateCode`");
    expect(body).toContain("`private_a`, `private_b`");
    const violations: string[] = [];
    assertRefusalCodeReachability(body.replace("`private_b`", "`other`"), fixture.repository, violations);
    expect(violations.join("\n")).toContain("private_b");
  });

  it("lists open intersections, objects, references, nonliteral tuples and missing constants with reasons", () => {
    const fixture = referenceFixture();
    fixture.report("core", "open", [
      'export type StringCode = "known" | (string & {});',
      'export type ObjectRefusal = { code: "inside_object" };',
      'export type AliasCode = OtherType;',
      'export type MissingCode = typeof MISSING[number];',
      'export declare const VALUES: readonly ["known", string];',
      'export type DynamicCode = (typeof VALUES)[number];',
    ].join("\n"));
    const open = listOpenRefusalTypes(fixture.repository);
    expect(open.map(({ typeName, reason }) => [typeName, reason])).toEqual([
      ["AliasCode", "reference to another type"], ["DynamicCode", "unresolved string-literal tuple VALUES"],
      ["MissingCode", "unresolved string-literal tuple MISSING"], ["ObjectRefusal", "object type"],
      ["StringCode", "intersection type permits values beyond string literals"],
    ]);
    const body = renderGeneratedRegion("refusal-codes-open", fixture.repository)!;
    for (const type of open) expect(body).toContain(`| \`@openlup/${type.packageName}\` | \`${type.typeName}\` | [open.api.md](${repositoryLink(type.report)}) | ${type.reason} |`);
    const closed = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    expect(closed).not.toContain("inside_object");
    expect(closed).not.toContain("StringCode");
  });

  it("deduplicates identical type/code pairs within a package and retains every report and differing definition", () => {
    const fixture = referenceFixture();
    fixture.report("core", "different", 'export type ParcelRefusal = "different";');
    const body = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    const rows = body.split("\n").filter((line) => line.startsWith("| `@openlup/core` | `ParcelRefusal`"));
    expect(rows).toHaveLength(2);
    const shared = rows.find((row) => row.includes("`absent`"))!;
    expect(shared).toContain(repositoryLink("packages/core/api/root.api.md"));
    expect(shared).toContain(repositoryLink("packages/core/api/unexpected.api.md"));
    expect(shared).toContain("[`.`]");
    expect(shared).toContain("[`./nested/a`]");
    expect(body).toContain("| `@openlup/platform` | `openlup` |");
    expect(body).toContain("`OPENLUP_E_CLI_FAILURE`, `OPENLUP_E_CLI_INPUT`");
    expect(body).not.toContain("OPENLUP_E_APP_UNKNOWN");
  });

  it("independently refuses a renderer missing reachable codes, including CLI codes", () => {
    const fixture = referenceFixture();
    const body = renderGeneratedRegion("refusal-codes", fixture.repository)!;
    const valid: string[] = [];
    assertRefusalCodeReachability(body, fixture.repository, valid);
    expect(valid).toEqual([]);
    const violations: string[] = [];
    assertRefusalCodeReachability(body.replaceAll("`absent`", "`absent_suffix`").replaceAll("`OPENLUP_E_CLI_INPUT`", ""), fixture.repository, violations);
    expect(violations).toEqual(["refusal-codes: refusal-codes is missing reachable codes: OPENLUP_E_CLI_INPUT, absent"]);
    const stale: string[] = [];
    syncGeneratedRegions(generatedRegion("refusal-codes", ""), "fixture", fixture.repository, false, stale);
    expect(stale.some((violation) => violation.includes("missing reachable codes"))).toBe(true);
  });

  it("refuses a selected type disappearing until its region is regenerated", () => {
    const fixture = referenceFixture();
    fixture.report("core", "removed", 'export type RemovedRefusal = "removed_code";');
    const before = generatedRegion("refusal-codes", renderGeneratedRegion("refusal-codes", fixture.repository)!);
    fixture.report("core", "removed", "export type NoLongerSelected = string;");
    const violations: string[] = [];
    syncGeneratedRegions(before, "fixture", fixture.repository, false, violations);
    expect(violations).toContain("fixture: generated region refusal-codes is stale; run docs:check -- --write");
    const repaired: string[] = [];
    expect(syncGeneratedRegions(before, "fixture", fixture.repository, true, repaired)).not.toContain("RemovedRefusal");
    expect(repaired).toEqual([]);
  });

  it.each(["exports:ui", "sql:core", "cli:unknown", "refusal-code", "versioning:core"])("refuses unknown region %s", (name) => {
    const { repository } = referenceFixture();
    const violations: string[] = [];
    syncGeneratedRegions(generatedRegion(name, ""), "fixture", repository, false, violations);
    expect(violations).toEqual([`fixture: unknown generated region ${name}`]);
  });

  const repositoryRoot = resolve(packageRoot, "../..");
  // These parse every published API report; coverage instrumentation makes that slow on hosted runners.
  const realRepositoryTimeout = 120_000;
  it.each(referenceRegions)("renders %s against the real repository without throwing", (name) => {
    const body = renderGeneratedRegion(name, repositoryRoot)!;
    expect(body).toBeTypeOf("string");
    expect(body.endsWith("\n")).toBe(true);
    expect(renderGeneratedRegion(name, repositoryRoot)).toBe(body);
    const fixture = guideFixture(`# Guide\n\n${generatedRegion(name, body)}`);
    const version = JSON.parse(readFileSync(join(repositoryRoot, "packages/core/package.json"), "utf8")).version;
    writeFileSync(join(fixture.core, "package.json"), JSON.stringify({ version }));
    const violations: string[] = [];
    assertGuideContract(fixture.core, repositoryRoot, false, violations);
    expect(violations).toEqual([]);
  }, realRepositoryTimeout);

  it("omits provider-specific package-read configuration keys in the real repository", () => {
    const body = renderGeneratedRegion("configuration-keys", repositoryRoot)!;
    const names = [...body.matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1]);
    expect(providerSpecificKeys(repositoryRoot, names).size).toBe(0);
    expect(Number(/(\d+) package-read keys omitted/.exec(body)?.[1])).toBeGreaterThan(0);
  }, realRepositoryTimeout);

  it.each(["exports", "maturity"])("renders real %s subpaths without scanner-counted vocabulary", (kind) => {
    for (const pkg of ["core", "outbox", "platform"]) {
      const body = renderGeneratedRegion(`${kind}:${pkg}`, repositoryRoot)!;
      expect(providerSpecificKeys(repositoryRoot, [body]).size).toBe(0);
      if (pkg === "platform") expect(body).toMatch(/[1-9]\d* subpaths omitted because their names are provider-specific/);
    }
  }, realRepositoryTimeout);

  it("shows exactly the real open inventory and every reachable closed code", () => {
    const open = listOpenRefusalTypes(repositoryRoot);
    const body = renderGeneratedRegion("refusal-codes-open", repositoryRoot)!;
    const rows = body.split("\n").slice(2).filter(Boolean);
    expect(rows).toHaveLength(open.length);
    for (const [index, type] of open.entries()) {
      expect(rows[index]).toContain(`| \`@openlup/${type.packageName}\` | \`${type.typeName}\` |`);
      expect(rows[index]).toContain(type.report);
      expect(rows[index]).toContain(type.reason);
    }
    const violations: string[] = [];
    assertRefusalCodeReachability(renderGeneratedRegion("refusal-codes", repositoryRoot)!, repositoryRoot, violations);
    expect(violations).toEqual([]);
    expect(open.map(({ typeName }) => typeName)).not.toContain("PrivacyRefusalCode");
  }, realRepositoryTimeout);
});
