import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMcp } from "../src/agent-context-mcp.js";
import {
  AGENTS_RULES_BEGIN,
  AGENTS_RULES_END,
  analyzeUpgradeImpact,
  compareSemver,
  domainOfSubpath,
  extractImportsFromSource,
  formatDoctorText,
  formatUpgradeImpactMarkdown,
  runDoctor,
  scanApplicationImports,
  syncAgentsMd,
  type ReleaseIndex,
} from "../src/upgrade-impact.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createAppFixture(options: {
  coreVersion?: string;
  platformVersion?: string;
  outboxVersion?: string;
  lockCoreVersion?: string;
  declaredCoreSpec?: string;
  releaseIndex?: ReleaseIndex;
  portableAdvisories?: unknown;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "openlup-upgrade-impact-"));
  roots.push(root);
  const coreVersion = options.coreVersion ?? "1.4.0";
  const declaredDeps: Record<string, string> = {
    "@openlup/core": options.declaredCoreSpec ?? coreVersion,
  };
  const lockPackages: Record<string, { version: string }> = {
    "node_modules/@openlup/core": { version: options.lockCoreVersion ?? coreVersion },
  };

  // Install @openlup/core
  const coreDir = join(root, "node_modules/@openlup/core");
  mkdirSync(join(coreDir, "dist/subscription"), { recursive: true });
  mkdirSync(join(coreDir, "dist/pricing"), { recursive: true });
  mkdirSync(join(coreDir, "meta"), { recursive: true });
  writeFileSync(join(coreDir, "package.json"), JSON.stringify({
    name: "@openlup/core",
    version: coreVersion,
    engines: { node: ">=24" },
    exports: {
      "./subscription": { types: "./dist/subscription/index.d.ts", import: "./dist/subscription/index.js" },
      "./pricing": { types: "./dist/pricing/index.d.ts", import: "./dist/pricing/index.js" },
    },
  }, null, 2));
  writeFileSync(join(coreDir, "dist/subscription/index.d.ts"), [
    "export declare function nextRetryAttemptAt(): number;",
    "/** @deprecated Use SubscriptionCyclePolicy instead. */",
    "export interface RenewalCyclePolicy { days: number; }",
    "",
  ].join("\n"));
  writeFileSync(join(coreDir, "dist/pricing/index.d.ts"), [
    "export declare function calculateCatalogueMoneyV2(): number;",
    "/** @deprecated Legacy helper. */",
    "export declare function legacyPriceHelper(): number;",
    "",
  ].join("\n"));

  if (options.releaseIndex) {
    writeFileSync(join(coreDir, "meta/release-index.json"), JSON.stringify(options.releaseIndex, null, 2));
  }

  if (options.platformVersion) {
    declaredDeps["@openlup/platform"] = options.platformVersion;
    lockPackages["node_modules/@openlup/platform"] = { version: options.platformVersion };
    const platformDir = join(root, "node_modules/@openlup/platform");
    mkdirSync(join(platformDir, "dist/shipping"), { recursive: true });
    writeFileSync(join(platformDir, "package.json"), JSON.stringify({
      name: "@openlup/platform",
      version: options.platformVersion,
      engines: { node: ">=24" },
      exports: {
        "./shipping": { types: "./dist/shipping/index.d.ts", import: "./dist/shipping/index.js" },
      },
    }, null, 2));
    writeFileSync(join(platformDir, "dist/shipping/index.d.ts"), [
      "export declare function resolveShippingRate(): number;",
      "/** @deprecated Replaced by createShippingLedgerV2. */",
      "export declare function legacyShippingHelper(): void;",
      "",
    ].join("\n"));
    if (options.portableAdvisories !== undefined) {
      mkdirSync(join(platformDir, "sql"), { recursive: true });
      writeFileSync(join(platformDir, "sql/portable-advisories.json"), JSON.stringify(options.portableAdvisories, null, 2));
    }
  }

  if (options.outboxVersion) {
    declaredDeps["@openlup/outbox"] = options.outboxVersion;
    lockPackages["node_modules/@openlup/outbox"] = { version: options.outboxVersion };
    const outboxDir = join(root, "node_modules/@openlup/outbox");
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, "package.json"), JSON.stringify({
      name: "@openlup/outbox",
      version: options.outboxVersion,
      engines: { node: ">=24" },
      exports: { ".": "./dist/index.js" },
    }, null, 2));
  }

  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-adopter-app",
    private: true,
    type: "module",
    dependencies: declaredDeps,
  }, null, 2));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "fixture-adopter-app",
    lockfileVersion: 3,
    packages: { "": {}, ...lockPackages },
  }, null, 2));

  return root;
}

function writeAppFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

const multiHopIndex: ReleaseIndex = {
  schemaVersion: 1,
  currentVersion: "1.4.0",
  releases: [
    {
      version: "1.4.0",
      previousVersion: "1.3.0",
      actionRequired: true,
      subpathsAdded: ["@openlup/platform/shipping/testing", "@openlup/platform/tax"],
      symbolsAdded: ["calculateCatalogueMoneyV2", "runShippingRateAdapterConformance"],
      symbolsDeprecated: ["RenewalCyclePolicy", "legacyShippingHelper"],
      sqlAdded: ["db/platform/migrations/20261124_shipping_v2.sql"],
      settingsDelta: {
        added: ["shipping.rateResolver"],
        removed: ["legacy.tempSetting"],
        changed: ["shipping.addressRegions"],
      },
      starterEntriesCount: 5,
      changes: [
        {
          kind: "action_required",
          audience: "npm",
          subpath: "@openlup/core/subscription",
          symbol: "nextRetryAttemptAt",
          summary: "Verify retry schedule input normalization.",
          migration: "Pass explicit clock date.",
          rail: "both",
        },
        {
          kind: "fix",
          audience: "npm",
          subpath: "@openlup/core/pricing",
          summary: "Fixed rounding edge case in multi-line totals.",
        },
        {
          kind: "feature",
          audience: "starter",
          domain: "pricing",
          summary: "Starter demo checkout copy update.",
        },
        {
          kind: "feature",
          audience: "npm",
          domain: "pricing",
          subpath: "@openlup/core/pricing",
          symbol: "calculateCatalogueMoneyV2",
          summary: "New basis-aware catalogue money v2 calculator.",
        },
      ],
    },
    {
      version: "1.3.0",
      previousVersion: "1.2.0",
      actionRequired: false,
      subpathsAdded: ["@openlup/platform/pricing/browser"],
      symbolsAdded: ["resolveShippingRate"],
      symbolsDeprecated: ["legacyPriceHelper"],
      sqlAdded: ["db/platform/migrations/20261015_pricing_v13.sql"],
      settingsDelta: {
        added: ["legacy.tempSetting", "pricing.subscriptionPriceRounding"],
        removed: [],
        changed: ["shipping.addressRegions"],
      },
      starterEntriesCount: 2,
      changes: [
        {
          kind: "fix",
          audience: "npm",
          subpath: "@openlup/platform/shipping",
          summary: "Fixed carrier rate sorting tie-breaker.",
        },
      ],
    },
  ],
};

