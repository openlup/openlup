/** Called by the existing cold consumer after installing its verified tarballs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppUpgradePlan, AppVerificationFinding } from "@openlup/platform/lifecycle";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { catalogueUpgradeFixture } from "../../examples/neutral-store/test/catalogue-upgrade-fixture.ts";

// Immutable published artifacts, independently read from the public registry.
// Availability failure refuses proof; no current workspace substitutes for them.
const publishedReleases = [
  { version: "0.35.0", integrity: "sha512-hg7dSjSkbsU8SddTWRvMYb/LbybOVy7ZttDHYFmZ53ALGXctdK960lhgWW2RcmBYsFRx8HTR4EOyADhJL1fhSg==", coreIntegrity: "sha512-Z3q6qcva66yqcyj26DG4jJcMk3iX5tJOf1UgHUbMXlWNQt4lTTBQhb/AkOeB7uvdp9AtBKdAaiw1yzMxnqYtJQ==" },
  { version: "0.36.0", integrity: "sha512-8Lu0YOudABDDQRA38OuPiiRt6lUXIT9cAWBE+PSMahQAqVaGOqruSU/KWcBeP8HfIAZIwGWxxahV4TXgYu66uQ==", coreIntegrity: "sha512-k+aXTW4/TjayyJ5Cqp7KLXUKGhhyAiUy6akWTy+ARtY6dV5A+vhayoz11dUiispvN6y9Y11CJFEzHwf/pHoqQA==" },
] as const;

function preparePublishedReleases(root: string): void {
  for (const release of publishedReleases) {
   for (const [name, integrity] of [["platform", release.integrity], ["core", release.coreIntegrity]] as const) {
    const archive = join(root, `${name}-${release.version}.tgz`);
    const url = `https://registry.npmjs.org/@openlup/${name}/-/${name}-${release.version}.tgz`;
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { writeFile } from "node:fs/promises";
      for (let attempt = 0; attempt < 2; attempt++) {
        let response, bytes;
        try {
          response = await fetch(${JSON.stringify(url)}, {redirect:"error",signal:AbortSignal.timeout(60000)});
          if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
        } catch { /* Network/body timeout is unavailable, without leaking response details. */ }
        if (bytes) {
          if (bytes.length > 20000000) throw Error("published_upgrade_artifact_too_large");
          await writeFile(${JSON.stringify(archive)},bytes,{flag:"wx"});
          break;
        }
        const retryAfter = response?.headers.get("retry-after");
        const quota = [402, 403, 429].includes(response?.status) || (response?.status === 503 && retryAfter != null);
        const failure = quota ? "published_upgrade_artifact_quota_http_" + response.status : "published_upgrade_artifact_unavailable";
        if (response && !response.ok) await response.body?.cancel().catch(() => {});
        if (attempt === 1) throw Error(failure);
        const seconds = retryAfter != null && /^[0-9]+(?:[.][0-9]+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
        const date = retryAfter == null ? NaN : Date.parse(retryAfter);
        const wait = !Number.isNaN(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
        // Do not retry earlier than requested or let a registry hold CI indefinitely.
        if (wait > 60000) throw Error(failure + "_retry_after_exceeds_budget");
        await new Promise(done => setTimeout(done, wait));
      }
    `], { cwd: root, env: isolatedConsumerEnv(), timeout: 195_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(`sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`, integrity);
    const packageRoot = join(root, "releases", release.version, `node_modules/@openlup/${name}`);
    mkdirSync(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", packageRoot], { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, `@openlup/${name}`);
    assert.equal(manifest.version, release.version);
   }
  }
}

/** Greatest stable core tag below the target visible in every package's npm history. */
export function previousPublishedSet(target: string, tags: string, versions: string[][]): string {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  assert(stable.test(target) && versions.length > 0, "upgrade_pair_invalid");
  const compare = (a: string, b: string) => {
    const left = a.split(".").map(Number), right = b.split(".").map(Number);
    return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
  };
  const candidates = [...tags.matchAll(/refs\/tags\/openlup-core-v([^\s^]+)/g)].map(match => match[1]!);
  const previous = candidates.filter(version => stable.test(version) && compare(version, target) < 0 && versions.every(list => list.includes(version))).sort(compare).at(-1);
  assert(previous, "upgrade_pair_previous_unavailable");
  return previous;
}

/** Source-mapped extraction has already materialized these managed paths. */
export function starterUpgradeSnapshot(directory: string, version: string) {
  const ownership = JSON.parse(readFileSync(join(directory, "ownership.json"), "utf8"));
  const files = Object.fromEntries(ownership.managed.filter((path: string) => !ownership.generated.includes(path)).sort()
    .map((path: string) => { assert(!ownership.owned.includes(path), "upgrade_snapshot_ownership_overlap"); return [path, readFileSync(join(directory, path), "utf8")]; }));
  // A harness-only ordinal: neither snapshot admission nor this proof observes SQL.
  return { version, schema: { min: 0, max: 0 }, files: files as Record<string, string> };
}

/** Optional rule templates are offered by extraction. An upgrade preserves the existing draft validator. */
export const starterOptionalCatalogueFiles: ReadonlySet<string> = new Set([
  "owned/catalogue-rules.cjs", "owned/catalogue-rules.test.cjs",
]);

/** Optional application-owned composition templates introduced after 1.1.0; existing upgraded stores keep their current wiring. */
export const starterOptionalOwnedFiles: ReadonlySet<string> = new Set([
  ...starterOptionalCatalogueFiles,
  "owned/payment-rail.ts",
  "owned/payment-rail.test.ts",
  "owned/email-transport.ts",
  "owned/email-transport.test.ts",
  "owned/fulfillment-adapter.ts",
  "owned/fulfillment-adapter.test.ts",
  "owned/invoice-provider.ts",
  "owned/invoice-provider.test.ts",
]);

export const starterSettingsHost = "owned/settings-host.ts";
const settingsHeading = "\n## Change a business setting\n";
const starterAgentGuide = "AGENTS.md";

export function includeSettingsHost(app: string, target: string, to: ReturnType<typeof starterUpgradeSnapshot>): void {
  if (!existsSync(join(target, starterSettingsHost))) return;
  if (existsSync(join(app, starterSettingsHost))) delete to.files[starterSettingsHost];
  else to.files[starterSettingsHost] = readFileSync(join(target, starterSettingsHost), "utf8");
}

/** Packaged pristine-file migrations, before the proof adds its owned customizations. */
export function migrateStarterOwned(app: string, target: string, from: ReturnType<typeof starterUpgradeSnapshot>, to: ReturnType<typeof starterUpgradeSnapshot>): void {
  if (from.version === "1.3.0" && to.version !== from.version && existsSync(join(target, starterSettingsHost))) {
    const previous = readFileSync(join(app, starterAgentGuide), "utf8");
    const candidate = readFileSync(join(target, starterAgentGuide), "utf8");
    if (previous !== candidate) {
      from.files[starterAgentGuide] = previous;
      to.files[starterAgentGuide] = candidate;
    }
  }
  // The factor migration starts after 1.2.0. Synthetic starters can omit the catalogue.
  const catalogue = "owned/catalogue.ts";
  if (["1.1.0", "1.2.0"].includes(from.version) && !["1.0.0", "1.1.0", "1.2.0"].includes(to.version)
    && existsSync(join(target, catalogue))) {
    writeFileSync(join(app, catalogue), readFileSync(join(target, catalogue)));
  }
  // The next set is not numbered yet. Its managed locale contract identifies
  // this migration without applying it to a released 1.1.0 or synthetic starter.
  if (from.version === "1.1.0" && to.version !== from.version && Object.hasOwn(to.files, "shared/locales.ts")) {
    const created = "owned/market.config.ts";
    assert(!Object.hasOwn(from.files, created) && !Object.hasOwn(to.files, created), "migration_owned_snapshot_overlap");
    to.files[created] = readFileSync(join(target, created), "utf8");
    // The exact store.config.ts replacement includes the checkout recovery reminder schedule.
    for (const path of ["AGENTS.md", "owned/renewal.config.ts", "owned/store.config.ts", "owned/acquisition-policy.ts",
      "owned/copy.ts", "owned/editor-copy.ts", "owned/quote-copy.ts", "owned/renewal-copy.ts", "owned/demo-seed.ts"]) {
      writeFileSync(join(app, path), readFileSync(join(target, path)));
    }
    // Check the extraction inventory independently of the replacement list.
    const ownership = JSON.parse(readFileSync(join(target, "ownership.json"), "utf8"));
    for (const path of ownership.owned) {
      if (path === created || path === starterSettingsHost) continue; // The CLI creates required files from the target snapshot.
      if (starterOptionalOwnedFiles.has(path) && !existsSync(join(app, path))) continue;
      assert(readFileSync(join(app, path)).equals(readFileSync(join(target, path))), `starter owned migration did not match target: ${path}`);
    }
  }
  if (existsSync(join(target, starterSettingsHost))) {
    const path = join(app, "AGENTS.md");
    const previous = readFileSync(path, "utf8");
    const candidate = readFileSync(join(target, "AGENTS.md"), "utf8");
    const start = candidate.indexOf(settingsHeading);
    assert(start >= 0, "starter settings guidance missing from target");
    if (!previous.includes(settingsHeading)) {
      const end = candidate.indexOf("\n## ", start + settingsHeading.length);
      writeFileSync(path, previous + (previous.endsWith("\n") ? "" : "\n") + candidate.slice(start, end < 0 ? undefined : end));
    }
    includeSettingsHost(app, target, to);
  }
  if (to.version === "1.1.0" && ["0.43.0", "1.0.0"].includes(from.version))
    writeFileSync(join(app, "owned/renewal.config.ts"), readFileSync(join(target, "owned/renewal.config.ts")));
  if (from.version !== "0.43.0" || !["1.0.0", "1.1.0"].includes(to.version)) return;
  for (const path of ["owned/quote-shipping.ts", "owned/renewal-policy.ts", "owned/catalogue.json"]) {
    assert(!Object.hasOwn(from.files, path) && !Object.hasOwn(to.files, path), "migration_owned_snapshot_overlap");
    to.files[path] = readFileSync(join(target, path), "utf8");
  }
  for (const path of ["owned/store.config.ts", "owned/quote-copy.ts", "owned/subscription-editing.ts", "owned/catalogue.ts"]) {
    writeFileSync(join(app, path), readFileSync(join(target, path)));
  }
}

export function assertUpgradeConflict(report: Pick<CliReport, "state" | "applied" | "conflicts">, path: string): void {
  assert.equal(report.state, "refused"); assert.deepEqual(report.applied, []);
  assert.deepEqual(report.conflicts, [{ path, reason: "current bytes match neither predecessor nor candidate" }]);
}

export function reconcileStarterAgentGuide(
  app: string, from: ReturnType<typeof starterUpgradeSnapshot>, to: ReturnType<typeof starterUpgradeSnapshot>,
  applyRefused: () => Parameters<typeof assertUpgradeConflict>[0],
) {
  const path = join(app, starterAgentGuide);
  const addition = "\nRecord local acceptance results in the test log.\n";
  const customized = from.files[starterAgentGuide] + addition;
  writeFileSync(path, customized);
  assertUpgradeConflict(applyRefused(), starterAgentGuide);
  assert.equal(readFileSync(path, "utf8"), customized);
  const bytes = Buffer.from(to.files[starterAgentGuide] + addition);
  writeFileSync(path, bytes);
  // The guide is application-owned after the explicit reconciliation.
  delete from.files[starterAgentGuide];
  delete to.files[starterAgentGuide];
  return { path: starterAgentGuide, bytes };
}

/** Refuse serving a mixed file snapshot or a declared/installed package mismatch. */
export function assertCompleteStarter(directory: string, snapshot: ReturnType<typeof starterUpgradeSnapshot>): void {
  const matches = Object.entries(snapshot.files).every(([path, content]) => existsSync(join(directory, path)) && readFileSync(join(directory, path), "utf8") === content);
  const dependencies = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).dependencies;
  const installed = Object.entries(dependencies).filter(([name]) => name.startsWith("@openlup/")).every(([name, version]) =>
    existsSync(join(directory, "node_modules", name, "package.json")) && JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).version === version);
  assert(matches && installed, "incomplete_application_upgrade");
}

export const reminderInstallationTest = "test/installation.test.ts";

export function reconcileReminderInstallationTest(app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0]) {
  const managed = join(app, reminderInstallationTest);
  const name = "runs the application-owned installation test";
  const localCase = `
test(${JSON.stringify(name)}, () => {
  assert.equal(2 + 2, 4);
});
`;
  const customized = predecessor + localCase;
  writeFileSync(managed, customized);
  assertUpgradeConflict(applyRefused(), reminderInstallationTest);
  const current = readFileSync(managed, "utf8");
  assert.equal(current, customized, "refused upgrade changed the managed test");

  const path = "test/local-installation.test.ts";
  const bytes = `import { test } from 'node:test';
import assert from 'node:assert/strict';
${current.slice(predecessor.length)}`;
  writeFileSync(join(app, path), bytes, { flag: "wx" });
  writeFileSync(managed, predecessor);
  return { path, bytes, name };
}

export const starterEditorPorts = "host/editor-ports.ts";

export function reconcileEditorCustomization(app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0]) {
  return reconcileManagedCustomization(app, predecessor, applyRefused, starterEditorPorts,
    "owned/editor-customization.ts", "\nexport const localEditorNote = 'Adopter editor customization';\n");
}

export const starterDocumentFiles = ["host/editor-catalogue.ts", "host/quote-composition.ts"] as const;

export function reconcileDocumentCustomization(app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0],
  path: typeof starterDocumentFiles[number]) {
  return reconcileManagedCustomization(app, predecessor, applyRefused, path,
    `owned/upgrade-notes/${path.split("/").at(-1)}`, "\n// Adopter document verification policy.\n");
}

function reconcileManagedCustomization(
  app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0],
  managedPath: string, path: string, edit: string,
) {
  const managed = join(app, managedPath);
  const customized = Buffer.from(predecessor + edit);
  writeFileSync(managed, customized);
  assertUpgradeConflict(applyRefused(), managedPath);
  const current = readFileSync(managed);
  assert.deepEqual(current, customized, `refused upgrade changed ${managedPath}`);

  const bytes = current.subarray(Buffer.byteLength(predecessor));
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), bytes, { flag: "wx" });
  writeFileSync(managed, predecessor);
  return { path, bytes };
}

export const starterDisplayFiles = ["host/paid-mail.ts", "client/pages/account.ts", "browser/acquisition.spec.ts"] as const;

export function reconcileDisplayCustomization(
  app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0],
  path: typeof starterDisplayFiles[number],
) {
  return reconcileManagedCustomization(app, predecessor, applyRefused, path,
    `owned/upgrade-notes/${path.split("/").at(-1)}`, "\n// Adopter display customization.\n");
}

export const starterCheckoutFiles = [
  "host/checkout-attempts.ts", "host/native-composition.ts", "host/purchase-composition.ts",
  "test/checkout-attempts.test.ts", "test/locales.test.ts", "browser/journey.spec.ts",
] as const;

const starterCheckoutCopy = "owned/copy.ts";
const checkoutQuotaJourney = "browser/journey.spec.ts";
const checkoutQuotaWitness = "limits page explains checkout quotas across restarts";
const checkoutQuotaEntry = /^ {4}attemptLimitsInterim: ("(?:[^"\\\n]|\\.)*"),$/gmu;

function reconcileCheckoutQuotaCopy(current: string, predecessor: string, candidate: string, journey: string): Buffer {
  const before = [...predecessor.matchAll(checkoutQuotaEntry)];
  const after = [...candidate.matchAll(checkoutQuotaEntry)];
  const expected = journey.split(checkoutQuotaWitness)[1]?.match(/^ {6}en: '([^'\n]+)',\n {6}pl: '([^'\n]+)',/mu);
  assert(expected, "checkout quota journey must specify English and Polish copy");
  assert.equal(before.length, 2);
  assert.equal(after.length, 2);
  let index = 0;
  const reconciled = current.replace(checkoutQuotaEntry, entry => {
    const replacement = after[index]![0];
    assert.equal(entry, before[index++]![0], "checkout quota entry differs from its released bytes");
    assert.notEqual(entry, replacement);
    return replacement;
  });
  assert.equal(index, 2);
  assert.deepEqual([...reconciled.matchAll(checkoutQuotaEntry)].map(match => JSON.parse(match[1]!)),
    expected.slice(1), "reconciled copy must match the journey in both locales");
  assert.equal(reconciled.replace(checkoutQuotaEntry, ""), current.replace(checkoutQuotaEntry, ""));
  return Buffer.from(reconciled);
}

const attemptLimitEffect = /(^ {4}'purchase\.attemptLimits': \{\n(?:(?!^ {4}\},).)*?^ {10}appliesTo: )([^\n]+)/msu;

export const starterSubscriptionOffer = "shared/subscription-offer.ts";

export function reconcileSubscriptionOfferCustomization(app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0]) {
  return reconcileManagedCustomization(app, predecessor, applyRefused, starterSubscriptionOffer,
    "owned/upgrade-notes/subscription-offer.ts", "\n// Adopter offer policy notes.\n");
}

export const starterLifecycle = "lifecycle.mjs";

export function reconcileLifecycleCustomization(app: string, predecessor: string, applyRefused: () => Parameters<typeof assertUpgradeConflict>[0]) {
  const managed = join(app, starterLifecycle);
  const addition = 'process.stderr.write("Adopter lifecycle customization\\n");\n';
  const customized = addition + predecessor;
  writeFileSync(managed, customized);
  assertUpgradeConflict(applyRefused(), starterLifecycle);
  const current = readFileSync(managed, "utf8");
  assert.equal(current, customized, "refused upgrade changed the managed lifecycle");

  const path = "owned/lifecycle-launcher.mjs";
  const bytes = Buffer.from(current.slice(0, addition.length) + 'await import(new URL("../lifecycle.mjs", import.meta.url));\n');
  writeFileSync(join(app, path), bytes, { flag: "wx" });
  writeFileSync(managed, predecessor);
  return { path, bytes };
}

const retiredCatalogueFile = "owned/catalogue.json";
const catalogueScripts = {
  "catalogue:check": "openlup catalogue check --packs ./owned/catalogue.json --json",
  "catalogue:check:source": "openlup catalogue project --trusted-packs ./owned/catalogue.ts --json",
} as const;
function readStarterScripts(bytes: string | undefined): Record<string, unknown> {
  return bytes === undefined ? {} : JSON.parse(bytes).scripts ?? {};
}

export function proveStarterCatalogueWrappers(app: string, scratch: string,
  manifest = readFileSync(join(app, "package.json"), "utf8")): void {
  const scripts = readStarterScripts(readFileSync(join(app, "package.json"), "utf8"));
  const expectedScripts = readStarterScripts(manifest);
  for (const [script, expected] of Object.entries(catalogueScripts)) {
    if (!Object.hasOwn(expectedScripts, script)) {
      assert(!Object.hasOwn(scripts, script), `unexpected starter catalogue script: ${script}`);
      continue;
    }
    const command = scripts[script];
    assert(typeof command === "string" && command === expected, `unexpected starter catalogue script: ${script}`);
    const [, ...args] = command.split(" ");
    const report = JSON.parse(execFileSync(process.execPath, [realpathSync(join(app, "node_modules/.bin/openlup")), ...args], {
      cwd: app, encoding: "utf8", env: { ...isolatedConsumerEnv(), TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    }));
    assert.equal(report.command, script.endsWith(":source") ? "catalogue project" : "catalogue check");
    assert.equal(report.exitCode, 0);
  }
}

export function retiresStarterCatalogue(from: string | undefined, to: string | undefined): boolean {
  const previous = readStarterScripts(from), next = readStarterScripts(to);
  return previous["catalogue:check"] === catalogueScripts["catalogue:check"] &&
    !Object.hasOwn(next, "catalogue:check") && next["catalogue:check:source"] === catalogueScripts["catalogue:check:source"];
}

const starterCatalogueFile = "owned/catalogue.ts";
export function reconcileStarterCatalogue130(previous: string, target: string): string {
  const registry = "export const catalogDraftRegistry = createCatalogProductTypeRegistry(types);";
  const declarations = target.slice(target.indexOf("const pack = "));
  assert(previous.includes(registry) && !previous.includes("export const catalogueConformance")
    && declarations.startsWith("const pack = ") && declarations.includes("export const catalogueConformance"),
    "starter_catalogue_owned_module_reconciliation_required");
  return previous.replace(registry, `import type { CatalogPackInput } from '@openlup/platform/catalog';\n\n${declarations.trimEnd()}`);
}

function assertStarterCatalogueAdmission(app: string, code: string, expectedQueries: number, hasAdopterPack = false): void {
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { applyDemoSeed } from './installation/install.ts';
    import { configurations } from './owned/store.config.ts';
    let queries = 0;
    const connection = { async query(sql) {
      queries++;
      return { rows: sql.startsWith('SELECT session_user') ? [{ login: 'runtime', role: 'runtime' }] : [] };
    } };
    await assert.rejects(applyDemoSeed(Object.values(configurations)[0], {
      connection, installRole: 'installer', runtimeRole: 'runtime',
      catalogueRules: ${hasAdopterPack ? "readFileSync('owned/catalogue-rules.cjs')" : 'undefined'},
    }), { code: ${JSON.stringify(code)} });
    assert.equal(queries, ${expectedQueries});
  `], { cwd: app, env: isolatedConsumerEnv(), stdio: "pipe", timeout: 30_000 });
}