describe("static import lexer", () => {
  it("extracts named, namespace, re-export, dynamic, and wildcard export * imports with exact line numbers", () => {
    const source = [
      "/*",
      " * Multi-line comment mentioning",
      ' * import { IgnoredFromComment } from "@openlup/core/subscription";',
      " */",
      'import { nextRetryAttemptAt, type RenewalCyclePolicy as LocalPolicy } from "@openlup/core/subscription";',
      '// import { AlsoIgnored } from "@openlup/core/pricing";',
      'const literal = \'import { InString } from "@openlup/core/pricing"\';',
      'import * as pricingNs from "@openlup/core/pricing";',
      'export { resolveShippingRate as ship } from "@openlup/platform/shipping";',
      'export * from "@openlup/core/subscription";',
      'export type * from "@openlup/platform/shipping";',
      'async function load() { return import("@openlup/platform/tax"); }',
      'import { internal } from "@openlup/core/src/private";',
      "",
    ].join("\n");

    const parsed = extractImportsFromSource("src/example.ts", source);
    expect(parsed.imports.map((item) => ({ line: item.line, subpath: item.subpath, kind: item.kind, symbols: item.symbols }))).toEqual([
      { line: 5, subpath: "@openlup/core/subscription", kind: "named", symbols: ["RenewalCyclePolicy", "nextRetryAttemptAt"] },
      { line: 8, subpath: "@openlup/core/pricing", kind: "namespace", symbols: [] },
      { line: 9, subpath: "@openlup/platform/shipping", kind: "reexport-named", symbols: ["resolveShippingRate"] },
      { line: 10, subpath: "@openlup/core/subscription", kind: "reexport-wildcard", symbols: [] },
      { line: 11, subpath: "@openlup/platform/shipping", kind: "reexport-wildcard", symbols: [] },
      { line: 12, subpath: "@openlup/platform/tax", kind: "dynamic", symbols: [] },
      { line: 13, subpath: "@openlup/core/src/private", kind: "named", symbols: ["internal"] },
    ]);
    expect(parsed.wildcardReexports).toEqual([
      { file: "src/example.ts", line: 10, subpath: "@openlup/core/subscription" },
      { file: "src/example.ts", line: 11, subpath: "@openlup/platform/shipping" },
    ]);
    expect(parsed.deepImports).toEqual([
      { file: "src/example.ts", line: 13, specifier: "@openlup/core/src/private" },
    ]);
  });

  it("ignores node_modules, dist, .git, .next, build and coverage directories", () => {
    const root = createAppFixture({ releaseIndex: multiHopIndex });
    writeAppFile(root, "src/app.ts", 'import { nextRetryAttemptAt } from "@openlup/core/subscription";\n');
    for (const ignored of ["dist/out.js", "build/out.js", ".next/chunk.js", "coverage/report.js"]) {
      writeAppFile(root, ignored, 'import { Ignored } from "@openlup/core/pricing";\n');
    }
    const scan = scanApplicationImports(root);
    expect(scan.scannedFiles).toBe(1);
    expect(scan.imports).toHaveLength(1);
    expect(scan.imports[0]?.file).toBe("src/app.ts");
  });
});

describe("analyzeUpgradeImpact", () => {
  it("aggregates multi-hop releases, detects wildcard export *, respects excludeStarter & includeDormant, and reads portable advisories", () => {
    const root = createAppFixture({
      coreVersion: "1.4.0",
      platformVersion: "1.4.0",
      releaseIndex: multiHopIndex,
      portableAdvisories: { advisories: [{ id: "adv-1", note: "Verify search_path on managed rail." }] },
    });
    writeAppFile(root, "src/subs.ts", [
      'import { nextRetryAttemptAt, type RenewalCyclePolicy } from "@openlup/core/subscription";',
      'export * from "@openlup/core/subscription";',
      "",
    ].join("\n"));
    writeAppFile(root, "src/pricing.ts", 'import * as pricing from "@openlup/core/pricing";\n');
    writeAppFile(root, "src/shipping.ts", 'import { resolveShippingRate } from "@openlup/platform/shipping";\n');

    const report = analyzeUpgradeImpact({
      root,
      from: "1.2.0",
      to: "1.4.0",
      rail: "managed",
      excludeStarter: true,
      includeDormant: false,
    });

    expect(report.formatVersion).toBe(1);
    expect(report.hops).toEqual(["1.3.0", "1.4.0"]);
    expect(report.missingIntermediateHops).toBe(false);
    expect(report.wildcardReexports).toEqual([
      { file: "src/subs.ts", line: 2, subpath: "@openlup/core/subscription" },
    ]);

    // Bucket 1: named deprecation + action_required + namespace deprecation + wildcard re-export warning
    expect(report.actionRequiredOnYourImports).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "src/subs.ts", line: 1, subpath: "@openlup/core/subscription", symbol: "RenewalCyclePolicy", kind: "symbol_deprecated", version: "1.4.0" }),
      expect.objectContaining({ file: "src/subs.ts", line: 1, subpath: "@openlup/core/subscription", symbol: "nextRetryAttemptAt", kind: "action_required", version: "1.4.0", migration: "Pass explicit clock date." }),
      expect.objectContaining({ file: "src/subs.ts", line: 2, subpath: "@openlup/core/subscription", kind: "wildcard_reexport", version: "1.4.0" }),
      expect.objectContaining({ file: "src/pricing.ts", line: 1, subpath: "@openlup/core/pricing", symbol: "legacyPriceHelper", kind: "symbol_deprecated", version: "1.3.0" }),
    ]));

    // Bucket 2: multi-hop free fixes matched on imported subpaths
    expect(report.freeFixesOnYourImports).toEqual([
      expect.objectContaining({ version: "1.3.0", subpath: "@openlup/platform/shipping", matchedFiles: ["src/shipping.ts"] }),
      expect.objectContaining({ version: "1.4.0", subpath: "@openlup/core/pricing", matchedFiles: ["src/pricing.ts"] }),
    ]);

    // Bucket 3: active domains only (shipping + pricing), NO dormant tax, NO starter entries because excludeStarter=true
    expect(report.hiddenStarterEntriesCount).toBe(8); // 5 + 2 + 1 starter change
    expect(report.newOptInInYourDomains.some((item) => item.domain === "starter")).toBe(false);
    expect(report.newOptInInYourDomains.some((item) => item.domain === "tax")).toBe(false);
    expect(report.newOptInInYourDomains).toEqual(expect.arrayContaining([
      expect.objectContaining({ subpath: "@openlup/platform/shipping/testing", domain: "shipping", inActiveDomain: true }),
      expect.objectContaining({ subpath: "@openlup/platform/pricing/browser", domain: "pricing", inActiveDomain: true }),
    ]));

    // Bucket 4: multi-hop SQL + settings delta (legacy.tempSetting added in 1.3.0 and removed in 1.4.0 cancels out) + railNote + portableAdvisories
    expect(report.sqlAndSettingsDelta.sqlAdded).toEqual([
      "db/platform/migrations/20261015_pricing_v13.sql",
      "db/platform/migrations/20261124_shipping_v2.sql",
    ]);
    expect(report.sqlAndSettingsDelta.settingsDelta).toEqual({
      added: ["pricing.subscriptionPriceRounding", "shipping.rateResolver"],
      removed: [],
      changed: ["shipping.addressRegions"],
    });
    expect(report.sqlAndSettingsDelta.railNote).toContain("Managed rail:");
    expect(report.sqlAndSettingsDelta.portableAdvisories).toEqual({
      advisories: [{ id: "adv-1", note: "Verify search_path on managed rail." }],
    });

    // includeDormant=true & excludeStarter=false exposes dormant domains + starter summary
    const expanded = analyzeUpgradeImpact({
      root,
      from: "1.2.0",
      to: "1.4.0",
      excludeStarter: false,
      includeDormant: true,
    });
    expect(expanded.newOptInInYourDomains.some((item) => item.subpath === "@openlup/platform/tax" && !item.inActiveDomain)).toBe(true);
    expect(expanded.newOptInInYourDomains.some((item) => item.kind === "starter_entries")).toBe(true);

    const md = formatUpgradeImpactMarkdown(report);
    expect(md).toContain("# OpenLup Upgrade Impact (1.2.0 -> 1.4.0)");
    expect(md).toContain("## 1. Action required on your imports");
    expect(md).toContain("Wildcard re-exports");
    expect(md).toContain("## 4. SQL and settings delta");
  });

  it("supports an explicit --manifest path without requiring installed meta/release-index.json", () => {
    const root = createAppFixture();
    const manifestPath = join(root, "custom-index.json");
    writeFileSync(manifestPath, JSON.stringify(multiHopIndex));
    writeAppFile(root, "src/index.ts", 'import { RenewalCyclePolicy } from "@openlup/core/subscription";\n');

    const report = analyzeUpgradeImpact({ root, from: "1.3.0", manifestPath });
    expect(report.hops).toEqual(["1.4.0"]);
    expect(report.actionRequiredOnYourImports.some((item) => item.symbol === "RenewalCyclePolicy")).toBe(true);
  });

  it("validates semver ordering and normalizes singular/plural domains", () => {
    expect(compareSemver("1.3.0", "1.4.0")).toBe(-1);
    expect(compareSemver("1.4.0", "1.4.0")).toBe(0);
    expect(compareSemver("1.4.0", "1.4.0-rc.1")).toBe(1);
    expect(domainOfSubpath("@openlup/core/subscription")).toBe("subscriptions");
    expect(domainOfSubpath("@openlup/platform/subscriptions/contracts")).toBe("subscriptions");
    expect(domainOfSubpath("@openlup/core/promo")).toBe("promotions");
    expect(() => analyzeUpgradeImpact({ root: createAppFixture({ releaseIndex: multiHopIndex }), from: "1.5.0", to: "1.4.0" })).toThrow(/must not be greater/);
  });
});