function convertStarterCatalogue130(app: string, target: string): Buffer {
  const path = join(app, starterCatalogueFile);
  const converted = Buffer.from(reconcileStarterCatalogue130(
    readFileSync(path, "utf8"), readFileSync(join(target, starterCatalogueFile), "utf8")));
  writeFileSync(path, converted);
  return converted;
}

export function proveStarterCatalogue130(app: string, target: string): void {
  assertStarterCatalogueAdmission(app, "starter_catalogue_pack_invalid", 0);
  convertStarterCatalogue130(app, target);
  assertStarterCatalogueAdmission(app, "starter_seed_runtime_role_forbidden", 3);
}

export const starterCareJourney = "browser/acquisition.spec.ts";
export const starterCareWitness = "ask_first_offer_only_after_yes";
const careAccount = "client/pages/account.ts";
const careCopy = "owned/copy.ts";
const careSettings = "owned/renewal.config.ts";
export function needsStarterCareUpgrade(from: string, to: string): boolean {
  const oldJourney = join(from, starterCareJourney), newJourney = join(to, starterCareJourney);
  return existsSync(join(to, careCopy)) && existsSync(newJourney)
    && readFileSync(newJourney, "utf8").includes(starterCareWitness)
    && !(existsSync(oldJourney) && readFileSync(oldJourney, "utf8").includes(starterCareWitness));
}