describe("capability-aware runDoctor", () => {
  it("reports ready with skipped not_configured optional checks and writes upgrade-receipt.json", () => {
    const root = createAppFixture({
      coreVersion: "1.4.0",
      outboxVersion: "1.4.0",
      platformVersion: "1.4.0",
      releaseIndex: multiHopIndex,
    });
    writeAppFile(root, "src/index.ts", [
      'import { nextRetryAttemptAt, type RenewalCyclePolicy } from "@openlup/core/subscription";',
      "export const ok = nextRetryAttemptAt;",
      "export type Policy = RenewalCyclePolicy;",
      "",
    ].join("\n"));

    const report = runDoctor({ root, receiptPath: "artifacts/upgrade-receipt.json", nodeVersion: "24.21.0" });
    expect(report.formatVersion).toBe(1);
    expect(report.verdict).toBe("ready");
    expect(report.version).toBe("1.4.0");
    expect(report.packages).toEqual(["@openlup/core", "@openlup/outbox", "@openlup/platform"]);
    expect(report.checks.versionParity.status).toBe("passed");
    expect(report.checks.nodeEngine.status).toBe("passed");
    expect(report.checks.forbiddenDeepImports.status).toBe("passed");
    // Deprecations warn without falsely blocking 1.x readiness
    expect(report.checks.deprecationsInUse.status).toBe("warn");
    expect(report.deprecationsInUse).toEqual([
      { file: "src/index.ts", line: 1, subpath: "@openlup/core/subscription", symbol: "RenewalCyclePolicy" },
    ]);
    // Unconfigured optional capabilities are skipped (not unknown/blocked)
    expect(report.checks.verify).toEqual({ status: "skipped", reason: "not_configured" });
    expect(report.checks.settings).toEqual({ status: "skipped", reason: "not_configured" });
    expect(report.checks.recipes).toEqual({ status: "skipped", reason: "not_configured" });
    expect(report.receiptPath).toBe("artifacts/upgrade-receipt.json");

    const receipt = JSON.parse(readFileSync(join(root, "artifacts/upgrade-receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("ready");
    expect(typeof receipt.generatedAt).toBe("string");
    expect(formatDoctorText(report)).toContain("OpenLup doctor: ready");
  });

  it("detects configured optional capabilities without blocking", () => {
    const root = createAppFixture({ coreVersion: "1.4.0", platformVersion: "1.4.0" });
    writeAppFile(root, "application-observations.mjs", "export function createVerificationInput() { return {}; }\n");
    writeAppFile(root, "owned/settings-host.ts", "export function createSettingsBindings() { return {}; }\n");
    writeAppFile(root, "owned/adapters/shipping/custom/recipe.json", '{"schemaVersion":1}\n');

    const report = runDoctor({ root, nodeVersion: "24.21.0" });
    expect(report.verdict).toBe("ready");
    expect(report.checks.verify.status).toBe("configured");
    expect(report.checks.settings.status).toBe("configured");
    expect(report.checks.recipes.status).toBe("configured");
  });

  it("blocks on version parity mismatch, Node <24, and forbidden deep imports", () => {
    const root = createAppFixture({
      coreVersion: "1.4.0",
      platformVersion: "1.3.0",
      lockCoreVersion: "1.3.0",
    });
    writeAppFile(root, "src/bad.ts", [
      'import { a } from "@openlup/core/src/subscription/index.ts";',
      'import { b } from "@openlup/platform/dist/shipping/index.js";',
      "",
    ].join("\n"));

    const report = runDoctor({ root, nodeVersion: "22.11.0" });
    expect(report.verdict).toBe("blocked");
    expect(report.checks.versionParity.status).toBe("failed");
    expect(report.checks.versionParity.issues.some((msg) => msg.includes("Mixed installed"))).toBe(true);
    expect(report.checks.versionParity.issues.some((msg) => msg.includes("package-lock.json"))).toBe(true);
    expect(report.checks.nodeEngine.status).toBe("failed");
    expect(report.checks.forbiddenDeepImports.status).toBe("failed");
    expect(report.checks.forbiddenDeepImports.violations).toEqual([
      { file: "src/bad.ts", line: 1, specifier: "@openlup/core/src/subscription/index.ts" },
      { file: "src/bad.ts", line: 2, specifier: "@openlup/platform/dist/shipping/index.js" },
    ]);
  });
});

describe("idempotent syncAgentsMd", () => {
  it("creates, updates, preserves private adopter rules verbatim, and is idempotent", () => {
    const root = createAppFixture();

    // 1. Check when missing -> drift without writing
    const missingCheck = syncAgentsMd({ root, check: true });
    expect(missingCheck).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "drift", action: "create", changed: true });

    // 2. Create
    const created = syncAgentsMd({ root });
    expect(created).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "updated", action: "create", changed: true });
    const content = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(content).toContain(AGENTS_RULES_BEGIN);
    expect(content).toContain(AGENTS_RULES_END);
    expect(content).toContain("openlup-context impact");
    expect(content).toContain("openlup-context doctor");
    expect(content).toContain("skills/openlup-upgrade/SKILL.md");

    // 3. Idempotent rerun
    expect(syncAgentsMd({ root })).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "up_to_date", action: "none", changed: false });
    expect(syncAgentsMd({ root, check: true })).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "up_to_date", action: "none", changed: false });

    // 4. Preserve private adopter rules before & after markers when updating stale block
    const customBefore = "# Private Store Guide\n\nCustom header rule.\n\n";
    const customAfter = "\n\n## Private checkout policies\nNever alter private policy X.\n";
    writeFileSync(join(root, "AGENTS.md"), `${customBefore}${AGENTS_RULES_BEGIN}\noutdated block\n${AGENTS_RULES_END}${customAfter}`);

    expect(syncAgentsMd({ root, check: true })).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "drift", action: "update", changed: true });
    expect(syncAgentsMd({ root })).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "updated", action: "update", changed: true });
    const updated = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(updated.startsWith(customBefore)).toBe(true);
    expect(updated.endsWith(customAfter)).toBe(true);
    expect(updated).not.toContain("outdated block");
    expect(updated).toContain("skills/openlup-upgrade/SKILL.md");

    // 5. Append to AGENTS.md without markers
    const plain = "# Custom Only\n\nPrivate notes.\n";
    writeFileSync(join(root, "AGENTS.md"), plain);
    expect(syncAgentsMd({ root })).toEqual({ formatVersion: 1, path: "AGENTS.md", status: "updated", action: "append", changed: true });
    const appended = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(appended.startsWith(plain)).toBe(true);
    expect(appended).toContain(AGENTS_RULES_BEGIN);

    // 6. Refuse malformed markers without modifying file
    const broken = `${AGENTS_RULES_BEGIN}\nmissing end marker\n`;
    writeFileSync(join(root, "AGENTS.md"), broken);
    expect(() => syncAgentsMd({ root })).toThrow(/Malformed openlup-agent-rules markers/);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(broken);
  });
});