export function mergeStarterCareFile(directory: string, previous: Buffer, local: Buffer, candidate: Buffer) {
  const merge = mkdtempSync(join(directory, "care-reconcile-"));
  try {
    for (const [name, bytes] of [["local", local], ["from", previous], ["to", candidate]] as const) writeFileSync(join(merge, name), bytes);
    const result = spawnSync("git", ["merge-file", "-p", "local", "from", "to"], { cwd: merge, env: isolatedConsumerEnv() });
    assert.ifError(result.error);
    assert.equal(result.status, 0, "starter_care_upgrade_manual_reconciliation_required");
    return result.stdout;
  } finally { rmSync(merge, { recursive: true, force: true }); }
}

type CatalogueBrowser = {
  reference: string;
  localImage?: string | undefined;
  containerArguments(app: string, reference: string, name: string, localImage?: string, mounts?: string[]): string[];
};

const catalogueBrowserReadiness = "/catalogue-browser-readiness";
const catalogueBrowserResult = catalogueBrowserReadiness + "/result.json";
const launchCatalogueBrowser = `
  const { renameSync, writeFileSync } = require("node:fs");
  const report = value => {
    writeFileSync("${catalogueBrowserResult}.tmp", JSON.stringify(value), { mode: 0o600 });
    renameSync("${catalogueBrowserResult}.tmp", "${catalogueBrowserResult}");
  };
  Promise.resolve().then(() => {
    const { chromium } = require("playwright");
    return chromium.launchServer({ host: "127.0.0.1", timeout: 10_000 });
  }).then(server => {
    report({ endpoint: server.wsEndpoint() });
  }, error => {
    report({ error: String(error) });
    setTimeout(() => process.exit(1), 25_000);
  });
`;
const readCatalogueBrowser = `
  const { existsSync, readFileSync } = require("node:fs");
  const { setTimeout: sleep } = require("node:timers/promises");
  (async () => {
    const deadline = Date.now() + 20_000;
    while (!existsSync("${catalogueBrowserResult}")) {
      if (Date.now() >= deadline) return process.stdout.write(JSON.stringify("deadline"));
      await sleep(100);
    }
    process.stdout.write(readFileSync("${catalogueBrowserResult}", "utf8"));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

function refuseCatalogueBrowser(code: string, cause?: unknown): never {
  throw Object.assign(new Error(code, { cause }), { code });
}

/** Exercise the installed recipe on the upgraded app with its target package bytes. */
export function proveInstalledCatalogueUpgrade(app: string, preservedHashes: Record<string, string>, browser?: CatalogueBrowser,
  run: (file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string = execFileSync) {
  const lockfile = join(app, "package-lock.json");
  const retained = readFileSync(lockfile);
  const lock = JSON.parse(retained.toString("utf8"));
  const artifacts: string[] = [];
  let lockRemapped = false, container: string | undefined, failure: { error: unknown } | undefined;
  let readinessDirectory: string | undefined;
  const options = { cwd: app, env: { ...isolatedConsumerEnv(), OPENLUP_STARTER_CATALOGUE_RECIPE_APP: app,
    OPENLUP_STARTER_CATALOGUE_RECIPE_HASHES: JSON.stringify(preservedHashes) },
    stdio: "pipe" as const, encoding: "utf8" as const,
    timeout: 600_000, maxBuffer: 8 * 1024 * 1024 };
  try {
    for (const name of ["core", "outbox", "platform"]) {
      const entry = lock.packages["node_modules/@openlup/" + name];
      assert(typeof entry?.resolved === "string", "Catalogue recipe is missing an installed dependency");
      if (!entry.resolved.startsWith("file:")) continue;
      const bytes = readFileSync(resolve(app, entry.resolved.slice(5)));
      assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), entry.integrity);
      const local = `artifacts/openlup-${name}.tgz`, path = join(app, local);
      if (existsSync(path)) assert.deepEqual(readFileSync(path), bytes, "Catalogue recipe artifact differs from the target lock");
      else { writeFileSync(path, bytes, { flag: "wx" }); artifacts.push(path); }
      if (entry.resolved !== "file:" + local) {
        entry.resolved = "file:" + local;
        lockRemapped = true;
      }
    }
    if (lockRemapped) writeFileSync(lockfile, JSON.stringify(lock) + "\n");
    const recipe = { ...options, env: { ...options.env } as NodeJS.ProcessEnv };
    const dockerOptions = { ...options, timeout: 30_000 };
    if (browser) {
      let url: URL | undefined;
      try {
        const name = "starter-catalogue-browser-" + randomBytes(6).toString("hex");
        readinessDirectory = mkdtempSync(join(tmpdir(), "openlup-catalogue-browser-"));
        const readinessMount = `type=bind,src=${realpathSync(readinessDirectory)},dst=${catalogueBrowserReadiness}`;
        const [action, ...args] = browser.containerArguments(app, browser.reference, name, browser.localImage, ["--mount", readinessMount]);
        container = name;
        run("docker", [action!, "--detach", ...args, "node", "-e", launchCatalogueBrowser], dockerOptions);
        const readiness = JSON.parse(run("docker", ["exec", name, "node", "-e", readCatalogueBrowser], dockerOptions));
        if (readiness !== "deadline") {
          if (readiness?.error) throw new Error(readiness.error);
          const endpoint = typeof readiness?.endpoint === "string" ? URL.parse(readiness.endpoint) : null;
          assert(endpoint?.protocol === "ws:" && endpoint.hostname === "127.0.0.1" && endpoint.port && !endpoint.username && !endpoint.password,
            "Invalid catalogue browser endpoint");
          url = endpoint;
        }
      } catch (error) { refuseCatalogueBrowser("starter_catalogue_browser_startup_failed", error); }
      if (!url) refuseCatalogueBrowser("starter_catalogue_browser_server_not_ready");
      recipe.env.OPENLUP_STARTER_CATALOGUE_RECIPE_WS_ENDPOINT = url.href;
    } else {
      run(process.execPath, [realpathSync(join(app, "node_modules/.bin/playwright")), "install", "chromium"], options);
    }
    const result = run(process.execPath, ["--test", "--test-reporter=spec", "--test-name-pattern=^up_json_installed_starter_recipe$", "test/lifecycle.test.ts"], recipe);
    assert.match(result, /✔ up_json_installed_starter_recipe/u);
    if (browser) console.log(`Catalogue replay operator connected to pinned browser image ${browser.reference}`);
  } catch (error) {
    failure = { error };
  } finally {
    try {
      if (container) run("docker", ["rm", "-f", container], { ...options, timeout: 30_000 });
    } catch (error) {
      failure ??= { error };
    }
    try {
      if (readinessDirectory) rmSync(readinessDirectory, { recursive: true, force: true });
      if (lockRemapped) writeFileSync(lockfile, retained);
      for (const path of artifacts) rmSync(path);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

type UpgradePair = { from: string; to: string; fromVersion: string; toVersion: string; pristine?: boolean; browser?: CatalogueBrowser;
  evidence: { planSha256?: string; customizations?: Record<string, string>;
    managedConflict?: { path: string; action: "create" | "replace" }; phases: { name: string; result: string }[] } };

function proveStarterPair(consumer: string, pair: UpgradePair): () => void {
  const app = pair.from, from = starterUpgradeSnapshot(app, pair.fromVersion), to = starterUpgradeSnapshot(pair.to, pair.toVersion);
  const ownership = JSON.parse(readFileSync(join(app, "ownership.json"), "utf8"));
  const careUpgrade = needsStarterCareUpgrade(app, pair.to);
  const catalogueUpgrade = !pair.pristine && !Object.hasOwn(from.files, "lifecycle-refusals.mjs")
    && Object.hasOwn(to.files, "lifecycle-refusals.mjs");
  const phase = (name: string, action: () => void) => { const entry = { name, result: "FAIL" }; pair.evidence.phases.push(entry); action(); entry.result = "PASS"; };
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const owned: Record<string, Buffer> = {};
  const retireCatalogue = retiresStarterCatalogue(from.files["package.json"], to.files["package.json"]);
  if (retireCatalogue) {
    assert(ownership.owned.includes(retiredCatalogueFile));
    assert(!existsSync(join(pair.to, retiredCatalogueFile)));
    assert(!Object.hasOwn(from.files, retiredCatalogueFile) && !Object.hasOwn(to.files, retiredCatalogueFile));
    owned[retiredCatalogueFile] = readFileSync(join(app, retiredCatalogueFile));
  }
  const catalogue130 = pair.fromVersion === "1.3.0" && retireCatalogue &&
    !readFileSync(join(app, starterCatalogueFile), "utf8").includes("export const catalogueConformance");
  if (catalogue130) owned[starterCatalogueFile] = readFileSync(join(app, starterCatalogueFile));
  const convertCatalogue = () => phase("starter-1.3.0-owned-catalogue-conversion", () => {
    owned[starterCatalogueFile] = convertStarterCatalogue130(app, pair.to);
  });
  let adopterHashes: Record<string, string> | undefined;
  const settingsHost = join(app, starterSettingsHost);
  if (existsSync(settingsHost)) owned[starterSettingsHost] = readFileSync(settingsHost);
  const targetSettings = join(pair.to, starterSettingsHost);
  const previousEffect = attemptLimitEffect.exec(owned[starterSettingsHost]?.toString("utf8") ?? "")?.[2];
  const nextEffect = existsSync(targetSettings) ? attemptLimitEffect.exec(readFileSync(targetSettings, "utf8"))?.[2] : undefined;
  const nextQuotaJourney = to.files[checkoutQuotaJourney];
  const reconcileQuotaCopy = pair.fromVersion === "1.3.0" && nextQuotaJourney?.includes(checkoutQuotaWitness)
    && !from.files[checkoutQuotaJourney]?.includes(checkoutQuotaWitness);
  const copyPath = join(app, starterCheckoutCopy);
  const previousQuotaCopy = reconcileQuotaCopy ? readFileSync(copyPath, "utf8") : undefined;
  const predecessorSettings = careUpgrade ? owned[starterSettingsHost] : undefined;
  const predecessorCopy = careUpgrade ? readFileSync(join(app, careCopy)) : undefined;
  phase("migrate-owned-contracts", () => { migrateStarterOwned(app, pair.to, from, to); });
  if (!pair.pristine) phase("customize-owned", () => {
    for (const [path, before, after] of [
      ["owned/store.config.ts", "#3d6657", "#663d57"],
      ["owned/fragments.ts", "offer-intro", "adopter-offer-intro"],
    ] as const) {
      assert(ownership.owned.includes(path) && !Object.hasOwn(from.files, path) && !Object.hasOwn(to.files, path));
      const original = readFileSync(join(app, path), "utf8"); assert(original.includes(before));
      writeFileSync(join(app, path), original.replaceAll(before, after)); owned[path] = readFileSync(join(app, path));
    }
    if (previousQuotaCopy !== undefined || predecessorCopy) {
      assert(ownership.owned.includes(starterCheckoutCopy));
      assert(!Object.hasOwn(from.files, starterCheckoutCopy) && !Object.hasOwn(to.files, starterCheckoutCopy));
      const original = previousQuotaCopy ?? predecessorCopy!.toString("utf8");
      const local = original.replace('    cart: "Cart",', '    cart: "Your local basket",');
      assert.notEqual(local, original);
      owned[starterCheckoutCopy] = Buffer.from(local);
      writeFileSync(copyPath, owned[starterCheckoutCopy]);
    }
    if (careUpgrade) {
      const path = join(app, careSettings), previous = readFileSync(path, "utf8");
      const local = previous.replace("defaultOffer: 'pause'", "defaultOffer: 'skip'");
      assert.notEqual(local, previous);
      owned[careSettings] = Buffer.from(local);
      writeFileSync(path, owned[careSettings]);
    }
    if (retireCatalogue) {
      owned[retiredCatalogueFile] = Buffer.concat([owned[retiredCatalogueFile]!, Buffer.from("\n")]);
      writeFileSync(join(app, retiredCatalogueFile), owned[retiredCatalogueFile]!);
    }
    if (catalogueUpgrade) {
      if (catalogue130) convertCatalogue();
      const skeleton = join(pair.to, "node_modules/@openlup/core/docs/guide/how-to/extend/catalogue-pack-skeleton");
      adopterHashes = catalogueUpgradeFixture(app, skeleton);
      for (const path of Object.keys(adopterHashes)) {
        assert(!Object.hasOwn(from.files, path) && !Object.hasOwn(to.files, path), "Adopter pack files must stay owned");
        owned[path] = readFileSync(join(app, path));
      }
    }
    pair.evidence.customizations = Object.fromEntries(Object.entries(owned).map(([path, bytes]) => [path, hash(bytes)]));
    assertCompleteStarter(app, from);
  });
  const workspace = mkdtempSync(join(consumer, "distribution-cli-proof-"));
  const executable = join(consumer, "node_modules/.bin/openlup");
  const writeSnapshots = () => {
    for (const [name, snapshot] of [["from", from], ["to", to]] as const)
      writeFileSync(join(workspace, `${name}.json`), JSON.stringify(snapshot));
  };
  writeSnapshots();
  const options = ["--root", app, "--from", join(workspace, "from.json"), "--to", join(workspace, "to.json"), "--schema-version", "0", "--json"];
  const run = (command: string, expected = 0) => {
    const result = spawnSync(executable, ["upgrade", command, ...options], { cwd: app, env: isolatedConsumerEnv(), encoding: "utf8" });
    assert.ifError(result.error); assert.equal(result.status, expected, result.stderr || result.stdout); assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout); assert.equal(report.exitCode, expected);
    if (Object.hasOwn(report, "conflicts")) {
      assert(Array.isArray(report.conflicts));
      if (report.plan) assert(!Object.hasOwn(report.plan, "conflicts"));
    } else if (report.plan) {
      // Released targets predating UG-140 put plan conflicts inside the projection.
      assert(Array.isArray(report.plan.conflicts));
    }
    return report;
  };
  const paths = new Set<string>([...Object.keys(from.files), ...Object.keys(to.files), ...ownership.owned, ...Object.keys(adopterHashes ?? {})]);
  const readFiles = () => [...paths].map(path => existsSync(join(app, path)) ? readFileSync(join(app, path)) : null);
  let plan: ReturnType<typeof run>;
  phase("plan", () => {
    const before = readFiles();
    plan = run("plan");
    pair.evidence.planSha256 = hash(JSON.stringify(plan));
    assert.deepEqual(readFiles(), before, "planning wrote application files");
  });
  let changed = plan.files.filter((file: { action: string }) => ["replace", "create"].includes(file.action));
  assert(changed.length > 0, "upgrade_pair_has_no_replacements");
  const reminderTestReplaced = changed.some((file: { path: string; action: string }) =>
    file.path === reminderInstallationTest && file.action === "replace");
  const editorReplacement = changed.find((file: { path: string; action: string }) =>
    file.path === starterEditorPorts && file.action === "replace");
  const lifecycleReplaced = changed.some((file: { path: string; action: string }) =>
    file.path === starterLifecycle && file.action === "replace");
  const displayReplacements = starterDisplayFiles.filter(path =>
    !(careUpgrade && !pair.pristine && path === careAccount) &&
    changed.some((file: { path: string; action: string }) => file.path === path && file.action === "replace"));
  const documentReplacements = starterDocumentFiles.filter(path =>
    changed.some((file: { path: string; action: string }) => file.path === path && file.action === "replace"));
  const checkoutChanges = starterCheckoutFiles.filter(path =>
    changed.some((file: { path: string }) => file.path === path));
  const checkoutHostReplacement = checkoutChanges.find(path => path.startsWith("host/") && Object.hasOwn(from.files, path));
  const offerReplaced = changed.some((file: { path: string; action: string }) =>
    file.path === starterSubscriptionOffer && file.action === "replace");
  const { path: conflict, action } = editorReplacement ?? changed.findLast((file: { action: string }) => file.action === "create") ?? changed.at(-1);
  const applyRefused = () => {
    const before = readFiles();
    const report = run("apply", 1);
    assert.deepEqual(readFiles(), before, "conflict wrote application files");
    return report;
  };
  if (!pair.pristine) phase("managed-conflict", () => {
    pair.evidence.managedConflict = { path: conflict, action };
    if (editorReplacement) {
      const local = reconcileEditorCustomization(app, from.files[starterEditorPorts]!, applyRefused);
      owned[local.path] = local.bytes;
      pair.evidence.customizations![local.path] = hash(local.bytes);
      assert.deepEqual(run("plan"), plan);
      return;
    }
    const original = existsSync(join(app, conflict)) ? readFileSync(join(app, conflict)) : null;
    mkdirSync(dirname(join(app, conflict)), { recursive: true });
    writeFileSync(join(app, conflict), "adopter-managed-divergence");
    assertUpgradeConflict(applyRefused(), conflict);
    if (original) writeFileSync(join(app, conflict), original); else rmSync(join(app, conflict));
  });
  if (!pair.pristine && lifecycleReplaced) phase("lifecycle-reconciliation", () => {
    const local = reconcileLifecycleCustomization(app, from.files[starterLifecycle]!, applyRefused);
    owned[local.path] = local.bytes;
    pair.evidence.customizations![local.path] = hash(local.bytes);
    assert.deepEqual(run("plan"), plan);
  });
  for (const path of pair.pristine ? [] : displayReplacements) phase(`display-reconciliation:${path}`, () => {
    const local = reconcileDisplayCustomization(app, from.files[path]!, applyRefused, path);
    owned[local.path] = local.bytes;
    pair.evidence.customizations![local.path] = hash(local.bytes);
    assert.deepEqual(run("plan"), plan);
  });
  for (const path of pair.pristine ? [] : documentReplacements) phase(`document-reconciliation:${path}`, () => {
    const local = reconcileDocumentCustomization(app, from.files[path]!, applyRefused, path);
    owned[local.path] = local.bytes;
    pair.evidence.customizations![local.path] = hash(local.bytes);
    assert.deepEqual(run("plan"), plan);
  });
  if (!pair.pristine && checkoutHostReplacement) phase("checkout-host-reconciliation", () => {
    const local = reconcileManagedCustomization(app, from.files[checkoutHostReplacement]!, applyRefused,
      checkoutHostReplacement, "owned/upgrade-notes/checkout.ts", "\n// Adopter checkout policy.\n");
    owned[local.path] = local.bytes;
    pair.evidence.customizations![local.path] = hash(local.bytes);
    assert.deepEqual(run("plan"), plan);
  });
  if (!pair.pristine && offerReplaced) phase("subscription-offer-reconciliation", () => {
    const local = reconcileSubscriptionOfferCustomization(app, from.files[starterSubscriptionOffer]!, applyRefused);
    owned[local.path] = local.bytes;
    pair.evidence.customizations![local.path] = hash(local.bytes);
    assert.deepEqual(run("plan"), plan);
  });
  if (!pair.pristine && reminderTestReplaced) phase("reminder-test-reconciliation", () => {
    const local = reconcileReminderInstallationTest(app, from.files[reminderInstallationTest]!, () => {
      const before = starterUpgradeSnapshot(app, pair.fromVersion);
      const report = run("apply", 1);
      assert.deepEqual(starterUpgradeSnapshot(app, pair.fromVersion), before, "conflict wrote managed files");
      return report;
    });
    const bytes = Buffer.from(local.bytes);
    owned[local.path] = bytes;
    pair.evidence.customizations![local.path] = hash(bytes);
  });
  if (!pair.pristine && Object.hasOwn(from.files, starterAgentGuide)) phase("agent-guide-reconciliation", () => {
    const local = reconcileStarterAgentGuide(app, from, to, applyRefused);
    owned[local.path] = local.bytes;
    pair.evidence.customizations![local.path] = hash(local.bytes);
    writeSnapshots();
    plan = run("plan");
    changed = plan.files.filter((file: { action: string }) => ["replace", "create"].includes(file.action));
    pair.evidence.planSha256 = hash(JSON.stringify(plan));
  });
  if (!pair.pristine && Object.hasOwn(to.files, starterSettingsHost)) phase("settings-host-reconciliation", () => {
    const local = Buffer.from(readFileSync(join(pair.to, starterSettingsHost), "utf8") + "\n// Adopter settings bindings.\n");
    writeFileSync(join(app, starterSettingsHost), local, { flag: "wx" });
    assertUpgradeConflict(applyRefused(), starterSettingsHost);
    includeSettingsHost(app, pair.to, to);
    writeFileSync(join(workspace, "to.json"), JSON.stringify(to));
    plan = run("plan");
    changed = plan.files.filter((file: { action: string }) => ["replace", "create"].includes(file.action));
    owned[starterSettingsHost] = local;
    pair.evidence.customizations![starterSettingsHost] = hash(local);
    pair.evidence.planSha256 = hash(JSON.stringify(plan));
  });
  if (!pair.pristine && careUpgrade) phase("care-account-reconciliation", () => {
    const path = join(app, careAccount), before = Buffer.from(from.files[careAccount]!);
    const local = Buffer.from(before.toString().replace("context.t('subscriptions'))", "context.t('subscriptions')), el('p', { id: 'adopter-care' }, 'Local care portal')"));
    assert.notDeepEqual(local, before);
    writeFileSync(path, local); assertUpgradeConflict(applyRefused(), careAccount);
    const merged = mergeStarterCareFile(workspace, before, local, Buffer.from(to.files[careAccount]!));
    writeFileSync(path, merged);
    owned[careAccount] = merged;
    pair.evidence.customizations![careAccount] = hash(merged);
    for (const snapshot of [from, to]) {
      delete snapshot.files[careAccount];
      const inventory = JSON.parse(snapshot.files["ownership.json"]!);
      inventory.managed = inventory.managed.filter((file: string) => file !== careAccount);
      inventory.owned.push(careAccount);
      snapshot.files["ownership.json"] = JSON.stringify(inventory, null, 2) + "\n";
    }
    writeFileSync(join(app, "ownership.json"), from.files["ownership.json"]!);
    writeSnapshots();
    plan = run("plan");
    changed = plan.files.filter((file: { action: string }) => ["replace", "create"].includes(file.action));
    pair.evidence.planSha256 = hash(JSON.stringify(plan));
  });
  const catalogueOwned = () => ({
    ...Object.fromEntries((ownership.owned as string[])
      .filter(path => !Object.hasOwn(from.files, path) && !Object.hasOwn(to.files, path) && existsSync(join(app, path)))
      .map(path => [path, hash(readFileSync(join(app, path)))])),
    ...catalogueUpgradeFixture(app),
  });
  const beforeCatalogueApply = catalogueUpgrade ? catalogueOwned() : undefined;
  phase("interrupt-and-refuse", () => {
    const preload = join(workspace, "interrupt.mjs");
    writeFileSync(preload, 'import { promises as fs } from "node:fs"; const rename = fs.rename.bind(fs); fs.rename = async (...args) => { await rename(...args); process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };');
    const killed = spawnSync(process.execPath, ["--import", preload, executable, "upgrade", "apply", ...options], { cwd: app, env: isolatedConsumerEnv() });
    assert.ifError(killed.error); assert.equal(killed.signal, "SIGKILL");
    assert.equal(readFileSync(join(app, changed[0].path), "utf8"), to.files[changed[0].path]);
    assert.throws(() => assertCompleteStarter(app, to), /incomplete_application_upgrade/);
  });
  const checkUpgradeFiles = () => {
    for (const [path, bytes] of Object.entries(owned))
      assert.deepEqual(readFileSync(join(app, path)), bytes, `owned customization changed: ${path}`);
    if (reminderTestReplaced)
      assert.equal(readFileSync(join(app, reminderInstallationTest), "utf8"), to.files[reminderInstallationTest]);
    if (editorReplacement)
      assert.equal(readFileSync(join(app, starterEditorPorts), "utf8"), to.files[starterEditorPorts]);
    if (lifecycleReplaced)
      assert.equal(readFileSync(join(app, starterLifecycle), "utf8"), to.files[starterLifecycle]);
    if (offerReplaced)
      assert.equal(readFileSync(join(app, starterSubscriptionOffer), "utf8"), to.files[starterSubscriptionOffer]);
    for (const path of displayReplacements)
      assert.equal(readFileSync(join(app, path), "utf8"), to.files[path]);
    for (const path of checkoutChanges)
      assert.equal(readFileSync(join(app, path), "utf8"), to.files[path]);
    for (const path of documentReplacements)
      assert.equal(readFileSync(join(app, path), "utf8"), to.files[path]);
  };
  phase("resume", () => {
    const resumed = run("apply");
    assert(resumed.files.some((file: { action: string }) => file.action === "already-applied"));
    if (careUpgrade) assert(resumed.applied.length > 0, "care upgrade resume must write remaining files");
    checkUpgradeFiles();
  });
  phase("replay", () => {
    assert.deepEqual(run("apply").applied, []); checkUpgradeFiles();
    if (beforeCatalogueApply) assert.deepEqual(catalogueOwned(), beforeCatalogueApply, "Managed apply changed owned bytes");
  });
  if (!pair.pristine && previousEffect && nextEffect && previousEffect !== nextEffect) phase("checkout-attempt-effect-reconciliation", () => {
    const current = readFileSync(settingsHost, "utf8");
    assert.equal(attemptLimitEffect.exec(current)?.[2], previousEffect);
    const reconciled = Buffer.from(current.replace(attemptLimitEffect, (_, prefix) => prefix + nextEffect));
    writeFileSync(settingsHost, reconciled);
    owned[starterSettingsHost] = reconciled;
    pair.evidence.customizations![starterSettingsHost] = hash(reconciled);
    assert.deepEqual(run("apply").applied, []);
    checkUpgradeFiles();
  });
  if (previousQuotaCopy !== undefined && nextQuotaJourney && !pair.pristine) phase("checkout-attempt-copy-reconciliation", () => {
    const current = readFileSync(copyPath, "utf8");
    const target = readFileSync(join(pair.to, starterCheckoutCopy), "utf8");
    const reconciled = reconcileCheckoutQuotaCopy(current, previousQuotaCopy, target, nextQuotaJourney);
    writeFileSync(copyPath, reconciled);
    owned[starterCheckoutCopy] = reconciled;
    pair.evidence.customizations![starterCheckoutCopy] = hash(reconciled);
    assert.deepEqual(run("apply").applied, []);
    checkUpgradeFiles();
  });
  if (predecessorCopy) phase("care-owned-reconciliation", () => {
    const target = readFileSync(join(pair.to, careCopy));
    const copy = pair.pristine ? target : mergeStarterCareFile(workspace, predecessorCopy, readFileSync(copyPath), target);
    assert.doesNotMatch(copy.toString(), /\b(?:careGuidance|confirmCancel):/u);
    writeFileSync(copyPath, copy); owned[careCopy] = copy;
    if (predecessorSettings) {
      const target = readFileSync(targetSettings);
      const merged = pair.pristine ? target : mergeStarterCareFile(workspace, predecessorSettings, readFileSync(settingsHost), target);
      writeFileSync(settingsHost, merged); owned[starterSettingsHost] = merged;
    }
    // Apply the adopter rename from packages/core/changes/starter-settings-stage1-fixes.md.
    for (const path of ["owned/store.config.ts", starterSettingsHost]) {
      const installed = join(app, path), before = readFileSync(installed, "utf8");
      const after = before.replace(/(['"])damaged_item\1/gu, "$1damaged$1");
      if (after === before) continue;
      writeFileSync(installed, after); owned[path] = Buffer.from(after);
      if (pair.evidence.customizations?.[path]) pair.evidence.customizations[path] = hash(after);
    }
    if (!pair.pristine) pair.evidence.customizations![careCopy] = hash(copy);
    assert.deepEqual(run("apply").applied, []); checkUpgradeFiles();
  });
  if (catalogue130) {
    checkUpgradeFiles();
    if (!catalogueUpgrade) convertCatalogue();
  }
  rmSync(workspace, { recursive: true, force: true });
  return () => phase("installed-application-and-owned-bytes", () => {
    assertCompleteStarter(app, to); checkUpgradeFiles();
    if (catalogue130) phase("starter-1.3.0-installer-admission", () => {
      // Target packages are installed here. The role refusal witnesses a completed catalogue admission.
      assertStarterCatalogueAdmission(app, "starter_seed_runtime_role_forbidden", 3, catalogueUpgrade);
    });
    if (to.files["package.json"]?.includes('"catalogue:check:source"'))
      proveStarterCatalogueWrappers(app, dirname(app), to.files["package.json"]);
    if (Object.hasOwn(to.files, "lifecycle-refusals.mjs")) {
      assert(!Object.keys(to.files).some(path => path.startsWith(".context/catalogue-builds/")));
      const table = JSON.parse(execFileSync(process.execPath, [starterLifecycle, "refusals", "--json"],
        { cwd: app, env: isolatedConsumerEnv(), encoding: "utf8" }));
      assert.equal(typeof table.starter_catalogue_build_missing?.fix, "string");
    }
    if (retireCatalogue) phase("starter-catalogue-guided-consolidation", () => {
      if (!pair.pristine) renameSync(join(app, retiredCatalogueFile), join(app, "owned/catalogue-archive.json"));
      else rmSync(join(app, retiredCatalogueFile));
      assert(!existsSync(join(app, retiredCatalogueFile)));
      if (!pair.pristine) assert.deepEqual(readFileSync(join(app, "owned/catalogue-archive.json")), owned[retiredCatalogueFile]);
    });
    if (catalogueUpgrade) phase("installed-catalogue-build-replay", () => {
      assert(adopterHashes && beforeCatalogueApply);
      const before = catalogueOwned();
      const expected = Object.fromEntries(Object.keys(adopterHashes).map(path => [path, beforeCatalogueApply[path]!]));
      proveInstalledCatalogueUpgrade(app, expected, pair.browser);
      assert.deepEqual(catalogueOwned(), before, "Catalogue replay changed upgraded owned bytes");
    });
  });
}

// CLI refusal reports can omit the command-specific payload. The assertions
// below still require the fields that each exercised command must produce.
type CliReport = {
  formatVersion: number;
  exitCode: number;
  state: string;
  // The wire includes CLI-originated failures as well as readiness findings.
  findings?: readonly (Pick<AppVerificationFinding, "observed" | "cause" | "fix" | "recheck" | "evidence"> & { code: string })[];
  files?: readonly (AppUpgradePlan["files"][number] & { ownership: string })[];
  ownership?: { unlisted: string };
  applied?: readonly string[];
  plan?: Omit<AppUpgradePlan, "conflicts">;
  conflicts?: AppUpgradePlan["conflicts"];
};

export function proveDistributionCliConsumer(consumer: string, pair?: UpgradePair): void | (() => void) {
  if (pair) return proveStarterPair(consumer, pair);
  const executable = join(consumer, "node_modules/.bin/openlup");
  const root = join(consumer, "distribution-cli-proof");
  mkdirSync(root);
  function run(args: string[], expected: number) {
    const result = spawnSync(executable, args, {
      cwd: root, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 60_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  function json(args: string[], expected: number) {
    const report: CliReport = JSON.parse(run([...args, "--json"], expected));
    assert.equal(report.formatVersion, 1);
    assert.equal(report.exitCode, expected);
    return report;
  }
  try {
    assert.match(run(["--help"], 0), /No SQL, package installation or hooks/);
    assert.equal(json(["verify"], 2).state, "unknown");
    assert.equal(json(["verify", "--unexpected"], 64).state, "refused");
    assert.equal(json(["verify", "--app", ""], 64).state, "refused");
    assert.equal(json(["verify", "--app", "missing.mjs"], 74).state, "failed");
    assert.equal(json(["verify", "--app", "missing.mjs"], 74).findings?.[0]?.observed, "The --app module could not be loaded; raw application errors are withheld.");

    writeFileSync(join(root, "state.json"), JSON.stringify({ binder: false, schema: "previous", schedule: false }));
    writeFileSync(join(root, "app.mjs"), `
import { readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url), "utf8"));
const run = () => { throw Error("An effect must never be invoked by diagnosis"); };
export function createVerificationInput() {
 const schema = {version:"current",migration:"app-migrations/current.sql",objects:[{kind:"table",name:"public.orders"}]};
 return {
  candidate:{artifact:"app-1",configuration:"configuration-1",environment:"local",database:"local-db",schema:"current"},
  inventoryComplete:true,
  loadedPackages:[{name:"@openlup/core",version:"0.36.0",kind:"kernel"},{name:"@openlup/platform",version:"0.36.0",kind:"rail",modules:["commerce"]}],
  contributions:[{manifest:{name:"@openlup/platform",version:"0.36.0",kind:"rail",module:{id:"commerce",kind:"capability",provides:["./commerce"],dependsOn:[]},emits:[],handles:[],env:[],routes:["orders"],requiredPorts:["orders"],schedules:[{id:"order-expiry",cadenceSeconds:60}],requiredSchema:schema},handlers:[],routes:[{id:"orders",handle:run}],schedules:[{id:"order-expiry",cadenceSeconds:60,run}]}],
  vocabulary:[],exemptions:[],bindings:{ports:state.binder?{"@openlup/platform/commerce:orders":{read:run}}:{},triggers:state.schedule?{"@openlup/platform/commerce:order-expiry":run}:{},routes:{"@openlup/platform/commerce:orders":run},env:{}},
  schemaProbe:{observe:async requirement=>({database:"local-db",version:state.schema,objects:requirement.objects.map(object=>({object,present:true}))})},
 };
}
`);
    const filesBefore = readdirSync(root).sort();
    const report = json(["verify", "--app", "./app.mjs"], 1);
    assert.deepEqual(readdirSync(root).sort(), filesBefore, "diagnosis created a file");
    assert(report.findings);
    assert.deepEqual(report.findings.map(item => item.code).sort(), ["OPENLUP_E_PORT_MISSING", "OPENLUP_E_SCHEDULE_UNBOUND", "OPENLUP_E_SCHEMA_BEHIND"]);
    for (const finding of report.findings) {
      for (const field of ["observed", "cause", "fix", "recheck"] as const) assert.equal(typeof finding[field], "string");
      assert.deepEqual(Object.keys(finding.evidence), ["declared", "bound", "checked", "unknown"]);
      assert.equal(finding.recheck, "openlup verify --app './app.mjs' --json");
    }
    const text = run(["verify", "--app", "./app.mjs"], 1);
    for (const finding of report.findings) assert(text.includes(finding.fix));
    // Repairs use the exact binding keys and migration identity named by the report.
    assert(report.findings.find(item => item.code === "OPENLUP_E_PORT_MISSING")?.fix.includes('bindings.ports["@openlup/platform/commerce:orders"]'));
    assert(report.findings.find(item => item.code === "OPENLUP_E_SCHEDULE_UNBOUND")?.fix.includes('bindings.triggers["@openlup/platform/commerce:order-expiry"]'));
    assert(report.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND")?.fix.includes("app-migrations/current.sql"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ binder: true, schema: "current", schedule: true }));
    assert.equal(json(["verify", "--app", "./app.mjs"], 0).state, "ready");
    writeFileSync(join(root, "state.json"), JSON.stringify({ binder: true, schema: null, schedule: true }));
    const unknown = json(["verify", "--app", "./app.mjs"], 2);
    assert.equal(unknown.state, "unknown");
    assert(unknown.findings?.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND")?.evidence.checked.includes("Unknown"));
    writeFileSync(join(root, "bad-app.mjs"), 'throw Error("synthetic-private-detail");');
    assert(!run(["verify", "--app", "./bad-app.mjs", "--json"], 74).includes("synthetic-private-detail"));
    for (const [source, expectedObserved, expectedFix] of [
      ["export const = 1;", "The --app module could not be loaded; raw application errors are withheld.", "resolves its imports and evaluates without top-level errors"],
      ['throw new TypeError("synthetic-private-detail");', "The --app module could not be loaded; raw application errors are withheld.", "resolves its imports and evaluates without top-level errors"],
      ['export const createVerificationInput = "synthetic-private-detail";', "The loaded --app module does not export a createVerificationInput() function.", "Export a createVerificationInput() function"],
      ['export function createVerificationInput() { throw new SyntaxError("synthetic-private-detail"); }', "createVerificationInput() failed while assembling observations; raw application errors are withheld.", "assembles read-only ReadinessInput observations"],
      ['export async function createVerificationInput() { throw new TypeError("synthetic-private-detail"); }', "createVerificationInput() failed while assembling observations; raw application errors are withheld.", "assembles read-only ReadinessInput observations"],
    ] as const) {
      writeFileSync(join(root, "bad-app.mjs"), source);
      const failure = run(["verify", "--app", "./bad-app.mjs", "--json"], 74);
      const parsed: CliReport = JSON.parse(failure);
      assert.equal(parsed.formatVersion, 1);
      assert.equal(parsed.state, "failed");
      assert.equal(parsed.exitCode, 74);
      const finding = parsed.findings?.[0];
      assert(finding);
      assert.equal(finding.code, "OPENLUP_E_CLI_FAILURE");
      assert.equal(finding.observed, expectedObserved);
      assert(finding.fix.includes(expectedFix));
      assert(!failure.includes("synthetic-private-detail"));
      const failureText = run(["verify", "--app", "./bad-app.mjs"], 74);
      assert(failureText.includes(expectedObserved));
      assert(failureText.includes(expectedFix));
      assert(!failureText.includes("synthetic-private-detail"));
    }

    // The harness prepares real published packages before invoking the CLI.
    // Upgrade never extracts/installs packages; it changes only explicit app files.
    preparePublishedReleases(root);
    const app = join(root, "application");
    mkdirSync(app);
    const snapshot = (version: string) => ({ version, schema: { min: 1, max: 1 }, files: {
      "a.mjs": `
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const version = ${JSON.stringify(version)};
const release = new URL("../releases/"+version+"/", import.meta.url);
const installed = JSON.parse(readFileSync(new URL("node_modules/@openlup/platform/package.json",release),"utf8"));
const core = JSON.parse(readFileSync(new URL("node_modules/@openlup/core/package.json",release),"utf8"));
const application = JSON.parse(readFileSync(new URL("./b.json",import.meta.url),"utf8"));
if (installed.version !== version || core.version !== version || application.dependencies["@openlup/platform"] !== version || application.dependencies["@openlup/core"] !== version) throw Error("incomplete_application_upgrade");
const require = createRequire(new URL("package.json",release));
const {planAppUpgrade} = await import(pathToFileURL(require.resolve("@openlup/platform/lifecycle")).href);
const snapshot = {version:installed.version,schema:{min:1,max:1},files:{}};
const plan = await planAppUpgrade({root:fileURLToPath(new URL("./",import.meta.url)).replace(/\\/$/,""),from:snapshot,to:snapshot,schemaVersion:1});
console.log(JSON.stringify({installedVersion:installed.version,coreVersion:core.version,executedVersion:plan.fromVersion}));
`,
      "b.json": JSON.stringify({ private: true, type: "module", dependencies: { "@openlup/core": version, "@openlup/platform": version } }),
      "theme.css": "original",
    } });
    const from = snapshot(publishedReleases[0].version), to = snapshot(publishedReleases[1].version);
    const executeApp = () => JSON.parse(execFileSync(process.execPath, [join(app, "a.mjs")], { cwd: root, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }));
    for (const [file, content] of Object.entries(from.files)) writeFileSync(join(app, file), content);
    writeFileSync(join(app, "theme.css"), "local-theme");
    writeFileSync(join(app, "owned.txt"), "local-policy");
    assert.deepEqual(executeApp(), { installedVersion: "0.35.0", coreVersion: "0.35.0", executedVersion: "0.35.0" });
    writeFileSync(join(root, "from.json"), JSON.stringify(from));
    writeFileSync(join(root, "to.json"), JSON.stringify(to));
    const options = ["--root", app, "--from", "from.json", "--to", "to.json", "--schema-version", "1"];
    writeFileSync(join(root, "malformed.json"), "{");
    const malformed = json(["upgrade", "plan", ...options.map(value => value === "from.json" ? "malformed.json" : value)], 64);
    assert.equal(malformed.state, "refused");
    assert.deepEqual(malformed.conflicts, []);
    const before = () => Object.fromEntries(readdirSync(app).sort().map(name => [name, readFileSync(join(app, name), "utf8")]));
    const original = before();
    const plan = json(["upgrade", "plan", ...options], 0);
    assert.deepEqual(before(), original);
    assert.deepEqual(plan.conflicts, []);
    assert(plan.plan && !Object.hasOwn(plan.plan, "conflicts"));
    assert.equal(plan.files?.find(item => item.path === "theme.css")?.ownership, "locally-customizable");
    assert.equal(plan.ownership?.unlisted, "application-owned");
    writeFileSync(join(app, "b.json"), "divergent");
    const divergent = before();
    const refused = json(["upgrade", "apply", ...options], 1);
    assertUpgradeConflict(refused, "b.json");
    assert(!Object.hasOwn(refused, "plan"));
    assert.deepEqual(before(), divergent, "a later sorted conflict must prevent the earlier write");
    writeFileSync(join(app, "b.json"), from.files["b.json"]);
    const preload = join(root, "interrupt.mjs");
    writeFileSync(preload, 'import { promises as fs } from "node:fs"; const rename = fs.rename.bind(fs); fs.rename = async (...args) => { await rename(...args); process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };');
    const killed = spawnSync(process.execPath, ["--import", preload, executable, "upgrade", "apply", ...options, "--json"], { cwd: root, env: isolatedConsumerEnv(), timeout: 60_000 });
    assert.ifError(killed.error);
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(readFileSync(join(app, "a.mjs"), "utf8"), to.files["a.mjs"]);
    assert.throws(executeApp, /incomplete_application_upgrade/);
    const resumed = json(["upgrade", "apply", ...options], 0);
    assert.deepEqual(resumed.applied, ["b.json"]);
    const replay = json(["upgrade", "apply", ...options], 0);
    for (const completed of [resumed, replay]) {
      assert.deepEqual(completed.conflicts, []);
      assert(completed.plan && !Object.hasOwn(completed.plan, "conflicts"));
    }
    assert.deepEqual(replay.applied, []);
    assert.equal(readFileSync(join(app, "theme.css"), "utf8"), "local-theme");
    assert.equal(readFileSync(join(app, "owned.txt"), "utf8"), "local-policy");
    assert.deepEqual(executeApp(), { installedVersion: "0.36.0", coreVersion: "0.36.0", executedVersion: "0.36.0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Smoke the installed starter script; command semantics belong to package unit tests. */
export function proveSettingsDiscovery(app: string, execute = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, env: isolatedConsumerEnv(), encoding: "utf8" })): void {
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  assert.equal(manifest.scripts?.settings, "openlup settings --app ./owned/settings-host.ts", "extracted starter settings script missing");
  assert(existsSync(join(app, starterSettingsHost)), "extracted starter settings host missing");
  // Run the script's own command line through the installed binary's absolute path.
  const [binary, ...scriptArgs] = String(manifest.scripts.settings).split(" ");
  const executable = join(app, "node_modules/.bin", binary!);
  const checked = JSON.parse(execute(executable, [...scriptArgs, "check", "--json"], app));
  assert.equal(checked.schemaVersion, 1);
  assert.equal(checked.state, "checked");
  assert.equal(checked.appValidation.state, "passed");
  const stock = checked.rows.find((row: { key: string }) => row.key === "inventory_renewal_protection");
  assert.equal(stock?.file.state, "present");
  assert.deepEqual(stock?.file.location, { file: "owned/store.config.ts", symbol: "inventory.renewalProtection" });
  assert.deepEqual(stock?.validation, { state: "valid" });
  assert.deepEqual(stock?.store, { state: "not-checked" });
  assert.match(execute(executable, [...scriptArgs, "list", "--goal", "free shipping"], app), /^offer\.freeShippingFromMinor \(/mu);
  for (const key of [
    "offer.freeShippingFromMinor", "offer.subscriptionDiscountBps", "purchase.reservationMinutes",
    "subscriptionCreation.editWindowHours", "subscriptionOffers.deliveryCycles", "subscriptions.lifecycleNoticeRetryBudget",
  ]) {
    assert.equal(checked.rows.find((row: { key: string }) => row.key === key)?.validation.state, "valid", key);
  }
}

/** One offline MCP session against the installed binary. */
export function proveSettingsMcp(app: string, environment = isolatedConsumerEnv(), options?: { timeoutMs: number }) {
  const deadline = options && performance.now() + options.timeoutMs;
  const directory = mkdtempSync(join(app, ".settings-mcp-"));
  try {
    const appPath = join(directory, "logging-app.mjs");
    writeFileSync(appPath, `import { createSettingsBindings as bind } from "../${starterSettingsHost}";
export function createSettingsBindings(input) {
  console.log("app console log");
  process.stdout.write("app stdout log\\n");
  return bind(input);
}
`);
    const request = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const toolCall = (id: number, name: string, args = {}) => request(id, "tools/call", { name: `settings_${name}`, arguments: args });
    const key = "offer.freeShippingFromMinor";
    const nestedValue = "[".repeat(16000) + "null" + "]".repeat(16000);
    const malformedUtf8 = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"ping","id":"'),
      Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const init = request(2, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "packed-test", version: "1" } });
    const frames = [
      request(1, "initialize", { protocolVersion: "2025-06-18" }), init,
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      request(3, "tools/list"),
      toolCall(4, "list", { goal: "free shipping" }), toolCall(5, "show", { key }), toolCall(6, "explain", { keyOrCode: key }),
      toolCall(7, "check"), toolCall(8, "preview", { key: "inventory_renewal_protection", value: null }),
      "{", request(9, "unknown", []), toolCall(10, "show", { key, app: "ignored" }), toolCall(11, "show", { key: 1 }),
      toolCall(12, "unknown"), "x".repeat(1024 * 1024 + 1), request(13, "ping"),
      `{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"settings_preview","arguments":{"key":"inventory_renewal_protection","value":${nestedValue}}}}`,
      request(15, "ping"), malformedUtf8, request(16, "ping"),
    ];
    const executable = join(app, "node_modules/.bin/openlup");
    const timeoutError = (step: string) => new Error(
      `Settings MCP step "${step}" exceeded the shared ${options?.timeoutMs} ms subprocess deadline. Check the packed CLI's settings mcp handler for a stall.`,
    );
    const run = (step: string, args: readonly string[], input: string | Buffer) => {
      const remaining = deadline === undefined ? undefined : Math.ceil(deadline - performance.now());
      if (remaining !== undefined && remaining <= 0) throw timeoutError(step);
      const result = spawnSync(executable, args, {
        cwd: app, env: environment, encoding: "utf8", input,
        ...(remaining === undefined ? {} : { timeout: remaining, killSignal: "SIGKILL" }),
      });
      const error = result.error as NodeJS.ErrnoException | undefined;
      if (remaining !== undefined && error?.code === "ETIMEDOUT") throw timeoutError(step);
      assert.ifError(error);
      return result;
    };
    const args = ["settings", "mcp", "--app", appPath];
    const input = Buffer.concat(frames.flatMap(frame => [typeof frame === "string" ? Buffer.from(frame) : frame, Buffer.from("\n")]));
    const session = run("five-tool exchange and frame recovery", args, input);
    assert.equal(session.status, 0);
    assert.match(session.stderr, /app console log\napp stdout log/u);
    const replies = session.stdout.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(replies.map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8, null, 9, 10, 11, 12, null, 13, 14, 15, null, 16]);
    const byId = new Map(replies.filter(row => row.id !== null).map(row => [row.id, row]));
    const discovery = init + "\n" + request(3, "tools/list") + "\n";
    for (const [step, prefixed] of [
      ["discovery with prefixed --app", ["settings", "--app", appPath, "mcp"]],
      ["discovery with prefixed --app=", ["settings", `--app=${appPath}`, "mcp"]],
      ["discovery with prefixed configuration and database URL",
        ["settings", "--configuration=supplements", "--database-url", "postgresql://probe@db.invalid/shop", "--app", appPath, "mcp"]],
    ] as const) {
      const alternate = run(step, prefixed, discovery);
      assert.equal(alternate.status, 0);
      assert.deepEqual(alternate.stdout.trimEnd().split("\n").map(line => JSON.parse(line)), [byId.get(2), byId.get(3)]);
    }
    const missing = run("missing app refusal", ["settings", "--app", join(directory, "missing.mjs"), "mcp"], discovery);
    assert.equal(missing.status, 74);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "Settings app: Check the --app path and the createSettingsBindings export.\n");
    const malformed = run("missing --app value refusal", ["settings", "--app", "--configuration", "mcp"], discovery);
    assert.equal(malformed.status, 64);
    assert.match(malformed.stdout, /Supply a value for --app/u);
    assert.equal(malformed.stderr, "");
    assert.equal(byId.get(2).result.protocolVersion, "2025-06-18");
    const listing = byId.get(3).result;
    const tools: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { additionalProperties?: boolean }; outputSchema?: object }[] = listing.tools;
    assert.deepEqual(tools.map(tool => tool.name), ["settings_list", "settings_show", "settings_explain", "settings_check", "settings_preview"]);
    assert(tools.every(tool => tool.inputSchema.additionalProperties === false && tool.outputSchema && tool.annotations?.readOnlyHint));
    const results = [4, 5, 6, 7, 8].map(id => byId.get(id).result);
    const [list, show, explained, checked, preview] = results;
    assert((list?.structuredContent?.entries as { key: string }[]).some(entry => entry.key === key));
    assert.deepEqual(show?.structuredContent?.observation, { state: "file", configuration: "supplements", value: 1000 });
    assert.equal((explained?.structuredContent?.setting as { key: string }).key, key);
    assert.equal(checked?.structuredContent?.state, "checked");
    assert.equal(preview?.isError, true);
    assert.equal((preview.structuredContent?.refusal as { code: string }).code, "commerce_setting_preview_connection_required");
    assert.deepEqual([1, 9, 10, 11, 12].map(id => byId.get(id).error.code), [-32602, -32601, -32602, -32602, -32602]);
    assert.deepEqual(byId.get(14).error, { code: -32602, message: "Invalid tool or arguments. See tools/list." });
    assert.deepEqual(replies.filter(row => row.id === null).map(row => row.error), [
      { code: -32700, message: "Parse error" }, { code: -32600, message: "Message exceeds 1 MiB" }, { code: -32700, message: "Parse error" },
    ]);
    for (const id of [13, 15, 16]) assert.deepEqual(byId.get(id).result, {});
    const badUrl = "--database-url=postgresql://probe@db.invalid/";
    const refused = run("invalid database URL refusal", [...args, badUrl], init);
    assert.equal(refused.status, 64);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /database path segment/u);
    const prefixedRefusal = run("prefixed invalid database URL refusal", ["settings", "--app", appPath, badUrl, "mcp"], init);
    assert.deepEqual([prefixedRefusal.status, prefixedRefusal.stdout, prefixedRefusal.stderr],
      [refused.status, refused.stdout, refused.stderr]);
    return { listing, results };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Uses the cold consumer's existing owned database; SQL repair is harness work. */