describe("CLI and MCP integration", () => {
  it("runs impact, doctor, and agents-sync through openlup-context CLI", () => {
    const root = createAppFixture({ coreVersion: "1.4.0", platformVersion: "1.4.0", releaseIndex: multiHopIndex });
    writeAppFile(root, "src/barrel.ts", 'export * from "@openlup/core/subscription";\n');
    const cli = fileURLToPath(new URL("../src/openlup-context.js", import.meta.url));

    const impactRes = spawnSync(process.execPath, [cli, "impact", "--from", "1.3.0", "--exclude-starter", "--format", "json"], { cwd: root, encoding: "utf8" });
    expect(impactRes.status, impactRes.stderr).toBe(0);
    const impactJson = JSON.parse(impactRes.stdout);
    expect(impactJson.formatVersion).toBe(1);
    expect(impactJson.wildcardReexports).toEqual([{ file: "src/barrel.ts", line: 1, subpath: "@openlup/core/subscription" }]);

    const doctorRes = spawnSync(process.execPath, [cli, "doctor", "--json", "--receipt", "receipt.json"], { cwd: root, encoding: "utf8" });
    expect(doctorRes.status, doctorRes.stderr).toBe(0);
    expect(JSON.parse(doctorRes.stdout).verdict).toBe("ready");

    const syncCheckBefore = spawnSync(process.execPath, [cli, "agents-sync", "--check", "--json"], { cwd: root, encoding: "utf8" });
    expect(syncCheckBefore.status).toBe(1);
    expect(JSON.parse(syncCheckBefore.stdout).status).toBe("drift");

    const syncApply = spawnSync(process.execPath, [cli, "agents-sync", "--json"], { cwd: root, encoding: "utf8" });
    expect(syncApply.status, syncApply.stderr).toBe(0);

    const syncCheckAfter = spawnSync(process.execPath, [cli, "agents-sync", "--check", "--json"], { cwd: root, encoding: "utf8" });
    expect(syncCheckAfter.status, syncCheckAfter.stderr).toBe(0);
    expect(JSON.parse(syncCheckAfter.stdout).status).toBe("up_to_date");
  });

  it("exposes impact_openlup_upgrade through the MCP server and rejects invalid params", async () => {
    const root = createAppFixture({ coreVersion: "1.4.0", releaseIndex: multiHopIndex });
    writeAppFile(root, "src/index.ts", 'import { RenewalCyclePolicy } from "@openlup/core/subscription";\n');

    let stdout = "";
    const output = new Writable({
      write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); },
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "impact_openlup_upgrade", arguments: { from: "1.3.0", excludeStarter: true } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "impact_openlup_upgrade", arguments: { from: "1.3.0", rail: "invalid" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "impact_openlup_upgrade", arguments: {} } },
    ];
    await runMcp(root, Readable.from(requests.map((m) => `${JSON.stringify(m)}\n`)), output);
    const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));

    expect(replies[0].result.isError).toBeUndefined();
    expect(replies[0].result.structuredContent.formatVersion).toBe(1);
    expect(replies[0].result.structuredContent.hops).toEqual(["1.4.0"]);
    expect(replies[0].result.structuredContent.actionRequiredOnYourImports).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: "RenewalCyclePolicy", kind: "symbol_deprecated" })]),
    );
    expect(replies[0].result.content[0].text).toContain("# OpenLup Upgrade Impact (1.3.0 -> 1.4.0)");

    expect(replies[1]).toMatchObject({ id: 2, error: { code: -32602 } });
    expect(replies[2]).toMatchObject({ id: 3, error: { code: -32602 } });
  });
});