export function proveDistributionCliPostgres(consumer: string, connectionString: string): void {
  const root = join(consumer, "distribution-diagnosis-postgres");
  mkdirSync(root);
  const executeSql = (sql: string) => execFileSync(process.execPath, ["--input-type=module", "-e", `
    import pg from "pg";
    const client = new pg.Client({connectionString:${JSON.stringify(connectionString)}});
    await client.connect();
    try { await client.query(${JSON.stringify(sql)}); } finally { await client.end(); }
  `], { cwd: consumer, env: isolatedConsumerEnv(), timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  let created = false;
  try {
    executeSql("CREATE SCHEMA distribution_diagnosis; CREATE TABLE distribution_diagnosis.schema_version(version text NOT NULL); INSERT INTO distribution_diagnosis.schema_version VALUES ('previous');");
    created = true;
    writeFileSync(join(root, "state.json"), JSON.stringify({ repaired: false }));
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "migrations/current.sql"), "CREATE TABLE distribution_diagnosis.orders(id text PRIMARY KEY); UPDATE distribution_diagnosis.schema_version SET version='current';");
    writeFileSync(join(root, "app.mjs"), `
import pg from "pg";
import { readFileSync } from "node:fs";
import { createSchemaProbe } from "@openlup/core/readiness";
const repaired = JSON.parse(readFileSync(new URL("./state.json",import.meta.url),"utf8")).repaired;
const run = () => { throw Error("diagnosis_executed_effect"); };
export function createVerificationInput() {
 return {
  candidate:{artifact:"local",configuration:"local",environment:"local",database:${JSON.stringify(new URL(connectionString).pathname.slice(1))},schema:"current"},inventoryComplete:true,
  loadedPackages:[{name:"@openlup/core",version:"0.36.0",kind:"kernel"},{name:"@openlup/platform",version:"0.36.0",kind:"rail",modules:["commerce"]}],
  contributions:[{manifest:{name:"@openlup/platform",version:"0.36.0",kind:"rail",module:{id:"commerce",kind:"capability",provides:["./commerce"],dependsOn:[]},emits:[],handles:[],env:[],routes:[],requiredPorts:["orders"],schedules:[{id:"order-expiry",cadenceSeconds:60}],requiredSchema:{version:"current",migration:"distribution-diagnosis-postgres/migrations/current.sql",objects:[{kind:"table",name:"distribution_diagnosis.orders"}]}},handlers:[],routes:[],schedules:[{id:"order-expiry",cadenceSeconds:60,run}]}],
  vocabulary:[],exemptions:[],bindings:{ports:repaired?{"@openlup/platform/commerce:orders":{read:run}}:{},triggers:repaired?{"@openlup/platform/commerce:order-expiry":run}:{},routes:{},env:{}},
  schemaProbe:{async observe(requirement) {
   const client = new pg.Client({connectionString:${JSON.stringify(connectionString)}}); await client.connect();
   try {
    await client.query("BEGIN READ ONLY");
    return await createSchemaProbe(client,async()=>{const result=await client.query("SELECT current_database() AS database, max(version) AS version FROM distribution_diagnosis.schema_version");return result.rows[0];}).observe(requirement);
   } finally { try { await client.query("ROLLBACK"); } finally { await client.end(); } }
  }},
 };
}
`);
    const executable = join(consumer, "node_modules/.bin/openlup");
    const args = ["verify", "--app", join(root, "app.mjs")];
    const run = (expected: number, json = true) => {
      const result = spawnSync(executable, [...args, ...(json ? ["--json"] : [])], { cwd: consumer, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 60_000 });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr || result.stdout);
      assert.equal(result.stderr, "");
      return result.stdout;
    };
    const report: CliReport = JSON.parse(run(1));
    assert(report.findings);
    assert(report.findings.some(item => item.code === "OPENLUP_E_PORT_MISSING"));
    assert(report.findings.some(item => item.code === "OPENLUP_E_SCHEDULE_UNBOUND"));
    assert(report.findings.some(item => item.code === "OPENLUP_E_SCHEMA_BEHIND" && item.observed.includes('"previous"')));
    assert(report.findings.some(item => item.code === "OPENLUP_E_SCHEMA_BEHIND" && item.observed === "object_absent"));
    const text = run(1, false);
    for (const finding of report.findings) assert(text.includes(finding.fix));
    const schemaFinding = report.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND" && item.fix.startsWith("Apply "));
    assert(schemaFinding);
    const migration = /^Apply ([a-zA-Z0-9_./-]+) /u.exec(schemaFinding.fix)?.[1];
    assert.equal(migration, "distribution-diagnosis-postgres/migrations/current.sql");
    executeSql(readFileSync(join(consumer, migration!), "utf8"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ repaired: true }));
    assert.equal(JSON.parse(run(0)).state, "ready");
  } finally {
    if (created) executeSql("DROP SCHEMA distribution_diagnosis CASCADE;");
    rmSync(root, { recursive: true, force: true });
  }
}
