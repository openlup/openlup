/** Called by the existing cold consumer after installing its verified tarballs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppUpgradePlan, AppVerificationFinding } from "@openlup/platform/lifecycle";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import type { StoreConfig } from "../../examples/neutral-store/shared/config.ts";
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
  // The storefront proof file: an upgraded store without it is proven with the kit's shipped values.
  "owned/storefront-proof.json",
]);

export const starterSettingsHost = "owned/settings-host.ts";
const starterStoreConfig = "owned/store.config.ts";
const legacyStarterPhysical = /\{ netWeightG: (\d+), unitGtin: '([0-9]+)', issuer: '([^'\r\n]+)' \}/gu;
const settingsHeading = "\n## Change a business setting\n";
const starterAgentGuide = "AGENTS.md";

export function migrateStarterPhysical(app: string, target: string, pristine: boolean): Buffer {
  const path = join(app, starterStoreConfig);
  const previous = readFileSync(path, "utf8");
  const next = pristine ? readFileSync(join(target, starterStoreConfig), "utf8") : previous.replaceAll(legacyStarterPhysical,
    (_, grams, gtin, issuer) => `{ netContent: { dimension: 'mass', unit: 'openlup:g', unscaled: '${grams}', scale: 0 }, primaryUnitIdentifier: { scheme: 'gs1:gtin', issuer: '${issuer}', value: '${gtin}' } }`);
  assert(next !== previous && !/\bnetWeightG:/u.test(next), "starter_physical_upgrade_manual_reconciliation_required");
  const bytes = Buffer.from(next);
  writeFileSync(path, bytes);
  return bytes;
}

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
const starterCompose = "compose.yaml";

export function proveStarterPortRefusals(app: string) {
  const options = { cwd: app, env: { ...isolatedConsumerEnv(), PATH: "", OPENLUP_STARTER_PORT: "6000" }, encoding: "utf8" as const };
  const host = spawnSync(process.execPath, ["host/server.ts", "--port", "1023"], options);
  assert.ifError(host.error);
  assert.equal(host.status, 1);
  assert.match(host.stderr, /starter_port_invalid\nFix: Pass a valid `--port <1024–65535>`/u);
  const lifecycle = spawnSync(process.execPath, [starterLifecycle, "up", "--json"], options);
  assert.ifError(lifecycle.error);
  assert.equal(lifecycle.status, 2);
  const report = JSON.parse(lifecycle.stdout);
  assert.deepEqual(report.packs, []);
  assert.equal(report.findings[0].code, "starter_port_invalid");
  assert.match(report.findings[0].fix, /Set OPENLUP_STARTER_PORT.*unset it to use 4319/u);
}

export function reconcileStarterLocalPort(app: string, previous: Record<string, string>,
  applyRefused: () => Parameters<typeof assertUpgradeConflict>[0]) {
  const port = "4320";
  for (const path of [starterCompose, starterLifecycle]) {
    const original = previous[path]!;
    const edited = original.replaceAll("4319", port);
    assert.notEqual(edited, original, `expected a fixed port in ${path}`);
    const managed = join(app, path);
    writeFileSync(managed, edited);
    assertUpgradeConflict(applyRefused(), path);
    assert.equal(readFileSync(managed, "utf8"), edited);
    writeFileSync(managed, original);
  }
  return port;
}

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
  const apply = "catalogue:apply";
  if (Object.hasOwn(expectedScripts, apply)) assert.equal(scripts[apply], "./lifecycle catalogue apply");
  else assert(!Object.hasOwn(scripts, apply), "unexpected starter catalogue apply wrapper");
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
  run: (file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string = execFileSync,
  migratedPort?: string) {
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
    const recipeProject = "st1-pr2-recipe-" + randomBytes(6).toString("hex");
    const source = existsSync(join(app, "host/runtime-database.ts"))
      ? join(realpathSync(homedir()), ".local/state/openlup/neutral-store", recipeProject, "runtime-password") : undefined;
    const recipe = { ...options, env: { ...options.env, OPENLUP_STARTER_PORT: isolatedConsumerEnv().OPENLUP_STARTER_PORT ?? "4319",
      OPENLUP_STARTER_CATALOGUE_RECIPE_PROJECT: recipeProject } as NodeJS.ProcessEnv };
    const dockerOptions = { ...options, timeout: 30_000 };
    if (browser) {
      let url: URL | undefined;
      try {
        const name = "starter-catalogue-browser-" + randomBytes(6).toString("hex");
        readinessDirectory = mkdtempSync(join(tmpdir(), "openlup-catalogue-browser-"));
        const readinessMount = `type=bind,src=${realpathSync(readinessDirectory)},dst=${catalogueBrowserReadiness}`;
        const [action, ...args] = browser.containerArguments(app, browser.reference, name, browser.localImage, ["--mount", readinessMount]);
        container = name;
        if (source) {
          run("docker", [action!, "--detach", ...args, "sleep", "900"], dockerOptions);
          const mounts = JSON.parse(run("docker", ["inspect", "--format", "{{json .Mounts}}", name], dockerOptions));
          for (const mount of mounts) if (mount.Type === "bind") {
            const root = realpathSync(mount.Source);
            assert(!source.startsWith(root + "/") && source !== root, "Starter browser mount overlaps private state");
          }
          run("docker", ["exec", "-d", name, "node", "-e", launchCatalogueBrowser], dockerOptions);
        } else run("docker", [action!, "--detach", ...args, "node", "-e", launchCatalogueBrowser], dockerOptions);
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
    if (source) {
      const freshMarker = "Fresh PostgreSQL temporary socket, rules, TCP transition and deny-only fallback PASS";
      const restartMarker = "Fresh PostgreSQL crash recovery with the stock deny-only fallback PASS";
      assert(result.includes(freshMarker) && result.includes(restartMarker), "Fresh PostgreSQL controls did not execute");
      console.log(freshMarker);
      console.log(restartMarker);
    }
    if (container && source) {
      assert.equal(realpathSync(source), source);
      const check = `const {openSync,closeSync}=require('node:fs'), {argv}=require('node:process');
        for(const path of argv.slice(1)) {
        try { closeSync(openSync(path,'r')); } catch (error) { if (['ENOENT','EACCES'].includes(error.code)) continue; throw error; }
        process.exit(2);
      } console.log('PASS');`;
      assert.equal(run("docker", ["exec", container, "timeout", "5", "node", "-e", check, source,
        "/run/secrets/starter_runtime_password"], { ...dockerOptions, timeout: 5000 }).trim(), "PASS");
      console.log("Installed starter browser credential visibility PASS");
    }
    if (migratedPort) {
      const migrated = { ...options, env: { ...options.env, OPENLUP_STARTER_PORT: migratedPort,
        COMPOSE_PROJECT_NAME: `starter-upgrade-${randomBytes(6).toString("hex")}` } };
      try {
        const up = JSON.parse(run("./lifecycle", ["up", "--configuration", "coffee", "--json"], migrated));
        assert.equal(up.exitCode, 0);
        assert.equal(run("docker", ["compose", "port", "application", migratedPort], migrated).trim(), `127.0.0.1:${migratedPort}`);
        run("curl", ["--fail", "--silent", `http://127.0.0.1:${migratedPort}/api/config`], migrated);
        console.log(`Upgraded starter healthy on migrated port ${migratedPort}`);
      } finally {
        try { run("./lifecycle", ["down"], migrated); }
        finally { run("docker", ["compose", "down", "--volumes", "--rmi", "local"], migrated); }
      }
    }
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
  const localPortUpgrade = /127\.0\.0\.1:4319:4319/u.test(from.files[starterCompose] ?? "")
    && to.files[starterCompose]?.includes("${OPENLUP_STARTER_PORT:-4319}");
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
  const physicalUpgrade = !Object.hasOwn(from.files, "shared/seed-physical.ts") && Object.hasOwn(to.files, "shared/seed-physical.ts")
    && /\bnetWeightG:/u.test(readFileSync(join(app, starterStoreConfig), "utf8"));
  if (!pair.pristine) phase("customize-owned", () => {
    for (const [path, before, after] of [
      ["owned/store.config.ts", "#3d6657", "#663d57"],
      ["owned/fragments.ts", "offer-intro", "adopter-offer-intro"],
    ] as const) {
      assert(ownership.owned.includes(path) && !Object.hasOwn(from.files, path) && !Object.hasOwn(to.files, path));
      const original = readFileSync(join(app, path), "utf8"); assert(original.includes(before));
      writeFileSync(join(app, path), original.replaceAll(before, after)); owned[path] = readFileSync(join(app, path));
    }
    if (physicalUpgrade) {
      const local = owned[starterStoreConfig]!.toString().replace("netWeightG: 250, unitGtin: '0000000000017', issuer: 'demo'",
        "netWeightG: 275, unitGtin: '0000000000109', issuer: 'example:local'");
      assert.notEqual(local, owned[starterStoreConfig]!.toString());
      writeFileSync(join(app, starterStoreConfig), owned[starterStoreConfig] = Buffer.from(local));
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
  let migratedPort: string | undefined;
  if (localPortUpgrade && !pair.pristine) phase("local-port-reconciliation", () => {
    migratedPort = reconcileStarterLocalPort(app, from.files, applyRefused);
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
    if (localPortUpgrade) assert.equal(readFileSync(join(app, starterCompose), "utf8"), to.files[starterCompose]);
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
  if (physicalUpgrade) phase("starter-owned-physical-reconciliation", () => {
    owned[starterStoreConfig] = migrateStarterPhysical(app, pair.to, pair.pristine === true);
    if (!pair.pristine) pair.evidence.customizations![starterStoreConfig] = hash(owned[starterStoreConfig]);
    assert.deepEqual(run("apply").applied, []);
    checkUpgradeFiles();
  });
  if (catalogue130) {
    checkUpgradeFiles();
    if (!catalogueUpgrade) convertCatalogue();
  }
  rmSync(workspace, { recursive: true, force: true });
  return () => phase("installed-application-and-owned-bytes", () => {
    assertCompleteStarter(app, to); checkUpgradeFiles();
    if (Object.hasOwn(to.files, "host/server.ts") && Object.hasOwn(to.files, starterLifecycle)
      && to.files["shared/config.ts"]?.includes("const fetchBlockedPorts"))
      proveStarterPortRefusals(app);
    if (catalogue130) phase("starter-1.3.0-installer-admission", () => {
      // Target packages are installed here. The role refusal witnesses a completed catalogue admission.
      assertStarterCatalogueAdmission(app, "starter_seed_runtime_role_forbidden", 3, catalogueUpgrade);
    });
    if (to.files["package.json"]?.includes('"catalogue:check:source"'))
      proveStarterCatalogueWrappers(app, dirname(app), to.files["package.json"]);
    if (readStarterScripts(to.files["package.json"])["catalogue:apply"]) {
      const result = spawnSync(process.execPath, [starterLifecycle, "catalogue", "apply", "--approve", "--json"],
        { cwd: app, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      const report = JSON.parse(result.stdout);
      assert.equal(report.command, "catalogue apply");
      assert.equal(report.findings[0].code, "starter_argument_unknown");
      assert.deepEqual(report.receipts, []);
    }
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
      proveInstalledCatalogueUpgrade(app, expected, pair.browser, undefined, migratedPort);
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

/** Installed adjacent-file upgrade on one occupied local demonstration. */
type ProofDiagnostic = { step: string; exit: number | null; reason: string };
export class StarterRuntimeProofError extends Error {
  readonly records: readonly ProofDiagnostic[];
  constructor(records: readonly ProofDiagnostic[]) {
    super(records.map(({ step, exit, reason }) => `${step} exit=${exit ?? "none"} reason=${reason}`).join("\n"));
    this.records = records;
    this.stack = undefined;
  }
}

function proofError(items: readonly (ProofDiagnostic | StarterRuntimeProofError)[]) {
  return new StarterRuntimeProofError(items.flatMap(item => item instanceof StarterRuntimeProofError ? item.records : [item]));
}

type ProofLabel = string | number;
type SiteOptions = { labels?: readonly ProofLabel[]; exit?: number | boolean | null; legacy?: boolean };

export function site<T>(step: string, reason: string, operation: () => T, options: SiteOptions = {}): T {
  if (options.legacy) return operation();
  const classify = (error: unknown): never => {
    if (error instanceof StarterRuntimeProofError) throw error;
    const status = options.exit === true ? (error as { status?: unknown } | null)?.status : options.exit;
    throw proofError([{ step: [step, ...options.labels ?? []].join("."), reason,
      exit: typeof status === "number" && Number.isInteger(status) ? status : null }]);
  };
  try {
    const result = operation();
    return result instanceof Promise ? result.catch(classify) as T : result;
  } catch (error) { return classify(error); }
}

export class ProofFailures {
  private readonly errors: (ProofDiagnostic | StarterRuntimeProofError)[] = [];
  keep(error: unknown) {
    this.errors.push(error instanceof StarterRuntimeProofError ? error
      : { step: "candidate_occupied_entry", exit: null, reason: "occupied_entry_invariant" });
  }
  attempt(operation: () => unknown) {
    try { operation(); } catch (error) { this.keep(error); }
  }
  finish() {
    if (this.errors.length) throw proofError(this.errors.splice(0));
  }
}

export async function proveStarterRuntimeUpgrade(from: string, to: string, port: number, deferCompletion = false) {
  const started = performance.now();
  await runStarterRuntimeUpgrade(from, to, port);
  if (!deferCompletion) completeStarterRuntimeProof(started);
  return started;
}

export function completeStarterRuntimeProof(started: number) {
  site("proof_progress_write", "proof_completion_write_failed",
    () => process.stdout.write("Starter runtime occupied proof completed in " + Math.round(performance.now() - started) + " ms PASS\n"), { labels: ["complete"] });
}

async function runStarterRuntimeUpgrade(from: string, to: string, port: number) {
  site("occupied_proof_admission", "unsupported_runner_or_port", () => assert(process.platform === "linux" && port !== 4319));
  const project = "starter-runtime-" + site("proof_project_random", "proof_project_random", () => randomBytes(6)).toString("hex");
  const source = site("proof_runtime_home", "proof_runtime_home",
    () => join(homedir(), ".local/state/openlup/neutral-store", project, "runtime-password"));
  const scratch = site("proof_scratch_create", "proof_scratch_create", () => mkdtempSync(join(tmpdir(), project + "-")));
  const failures = new ProofFailures();
  const alternate = project + "-next";
  let dockerBin = "/usr/bin/docker";
  let env: NodeJS.ProcessEnv = {};
  const projectFile = join(from, ".context/compose-project");
  type Expected = number | "not_success" | "finding" | "SIGKILL";
  function requireExit(result: { status: number | null; signal: string | null }, expected: Expected) {
    if (expected === "finding") return;
    if (expected === "SIGKILL" ? result.signal !== expected
      : expected === "not_success" ? result.status === 0 : result.status !== expected) {
      throw { status: result.status };
    }
  }
  function run(cwd: string, command: string, args: string[], input?: string, environment = env, expected: Expected = 0) {
    const child = spawnSync(command, args, { cwd, env: environment, input, encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (child.error) throw { status: child.status };
    requireExit(child, expected);
    return { status: child.status, signal: child.signal, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  }
  const composeFor = (activeProject: string, ...args: string[]) =>
    run(from, "docker", ["compose", "--project-name", activeProject, ...args]);
  const compose = (...args: string[]) => composeFor(project, ...args);
  const checked = (result: ReturnType<typeof run>) => result.stdout.trim();
  const downProject = (name: string) => run(from, dockerBin,
    ["compose", "--project-name", name, "down", "--volumes", "--remove-orphans", "--rmi", "local"]);
  const rawSql = (text: string, database = "neutral_store", activeProject = project) => checked(run(from, "docker",
    ["compose", "--project-name", activeProject, "exec", "-T", "database", "psql", "-XAtq", "-w",
      "-v", "ON_ERROR_STOP=1", "-U", database === "postgres" ? "postgres" : "starter_install", "-d", database, "-c", text]));
  const composeWithExit = (name: string, args: string[], expected: Expected) => run(from, "docker", ["compose", "--project-name", name, ...args], undefined, env, expected);
  const container = (service: string, activeProject = project) => checked(composeFor(activeProject, "ps", "-q", service));
  const up = (code = 0) => checked(run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, env, code));
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const identity = (step: string, activeProject = project) => {
    const id = site("database_identity_container", "database_identity_container", () => container("database", activeProject), { labels: [step], exit: true });
    const format = "{{.State.StartedAt}} {{range .Mounts}}{{if eq .Destination \"/var/lib/postgresql/data\"}}{{.Name}}{{end}}{{end}}";
    return [id, site("database_identity_mount", "database_identity_mount", () => run(from, "docker", ["inspect", "--format", format, id]).stdout.trim(), { labels: [step], exit: true }),
      site("database_identity_oid", "database_identity_oid", () => rawSql("select oid from pg_database where datname = current_database()", "neutral_store", activeProject), { labels: [step], exit: true })
        + ":" + site("database_identity_system_id", "database_identity_system_id", () => rawSql("select system_identifier from pg_control_system()", "postgres", activeProject), { labels: [step], exit: true }),
      site("database_identity_hba_file", "database_identity_hba_file", () => rawSql("show hba_file", "postgres", activeProject), { labels: [step], exit: true })];
  };
  const retained = (step: string) => [
    site("retained_seed_products", "retained_seed_products", () => rawSql("select jsonb_agg(to_jsonb(t) order by id) from public.catalog_products t"), { labels: [step], exit: true }),
    site("retained_seed_skus", "retained_seed_skus", () => rawSql("select jsonb_agg(to_jsonb(t) order by id) from public.catalog_skus t"), { labels: [step], exit: true }),
    site("retained_seed_prices", "retained_seed_prices", () => rawSql("select jsonb_agg(to_jsonb(t) order by id) from public.price_entries t"), { labels: [step], exit: true }),
    site("retained_seed_migrations", "retained_seed_migrations", () => rawSql("select jsonb_agg(to_jsonb(t) order by position) from public.platform_schema_migrations t"), { labels: [step], exit: true }),
  ];
  const mark = (role: string, label: string, ...ordinals: number[]) => site("proof_progress_write", "proof_progress_write",
    () => process.stdout.write("Starter runtime " + label + " PASS\n"), { labels: [role, ...ordinals] });
  const origin = `http://127.0.0.1:${port}`;
  type CheckoutResult = { ok: boolean; code?: string; value?: Record<string, unknown> };
  async function checkoutAction(labels: readonly ProofLabel[], action: string, body: Record<string, unknown>): Promise<CheckoutResult> {
    const id = site("checkout_request_id", "checkout_request_id", () => randomUUID(), { labels });
    const encoded = site("checkout_request_encode", "checkout_request_encode", () => JSON.stringify(body), { labels });
    // Receipt reads carry no cookies from the original checkout.
    const response = await site("checkout_request", "checkout_request", () => fetch(`${origin}/api/actions/${action}`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Origin: origin, "X-Starter-Request": "1", "Idempotency-Key": id,
        "Content-Type": "application/json", Connection: "close" },
      body: encoded,
    }), { labels });
    const result = await site("checkout_response_decode", "checkout_response_decode", () => response.json() as Promise<CheckoutResult>, { labels });
    site("checkout_response_consistency", "checkout_response_consistency", () => assert(result && result.ok === response.ok), { labels });
    return result;
  }
  const settledFacts = (labels: readonly ProofLabel[], ref: string, activeProject = project) => {
    site("settled_order_key", "settled_order_key", () => assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(ref)), { labels });
    return site("settled_record_query", "settled_record_query", () => rawSql(`select jsonb_build_object(
      'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from public.commerce_orders o where o.id = '${ref}'), '[]'),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.commerce_order_items l where l.order_id = '${ref}'), '[]'),
      'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.commerce_settlement_intents p where p.order_id = '${ref}'), '[]'),
      'attempts', coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.payment_simulator_attempts a
        join public.commerce_settlement_intents p on p.id = a.settlement_intent_id where p.order_id = '${ref}'), '[]'))`, "neutral_store", activeProject), { labels, exit: true });
  };
  async function createSettledReceipt(step: string) {
    const labels = [step];
    const response = await site("settlement_configuration_request", "settlement_configuration_request",
      () => fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(15_000) }), { labels });
    site("settlement_configuration_http", "settlement_configuration_http", () => assert(response.ok), { labels });
    const envelope = await site("settlement_configuration_decode", "settlement_configuration_decode",
      () => response.json() as Promise<{ config?: StoreConfig }>, { labels });
    const config = site("settlement_configuration_selection", "settlement_configuration_selection", () => {
      assert(envelope?.config?.id === "coffee");
      return envelope.config;
    }, { labels });
    const buyer = site("settlement_buyer_id", "settlement_buyer_id", () => randomUUID(), { labels });
    const order = site("settlement_order_input", "settlement_order_input", () => ({
      configuration: config.id, locale: config.market.defaultLocale, country: config.market.country,
      email: `buyer-${buyer}@example.test`, firstName: "Example", lastName: "Buyer", phone: "000000000",
      line1: "1 Example Lane", city: "Example City", postalCode: "00000", termsAccepted: true, termsRevision: config.legal.revision,
      cart: { schemaVersion: 1, configuration: config.id, mode: "one_time", cadenceDays: null,
        lines: [{ sku: config.offer.products[0].sku, quantity: config.offer.minUnits }] },
    }), { labels });
    const quote = await checkoutAction([step, "quote"], "offer.validate", order);
    const accepted = site("quote_validation", "quote_validation", () => {
      assert(quote.ok && quote.value?.expectedTotal);
      return quote.value;
    }, { labels });
    const checkout = await checkoutAction([step, "checkout"], "checkout.create", { ...order,
      quoteAcceptance: accepted.quoteAcceptance, expectedTotal: accepted.expectedTotal });
    const reference = site("checkout_validation", "checkout_validation", () => {
      const { orderRef, token } = checkout.value ?? {};
      assert(checkout.ok && typeof orderRef === "string" && typeof token === "string" && token);
      return { orderRef, token };
    }, { labels });
    const { orderRef } = reference;
    const paid = await checkoutAction([step, "payment"], "payment.simulate", { ...reference, outcome: "captured" });
    site("payment_validation", "payment_validation", () => assert(paid.ok && paid.value?.status === "paid" && paid.value.orderRef === orderRef), { labels: [step] });
    const facts = settledFacts([step, "records"], orderRef);
    const records = site("settled_record_decode", "settled_record_decode", () => JSON.parse(facts), { labels, exit: 0 });
    site("settled_record_shape", "settled_record_shape", () => {
      const { orders, lines, payments, attempts } = records;
      assert(orders.length === 1 && orders[0].status === "paid" && lines.length === 1 && payments.length === 1
        && payments[0].status === "settled" && attempts.length === 1 && attempts[0].state === "captured");
    }, { labels, exit: 0 });
    return { reference, facts };
  }
  async function readSettlementContinuity(
    step: string, witness: Awaited<ReturnType<typeof createSettledReceipt>>, activeProject = project, receiptReference = witness.reference,
  ) {
    const records = settledFacts([step, "retained_records"], witness.reference.orderRef, activeProject);
    const receipt = await checkoutAction([step, "receipt"], "checkout.read", receiptReference);
    const matches = site("receipt_comparison", "receipt_comparison", () =>
      records === witness.facts && receipt.ok && receipt.value?.status === "paid"
        && receipt.value.orderRef === witness.reference.orderRef, { labels: [step] });
    return { records, receipt, matches };
  }
  try {
    dockerBin = site("proof_docker_realpath", "proof_docker_realpath", () => realpathSync("/usr/bin/docker"));
    env = site("proof_environment", "proof_environment",
      () => ({ ...isolatedConsumerEnv(), COMPOSE_PROJECT_NAME: project, OPENLUP_STARTER_PORT: String(port) }));
    const fresh = { ...env };
    delete fresh.COMPOSE_PROJECT_NAME;
    const selectNext = { ...env, COMPOSE_PROJECT_NAME: alternate };
    const originText = site("predecessor_origin_read", "predecessor_origin_read",
      () => readFileSync(join(from, ".starter-origin.json"), "utf8"));
    const originMetadata = site("predecessor_origin_format", "predecessor_origin_format", () => JSON.parse(originText));
    const predecessor = originMetadata?.sourceRevision;
    site("predecessor_identity", "predecessor_identity", () => assert(/^[a-f0-9]{40}$/u.test(predecessor)));
    const old = site("predecessor_upgrade_snapshot", "predecessor_upgrade_snapshot", () => starterUpgradeSnapshot(from, "1.0.0"));
    const next = site("candidate_upgrade_snapshot", "candidate_upgrade_snapshot", () => starterUpgradeSnapshot(to, "1.0.1"));
    const oldCompose = join(from, "compose.yaml");
    const oldLifecycle = site("predecessor_lifecycle_read", "predecessor_lifecycle_read",
      () => readFileSync(join(from, "lifecycle.mjs"), "utf8"));
    const predecessorSourceExists = site("predecessor_runtime_source_exists", "predecessor_runtime_source_exists", () => existsSync(source));
    site("unexpected_runtime_file", "unexpected_runtime_file", () => assert(!predecessorSourceExists));
    site("predecessor_start", "predecessor_start", () => up(), { exit: true });
    const before = retained("initial_seed"), original = identity("initial_database");
    for (const [index, value] of before.entries()) {
      const seed = value && site("initial_seed_format", "initial_seed_format", () => JSON.parse(value), { labels: [index], exit: 0 });
      site("empty_retained_seed", "empty_retained_seed", () => assert(seed?.length), { labels: [index], exit: 0 });
    }
    const settled = await createSettledReceipt("predecessor_settled_receipt");
    mark("predecessor_checkout_settled_with_keyed_records", "predecessor checkout settled with keyed records");
    const schema: unknown = site("initial_schema_format", "initial_schema_format", () => JSON.parse(before[3]!), { exit: 0 });
    const count = site("installed_schema", "installed_schema", () => {
      assert(Array.isArray(schema));
      return schema.length;
    }, { exit: 0 });
    const oldCatalogue = site("predecessor_catalogue_read", "predecessor_catalogue_read",
      () => readFileSync(join(from, "node_modules/@openlup/platform/sql/manifest.json")));
    const nextCatalogue = site("candidate_catalogue_read", "candidate_catalogue_read",
      () => readFileSync(join(to, "node_modules/@openlup/platform/sql/manifest.json")));
    site("catalogue_mismatch", "catalogue_mismatch", () => assert(oldCatalogue.equals(nextCatalogue)));
    const predecessorApp = site("predecessor_application", "predecessor_application", () => container("application"), { exit: true });
    const socketImage = site("predecessor_image", "predecessor_image", () => run(from, "docker", ["inspect", "--format", "{{.Image}}", predecessorApp]).stdout.trim(), { exit: true });
    const statusCode = `import {createPlatformPostgresMigrationRunner} from '@openlup/platform/migrations';
      const runner=createPlatformPostgresMigrationRunner({connectionString:'postgresql://starter_install@localhost/neutral_store?host=/var/run/postgresql'},
        {installation:{generation:'qualified-v2',roleMode:'installer-managed',migrationLogin:'starter_install',bootstrapLogin:'postgres',runtimeLogin:'starter_runtime',restoreLogin:'starter_restore'}});
      const status=await runner.status(); console.log(JSON.stringify({pending:status.pending.length,applied:status.applied.length})); process.exit(0);`;
    for (const [index, app] of [from, to].entries()) {
      const labels = [index === 0 ? "from" : "to", index];
      const result = site("qualified_schema_query", "qualified_schema_query", () => run(from, "docker", ["run", "--rm", "--network", "none",
        "--volume", project + "_installation-socket:/var/run/postgresql", "--volume", app + ":/candidate:ro",
        "--workdir", "/candidate", socketImage, "node", "--input-type=module", "-e", statusCode]), { labels, exit: true });
      const status = site("qualified_schema_format", "qualified_schema_format", () => JSON.parse(result.stdout), { labels, exit: result.status });
      site("qualified_schema_validation", "qualified_schema_validation", () => assert(!status.pending && status.applied === count), { labels, exit: result.status });
    }
    mark("common_installed_schema", "common installed schema " + count);
    site("stop_predecessor_application", "stop_predecessor_application", () => compose("stop", "application").stdout.trim(), { exit: true });
    const stoppedApplication = (step: string) => {
      const id = site("stopped_application_inventory", "stopped_application_inventory", () => compose("ps", "--all", "-q", "application").stdout.trim(), { labels: [step], exit: true });
      site("stopped_application_missing", "stopped_application_missing", () => assert(id), { labels: [step], exit: 0 });
      return id + " " + site("stopped_application_status", "stopped_application_status", () => run(from, "docker", ["inspect", "--format", "{{.State.Status}} {{.State.StartedAt}}", id]).stdout.trim(), { labels: [step], exit: true });
    };
    const originalApp = stoppedApplication("original_predecessor_application");
    for (const [index, snapshot] of [old, next].entries()) {
      const role = index === 0 ? "from" : "to", labels = [role, index];
      snapshot.schema = { min: count, max: count };
      const snapshotText = site("upgrade_snapshot_encode", "upgrade_snapshot_encode", () => JSON.stringify(snapshot), { labels });
      site("upgrade_snapshot_write", "upgrade_snapshot_write", () => writeFileSync(join(scratch, role + ".json"), snapshotText), { labels });
    }
    const cli = join(to, "node_modules/.bin/openlup");
    const options = ["--root", from, "--from", join(scratch, "from.json"), "--to", join(scratch, "to.json"), "--schema-version", String(count), "--json"];
    const upgrade = (labels: readonly ProofLabel[], action: string, expected = 0) => {
      const result = site("upgrade_command", "upgrade_command",
        () => run(from, cli, ["upgrade", action, ...options], undefined, env, expected), { labels, exit: true });
      return site("upgrade_report_decode", "upgrade_report_decode", () => JSON.parse(result.stdout), { labels, exit: result.status });
    };
    const files = [...new Set([...Object.keys(old.files), ...Object.keys(next.files)])];
    function identityOfFiles(step: string, ...ordinals: number[]) {
      const hashes: (string | null)[] = [];
      for (const [index, path] of files.entries()) {
        const labels = [step, ...ordinals, index];
        const pathOnDisk = join(from, path);
        const exists = site("managed_file_exists", "managed_file_exists", () => existsSync(pathOnDisk), { labels });
        const bytes = exists && site("managed_file_read", "managed_file_read", () => readFileSync(pathOnDisk), { labels });
        hashes.push(bytes ? site("managed_file_hash", "managed_file_hash", () => digest(bytes), { labels }) : null);
      }
      return hashes;
    }
    site("dirty_compose_write", "dirty_compose_write", () => writeFileSync(oldCompose, old.files["compose.yaml"] + "\n# Adopter configuration\n"));
    const dirty = identityOfFiles("dirty");
    for (const [index, action] of ["plan", "apply"].entries()) {
      const refusal = upgrade(["dirty", index], action, 1);
      site("dirty_upgrade_conflict", "dirty_upgrade_conflict", () => assert(refusal.conflicts?.some((row: { path: string }) => row.path === "compose.yaml")), { labels: [index], exit: 1 });
      const afterRefusal = identityOfFiles("after_refusal", index);
      site("dirty_upgrade_file_identity", "dirty_upgrade_file_identity", () => assert.deepEqual(dirty, afterRefusal), { labels: [index] });
    }
    site("clean_compose_restore", "clean_compose_restore", () => writeFileSync(oldCompose, old.files["compose.yaml"]!));
    upgrade(["clean_plan"], "plan");
    const preload = join(scratch, "interrupt.mjs");
    const targetText = site("interruption_preload_encode", "interruption_preload_encode", () => JSON.stringify(oldCompose));
    site("interruption_preload_write", "interruption_preload_write", () => writeFileSync(preload,
      `import { promises as fs } from 'node:fs'; const rename = fs.rename.bind(fs);
      fs.rename = async (...args) => { await rename(...args); if (String(args[1]) === ${targetText}) process.kill(process.pid, 'SIGKILL'); };`));
    site("interrupt_upgrade", "interrupt_upgrade", () => run(from, process.execPath, ["--import", preload, cli, "upgrade", "apply", ...options], undefined, env, "SIGKILL"), { exit: true });
    const interruptedCompose = site("interrupt_compose_read", "interrupt_compose_read", () => readFileSync(oldCompose, "utf8"));
    const interruptedLifecycle = site("interrupt_lifecycle_read", "interrupt_lifecycle_read",
      () => readFileSync(join(from, "lifecycle.mjs"), "utf8"));
    site("interrupt_arm", "interrupt_arm", () => assert(interruptedCompose === next.files["compose.yaml"] && interruptedLifecycle === oldLifecycle));
    site("mixed_startup", "mixed_lifecycle_started", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, undefined, "not_success"), { exit: true });
    const staged = join(scratch, "source");
    const stagedPassword = site("staged_credential_random", "staged_credential_random", () => randomBytes(32)).toString("hex");
    site("staged_credential_write", "staged_credential_write", () => writeFileSync(staged, stagedPassword + "\n", { mode: 0o444 }));
    for (const [index, service] of ["database", "application"].entries()) {
      const blocked = site("compose_gate_command", "compose_gate_command", () => run(from, "docker", ["compose", "--project-name", project, "up", "--no-build", "--force-recreate", "-d", service], undefined, { ...env, OPENLUP_STARTER_RUNTIME_SOURCE: staged }, "not_success"), { labels: [index], exit: true });
      site("compose_gate_refusal", "compose_gate_refusal", () => assert(!(blocked.status === 0 || !blocked.stderr.includes("starter_runtime_preflight_handoff_missing"))), { labels: [index], exit: blocked.status });
    }
    const interruptedApp = stoppedApplication("interrupted");
    site("interrupted_application_changed", "interrupted_application_changed", () => assert.equal(interruptedApp, originalApp));
    const interruptedDatabase = identity("interrupted");
    site("interrupted_database_changed", "interrupted_database_changed", () => assert.deepEqual(interruptedDatabase, original));
    const interruptedSeed = retained("interrupted");
    site("interrupted_data_changed", "interrupted_data_changed", () => assert.deepEqual(interruptedSeed, before));
    mark("mixed_files_and_startup_gate", "mixed files and startup gate");
    const resumed = upgrade(["resume_apply"], "apply");
    site("compose_not_resumed", "compose_not_resumed", () => assert(resumed.files.some((row: { path: string; action: string }) =>
      row.path === "compose.yaml" && row.action === "already-applied")), { exit: 0 });
    const applied = identityOfFiles("applied");
    const replayed = upgrade(["replay_apply"], "apply");
    site("upgrade_replay_report", "upgrade_replay_report", () => assert(!replayed.applied.length), { exit: 0 });
    const afterReplay = identityOfFiles("after_replay");
    site("replay_wrote_files", "replay_wrote_files", () => assert.deepEqual(applied, afterReplay));
    const artefacts = site("candidate_artifact_list", "candidate_artifact_list", () => readdirSync(join(to, "artifacts")));
    for (const [index, file] of ["package-lock.json", ".starter-origin.json", ...artefacts.map(name => "artifacts/" + name)].entries()) {
      const bytes = site("upgrade_artifact_read", "upgrade_artifact_read", () => readFileSync(join(to, file)), { labels: [index] });
      site("upgrade_artifact_write", "upgrade_artifact_write", () => writeFileSync(join(from, file), bytes), { labels: [index] });
    }
    site("refresh_packages", "refresh_packages", () => run(from, "npm", ["ci", "--ignore-scripts", "--no-audit"]), { exit: true });
    const earlySource = site("early_runtime_source_exists", "early_runtime_source_exists", () => existsSync(source));
    site("early_runtime_file", "early_runtime_file", () => assert(!earlySource));
    const volume = original[1]?.split(" ").at(-1);
    site("predecessor_volume_missing", "predecessor_volume_missing", () => assert(volume === project + "_database"));
    const predecessorImage = site("predecessor_database_image", "predecessor_database_image", () => run(from, dockerBin, ["inspect", "--format", "{{.Config.Image}}", original[0]!]).stdout.trim(), { exit: true });
    const readRecipeGuide = () =>
      readFileSync(join(from, "node_modules/@openlup/core/docs/guide/how-to/build/customize-the-starter.md"), "utf8");
    const guide = site("installed_cutover_guide_read", "installed_cutover_guide_read", () => readRecipeGuide());
    function recipe(heading: string, level = "###") {
      const body = guide.split(level + " " + heading + "\n")[1]?.match(/```sh\n([^]*?)\n```/u)?.[1];
      assert(body);
      return body;
    }
    const recover = (step: string, expected = 0) => {
      const script = site("lock_recovery_recipe", "lock_recovery_recipe", () => recipe("Recover a stale database lock"), { labels: [step] });
      return site("lock_recovery_command", "lock_recovery_command", () => run(from, "/bin/sh", ["-ec", script], undefined, { ...env, VOLUME: volume, DATABASE_IMAGE: predecessorImage }, expected), { labels: [step], exit: true });
    };
    const fingerprint = (step: string) => site("volume_fingerprint", "volume_fingerprint", () => run(from, dockerBin, ["run", "--rm", "--network", "none",
      "--volume", volume + ":/predecessor:ro", "--entrypoint", "/bin/sh", predecessorImage, "-ec",
      "cd /predecessor; find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum"]).stdout.trim(), { labels: [step], exit: true });
    const guard = (step: string) => {
      const result = site("database_guard_command", "database_guard_command", () => run(from, dockerBin, ["compose", "--project-name", project, "run", "--rm", "--no-deps", "-T", "database"], undefined, { ...env, OPENLUP_STARTER_PREFLIGHT_HANDOFF: "/dev/null" }, 1), { labels: [step], exit: true });
      site("database_guard_refusal", "database_guard_refusal", () => assert(!(result.status !== 1 || !result.stderr.includes("starter_runtime_database_lock_held")
        || !result.stderr.includes("docker ps --filter volume=" + volume))), { labels: [step], exit: result.status });
    };
    guard("responsive_predecessor_guard");
    site("pause_predecessor", "pause_predecessor", () => run(from, dockerBin, ["pause", original[0]!]).stdout.trim(), { exit: true });
    try {
      site("unresponsive_postmaster", "unresponsive_postmaster", () => run(from, dockerBin, ["run", "--rm", "--network", "none",
        "--volume", project + "_installation-socket:/var/run/postgresql", "--entrypoint", "/usr/bin/pg_isready",
        predecessorImage, "-q", "-t", "1", "-h", "/var/run/postgresql"], undefined, undefined, 2).stdout.trim(), { exit: true });
      const paused = fingerprint("paused_volume_before_guard");
      guard("paused_predecessor_guard");
      const blocked = recover("paused_volume_recovery", 1);
      site("paused_recovery_refusal", "paused_recovery_refusal",
        () => assert(blocked.stderr.includes("A running container still mounts " + volume)), { exit: blocked.status });
      const owner = site("paused_owner_ids", "paused_owner_ids", () => run(from, dockerBin,
        ["ps", "--no-trunc", "-q", "--filter", "volume=" + volume]).stdout.trim(), { exit: true });
      site("paused_owner_unchanged", "paused_owner_unchanged", () => assert.equal(owner, original[0]));
      const afterGuard = fingerprint("after_guard");
      site("unresponsive_owner_data_changed", "unresponsive_owner_data_changed", () => assert.equal(afterGuard, paused));
    } catch (error) { failures.keep(error); }
    finally { failures.attempt(() => site("unpause_predecessor", "unpause_predecessor",
      () => run(from, dockerBin, ["unpause", original[0]!]), { exit: true })); }
    failures.finish();
    const guardedDatabase = identity("guarded");
    site("live_owner_identity_changed", "live_owner_identity_changed", () => assert.deepEqual(guardedDatabase, original));
    const guardedSeed = retained("guarded");
    site("live_seed_changed", "live_seed_changed", () => assert.deepEqual(guardedSeed, before));
    mark("responsive_and_paused_predecessor_refuse_a_second_postmaster_volume_fingerprint_unchanged", "responsive and paused predecessor refuse a second postmaster; volume fingerprint unchanged");
    site("kill_predecessor_database", "kill_predecessor_database", () => run(from, dockerBin, ["kill", "--signal", "KILL", original[0]!]).stdout.trim(), { exit: true });
    site("stale_predecessor_lock_and_hba", "stale_predecessor_lock_and_hba", () => run(from, dockerBin, ["run", "--rm", "--network", "none",
      "--volume", volume + ":/predecessor:ro", "--entrypoint", "/bin/sh", predecessorImage, "-ec",
      'test -s /predecessor/postmaster.pid && grep -Eq "^host[[:space:]].*[[:space:]]trust$" /predecessor/pg_hba.conf']).stdout.trim(), { exit: true });
    const cutover = (step: string, expected = 0) => {
      const script = site("cutover_recipe", "cutover_recipe", () => recipe("Database login", "##"), { labels: [step] });
      return site("cutover_command", "cutover_command", () => run(from, "/bin/sh", ["-ec", script], undefined, { ...fresh, OPENLUP_STARTER_PORT: undefined, PROJECT: project, CONFIGURATION: "coffee", PORT: String(port) }, expected), { labels: [step], exit: true });
    };
    const lockedCutover = cutover("locked_cutover", 2);
    site("stale_lock_remedy", "stale_lock_remedy", () => assert(!(lockedCutover.status !== 2 || !lockedCutover.stderr.includes("starter_runtime_database_lock_held")
      || !lockedCutover.stderr.includes("docker ps --filter volume=" + volume))), { exit: lockedCutover.status });
    recover("documented_predecessor_recovery");
    cutover("documented_cutover_from_fresh_shell");
    const upgradedApp = site("cutover_application", "cutover_application", () => container("application"), { exit: true });
    site("cutover_application_replacement", "cutover_application_replacement", () => assert(upgradedApp && upgradedApp !== predecessorApp));
    const continuity = await readSettlementContinuity("cutover_receipt", settled);
    site("settled_data_continuity", "settled_data_continuity", () => assert(continuity.matches));
    mark("settled_data_continuity_and_original_receipt", "settled data continuity and original receipt");
    mark("original_receipt_and_keyed_records_checked_before_startup_replay", "original receipt and keyed records checked before startup replay");
    const recovered = site("recovery_logs", "recovery_logs", () => compose("logs", "--no-color", "database"), { exit: true });
    site("predecessor_recovery_missing", "predecessor_recovery_missing",
      () => assert(/database system was interrupted|automatic recovery in progress/u.test(recovered.stdout)), { exit: recovered.status });
    const initial = site("cutover_credential_read", "cutover_credential_read", () => readFileSync(source, "utf8").trim());
    const verifier = (step: string, ...ordinals: number[]) => site("runtime_verifier", "runtime_verifier",
      () => rawSql("select rolpassword from pg_authid where rolname = 'starter_runtime'", "postgres"), { labels: [step, ...ordinals], exit: true });
    const live = identity("cutover");
    site("cutover_identity", "cutover_identity", () => assert(live[0] !== original[0] &&
      live[1]?.split(" ").at(-1) === original[1]?.split(" ").at(-1) && live[2] === original[2] && live[3] === "/etc/postgresql/starter-pg-hba.conf"));
    const liveSeed = retained("cutover");
    site("cutover_seed_changed", "cutover_seed_changed", () => assert.deepEqual(liveSeed, before));
    const cutoverResponse = await site("cutover_configuration_request", "cutover_configuration_request", () => fetch(`${origin}/api/config`));
    site("cutover_configuration_http", "cutover_configuration_http", () => assert.equal(cutoverResponse.status, 200));
    const cutoverEnvelope = await site("cutover_configuration_decode", "cutover_configuration_decode",
      () => cutoverResponse.json() as Promise<{ config?: { id?: unknown } }>);
    site("cutover_configuration_selection", "cutover_configuration_selection", () => assert.equal(cutoverEnvelope?.config?.id, "coffee"));
    const projectRecord = site("cutover_project_record_read", "cutover_project_record_read", () => readFileSync(projectFile, "utf8"));
    site("cutover_project_record_match", "cutover_project_record_match", () => assert.equal(projectRecord, project + "\n"));
    mark("occupied_same_volume_file_upgrade", "occupied same-volume file upgrade");
    mark("verbatim_documented_cutover", "verbatim documented cutover from a fresh shell preserves the custom project, coffee configuration and listener port");
    const committedVerifier = verifier("cutover");
    site("startup_replay", "startup_replay", () => up(), { exit: true });
    const replayCredential = site("replay_credential_read", "replay_credential_read", () => readFileSync(source, "utf8").trim());
    site("credential_replay_changed", "credential_replay_changed", () => assert.equal(replayCredential, initial));
    const replayVerifier = verifier("replay");
    site("verifier_replay_changed", "verifier_replay_changed", () => assert.equal(replayVerifier, committedVerifier));
    const replayIdentity = identity("replayed");
    site("predecessor_retry_identity", "predecessor_retry_identity", () => assert.equal(replayIdentity[2], original[2]));
    const replaySeed = retained("replayed");
    site("predecessor_retry_seed", "predecessor_retry_seed", () => assert.deepEqual(replaySeed, before));
    mark("predecessor_sigkill", "predecessor SIGKILL with stale PID and legacy HBA, documented recovery and retry");
    mark("credential_verifier_replay", "ordinary runtime credential and verifier replay");

    // Teardown can replace the bridge and its addresses before another fresh connection.
    const databaseIp = (labels: readonly ProofLabel[]) => {
      const db = site("tcp_bridge_container", "tcp_bridge_container", () => container("database"), { labels, exit: true });
      const address = site("tcp_bridge_inspect", "tcp_bridge_inspect", () => run(from, "docker", ["inspect", "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", db]).stdout.trim(), { labels, exit: true });
      site("tcp_bridge_address", "tcp_bridge_address", () => assert(isIPv4(address) && !address.startsWith("127.")), { labels, exit: 0 });
      return address;
    };
    const clientDB = site("client_database_container", "client_database_container", () => container("database"), { exit: true });
    const postgresImage = site("database_image", "database_image", () => run(from, "docker", ["inspect", "--format", "{{.Config.Image}}", clientDB]).stdout.trim(), { exit: true });
    const passfile = join(scratch, "client.pgpass");
    const peerPassfile = "/run/proof.pgpass";
    const separator = "\u0000client-diagnostic\n";
    const probeCommand = 'env -0 >&2; printf "\\000client-diagnostic\\n" >&2; exec /usr/bin/psql "$@"';
    function tcpClient(role: string, clientIndex: number, password: string, expected: Expected,
      user = "starter_runtime", db = "neutral_store") {
      const labels = [role, clientIndex], peer = clientIndex === 0;
      const address = databaseIp(labels);
      const connect = ["-XAtw", "-h", address, "-p", "5432", "-U", user, "-d", db, "-c", "select session_user"];
      const clientEnv: NodeJS.ProcessEnv = { ...env, PGCONNECT_TIMEOUT: "4", LC_ALL: "C", PGPASSFILE: passfile };
      delete clientEnv.PGPASSWORD;
      site("tcp_passfile_write", "tcp_passfile_write", () => writeFileSync(passfile,
        password ? `${address}:5432:${db}:${user}:${password}\n` : "", { mode: 0o600, flag: "wx" }), { labels });
      try {
        const probe = ["-ec", probeCommand, "client", ...connect];
        const result = peer
          ? site("tcp_peer_command", "tcp_peer_command", () => run(from, dockerBin, ["run", "--rm", "--network", project + "_default", "--entrypoint", "/bin/sh",
            "--mount", `type=bind,src=${passfile},dst=${peerPassfile},readonly`,
            "--env", "PGPASSFILE=" + peerPassfile, "--env", "PGCONNECT_TIMEOUT=4", "--env", "LC_ALL=C",
            postgresImage, ...probe], undefined, clientEnv, expected), { labels, exit: true })
          : site("tcp_native_command", "tcp_native_command", () => run(from, "/bin/sh", probe, undefined, clientEnv, expected), { labels, exit: true });
        const parts = result.stderr.split(separator);
        site("tcp_environment_probe", "tcp_environment_probe", () => assert(parts.length === 2), { labels, exit: result.status });
        const [environment, stderr] = parts as [string, string];
        site("tcp_password_environment", "tcp_password_environment", () => assert(!environment.split("\0").some(entry => entry.startsWith("PGPASSWORD="))), { labels, exit: result.status });
        return { ...result, stderr };
      } catch (error) { failures.keep(error); }
      finally {
        failures.attempt(() => site("tcp_passfile_remove", "tcp_passfile_remove", () => rmSync(passfile), { labels }));
        failures.finish();
      }
      return undefined as never;
    }
    const refusedPassword = site("tcp_refused_password_random", "tcp_refused_password_random", () => randomBytes(32)).toString("hex");

    for (const [index] of ["peer", "native"].entries()) {
      const noPassword = tcpClient("passwordless", index, "", "finding");
      const wrong = tcpClient("wrong_password", index, refusedPassword, "finding");
      site("tcp_passwordless_admission", "tcp_passwordless_admission", () => assert(noPassword.status !== 0 && /no password supplied/u.test(noPassword.stderr)), { labels: [index], exit: noPassword.status });
      site("tcp_wrong_password_admission", "tcp_wrong_password_admission", () => assert(wrong.status !== 0 && /password authentication failed/u.test(wrong.stderr)), { labels: [index], exit: wrong.status });
      const valid = tcpClient("valid_login", index, initial, 0);
      site("tcp_valid_login_admission", "tcp_valid_login_admission", () => assert.equal(valid.stdout.trim(), "starter_runtime"), { labels: [index], exit: valid.status });
      const deniedRole = tcpClient("denied_role", index, "", "finding", "postgres");
      site("tcp_denied_role_admission", "tcp_denied_role_admission", () => assert(/pg_hba.conf rejects connection/u.test(deniedRole.stderr)), { labels: [index], exit: deniedRole.status });
      const deniedDB = tcpClient("denied_database", index, "", "finding", "starter_runtime", "postgres");
      site("tcp_denied_database_admission", "tcp_denied_database_admission", () => assert(/pg_hba.conf rejects connection/u.test(deniedDB.stderr)), { labels: [index], exit: deniedDB.status });
    }
    mark("native_host_and_peer_scram_admission", "native host and peer SCRAM admission");
    const superuser = site("owner_socket_superuser", "owner_socket_superuser", () => rawSql("select session_user", "postgres"), { exit: true });
    site("owner_socket", "owner_socket", () => assert.equal(superuser, "postgres"), { exit: 0 });
    const installer = site("owner_socket_installer", "owner_socket_installer", () => rawSql("select session_user"), { exit: true });
    site("owner_socket_installer_login", "owner_socket_installer_login", () => assert.equal(installer, "starter_install"), { exit: 0 });
    const passwordless = site("owner_socket_passwordless", "owner_socket_passwordless",
      () => rawSql("select (rolpassword is null)::text from pg_authid where rolname='postgres'", "postgres"), { exit: true });
    site("owner_socket_passwordless_login", "owner_socket_passwordless_login", () => assert.equal(passwordless, "true"), { exit: 0 });
    const socket = (user: string, db: string) => composeWithExit(project,
      ["exec", "-T", "database", "psql", "-XAtw", "-U", user, "-d", db, "-c", "select session_user"], "finding");
    for (const [index, [user, db]] of [["postgres", "neutral_store"], ["starter_install", "postgres"], ["starter_runtime", "neutral_store"],
      ["starter_restore", "neutral_store"], ["openlup_catalog_publication", "neutral_store"]].entries()) {
      const denied = site("socket_psql", "socket_psql", () => socket(user!, db!), { labels: [index], exit: true });
      site("socket_denial", "socket_denial", () => assert(/pg_hba.conf rejects connection/u.test(denied.stderr)), { labels: [index], exit: denied.status });
    }
    const hbaRules = site("runtime_hba_rules", "runtime_hba_rules", () => rawSql("select type, database, user_name, address, netmask, auth_method, options, error from pg_hba_file_rules order by line_number", "postgres"), { exit: true });
    site("parsed_runtime_hba", "parsed_runtime_hba", () => assert(!(hbaRules !== [
      "local|{postgres}|{postgres}|||trust||",
      "local|{neutral_store}|{starter_install}|||trust||",
      "local|{all}|{all}|||reject||",
      "host|{neutral_store}|{openlup_catalog_publication}|all||scram-sha-256||",
      "host|{neutral_store}|{starter_runtime}|all||scram-sha-256||",
      "host|{all}|{all}|all||reject||",
    ].join("\n"))), { exit: 0 });
    for (const [index, host] of ["", " host=127.0.0.1"].entries()) {
      const result = site("replication_refusal", "replication_refusal", () => composeWithExit(project, ["exec", "-T", "database", "psql", "-XAtw", "user=postgres dbname=postgres replication=true" + host, "-c", "IDENTIFY_SYSTEM"], "not_success"), { labels: [index], exit: true });
      site("physical_replication_hba", "physical_replication_hba", () => assert(!(result.status === 0 || !/no pg_hba.conf entry|pg_hba.conf rejects connection/u.test(result.stderr))), { labels: [index], exit: result.status });
    }
    mark("ordered_hba_rules_and_physical_replication_refusal", "ordered HBA rules and physical replication refusal");
    const publication = site("publication_input", "publication_input", () => compose("exec", "-T", "application", "cat", "/application/.context/catalogue-builds/.publication-password").stdout.trim(), { exit: true });

    const publicationLogin = tcpClient("publication_login", 0, publication, 0, "openlup_catalog_publication");
    site("publication_login_valid", "publication_login_valid", () => assert.equal(publicationLogin.stdout.trim(), "openlup_catalog_publication"), { exit: publicationLogin.status });
    const runtimeAsPublication = tcpClient("runtime_as_publication", 0, initial, "finding", "openlup_catalog_publication");
    site("publication_isolation", "publication_isolation", () => assert(/password authentication failed/u.test(runtimeAsPublication.stderr)), { exit: runtimeAsPublication.status });
    const fallback = site("fallback_hba", "fallback_hba", () => compose("exec", "-T", "database", "sh", "-c", 'cat "$PGDATA/pg_hba.conf"').stdout.trim(), { exit: true });
    site("occupied_fallback", "occupied_fallback", () => assert.equal(fallback, "local all all reject\nhost all all all reject"), { exit: 0 });
    const permission = site("fallback_permissions", "fallback_permissions", () =>
      compose("exec", "-T", "database", "sh", "-c", 'stat -c "%U:%G %a" "$PGDATA/pg_hba.conf"').stdout.trim(), { exit: true });
    site("occupied_fallback_permissions", "occupied_fallback_permissions", () => assert.equal(permission, "postgres:postgres 600"), { exit: 0 });
    mark("installer_socket_publication_and_occupied_fallback", "installer socket, publication and occupied fallback");

    const different = await createSettledReceipt("different_paid_receipt");
    const substituted = await readSettlementContinuity("substituted_receipt", settled, project, different.reference);
    site("different_paid_receipt_red_control", "different_paid_receipt_red_control", () => assert(!(different.reference.orderRef === settled.reference.orderRef || substituted.records !== settled.facts
      || !substituted.receipt.ok || substituted.receipt.value?.status !== "paid"
      || substituted.receipt.value.orderRef !== different.reference.orderRef || substituted.matches)));
    mark("different_paid_receipt_refused_against_the_original_records", "different paid receipt refused against the original records");

    const mounted = ["renewal", "care", "checkout-recovery"];
    const renewalConfig = join(from, "owned/renewal.config.ts");
    const oldRenewal = site("renewal_config_read", "renewal_config_read", () => readFileSync(renewalConfig, "utf8"));
    site("renewal_fixture", "renewal_fixture", () => assert(oldRenewal.includes("enabled: false")));
    site("renewal_config_write", "renewal_config_write", () => writeFileSync(renewalConfig, oldRenewal.replace("enabled: false", "enabled: true")));
    site("renewal_fixture_start", "renewal_fixture_start", () => up(), { exit: true });
    const olderCompose = env.OPENLUP_STARTER_COMPOSE_V2;
    const currentCompose = env.OPENLUP_STARTER_COMPOSE_V5;
    site("both_compose_releases_required", "both_compose_releases_required", () => assert(olderCompose && currentCompose));
    const mountedExec = `PROJECT=$( (cd .context && cat compose-project) 2>/dev/null) && [ -n "$PROJECT" ] ||
      { printf '%s\\n' 'Run ./lifecycle up first.' >&2; exit 1; }
      exec "$1" --project-name "$PROJECT" exec -T application ./lifecycle "\${@:2}"`;
    const exec = (release: string, command: string, args: string[], input?: string, expected = 0) =>
      run(from, "bash", ["-c", mountedExec, "starter", release, command, ...args], input, env, expected);
    const configuration = ["--configuration", "coffee"];
    const policy = site("mounted_preview_policy_encode", "mounted_preview_policy_encode", () => JSON.stringify({ revision: "runtime-preview-fixture", renewalProtectionDays: 21 }));
    const sku = site("coffee_stock_sku", "coffee_stock_sku", () => rawSql("select sku from public.fulfillment_stock_current where source_key='starter-demo:coffee' order by sku limit 1"), { exit: true });
    site("invalid_stock_fixture_sku", "invalid_stock_fixture_sku", () => assert(/^[A-Za-z0-9_-]+$/u.test(sku)), { exit: 0 });
    const stock = site("coffee_stock_quantity", "coffee_stock_quantity", () => rawSql("select for_sale_quantity from public.fulfillment_stock_current where source_key='starter-demo:coffee' and sku='" + sku + "'"), { exit: true });
    site("supplements_stock_fixture", "supplements_stock_fixture", () => rawSql(`insert into public.fulfillment_stock_current (source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
      inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
      select 'starter-demo:supplements',sku,0,0,0,inventory_class,last_synced_at,stale_after,sync_run_id,'runtime-stock-control',operation_fingerprint
      from public.fulfillment_stock_current where source_key='starter-demo:coffee' and sku='${sku}'`), { exit: true });
    const jobs = ["subscription-renewal:demo:coffee", "subscription-care:coffee", "starter-checkout:coffee"];
    const jobCount = (name: string, successful = false) => Number(rawSql(
      "select count(*) from platform_job_runs where job_name = '" + name + "'" + (successful ? " and status = 'success'" : "")));
    const preview = ["preview", "inventory_renewal_protection", ...configuration, "--value", "-", "--sku", sku, "--json"];
    const exerciseJobs = (role: string, releaseIndex: number, release: string, missingBind = false) => {
      for (const [index, command] of mounted.entries()) {
        const labels = [role, releaseIndex, index], name = jobs[index]!;
        const beforePass = site("mounted_job_count_before", "mounted_job_count_before", () => jobCount(name, !missingBind), { labels, exit: true });
        const result = site("mounted_job_command", "mounted_job_command", () => exec(release, command, configuration, undefined, missingBind ? 2 : 0), { labels, exit: true });
        if (missingBind) {
          site("mounted_job_missing_bind", "mounted_job_missing_bind",
            () => assert(result.stderr.includes("starter_runtime_credential_read_failed")), { labels, exit: result.status });
          const refused = site("mounted_job_count_refused", "mounted_job_count_refused", () => jobCount(name), { labels, exit: true });
          site("mounted_job_refusal_count", "mounted_job_refusal_count", () => assert(refused === beforePass), { labels });
        } else {
          const completed = site("mounted_job_count_completed", "mounted_job_count_completed", () => jobCount(name, true), { labels, exit: true });
          site("mounted_job_claim", "mounted_job_claim", () => assert(!(completed <= beforePass)), { labels });
        }
      }
    };
    const releases = [[olderCompose!, "2.40.3"], [currentCompose!, "5.5.0"]] as const;
    for (const [releaseIndex, [release, expected]] of releases.entries()) {
      const version = site("compose_version_query", "compose_version_query", () => run(from, release, ["version", "--short"]).stdout.trim(), { labels: [releaseIndex], exit: true }).replace(/^v/u, "");
      site("compose_version_required", "compose_version_required", () => assert(!(version !== expected)), { labels: [releaseIndex], exit: 0 });
      site("settings_show", "settings_show", () => exec(release, "settings", ["show", "inventory_renewal_protection", "--json"]).stdout.trim(), { labels: [releaseIndex], exit: true });
      const previewResult = site("settings_preview_exec", "settings_preview_exec", () => exec(release, "settings", preview, policy), { labels: [releaseIndex], exit: true });
      const result = site("settings_preview_format", "settings_preview_format", () => JSON.parse(previewResult.stdout), { labels: [releaseIndex], exit: previewResult.status });
      const at = site("settings_preview_timestamp", "settings_preview_timestamp", () => new Date(result.asOf).toISOString(), { labels: [releaseIndex], exit: previewResult.status });
      const quantity = (source: string) => Number(rawSql(`select public.inventory_available_to_promise(
        'starter-demo:${source}','${sku}','${at}',false)->>'available_quantity'`));
      const row = result?.effect?.skus?.[0];
      site("settings_preview_source", "settings_preview_source", () => assert(stock && row?.sku === sku && row.source === "provider"), { labels: [releaseIndex] });
      const coffee = site("preview_coffee_quantity", "preview_coffee_quantity", () => quantity("coffee"), { labels: [releaseIndex], exit: true });
      site("settings_preview_coffee_stock", "settings_preview_coffee_stock", () => assert(row.currentAvailableForNewPurchases === coffee), { labels: [releaseIndex] });
      const coffeeControl = site("comparison_coffee_quantity", "comparison_coffee_quantity", () => quantity("coffee"), { labels: [releaseIndex], exit: true });
      const supplements = site("comparison_supplements_quantity", "comparison_supplements_quantity", () => quantity("supplements"), { labels: [releaseIndex], exit: true });
      site("nondefault_stock_source", "nondefault_stock_source", () => assert(coffeeControl !== supplements), { labels: [releaseIndex] });
      exerciseJobs("mounted", releaseIndex, release);
      const held = projectFile + ".held";
      site("project_record_hold", "project_record_hold", () => renameSync(projectFile, held), { labels: [releaseIndex] });
      try {
        const missing = site("missing_project_exec", "missing_project_exec", () => exec(release, "renewal", configuration, undefined, 1), { labels: [releaseIndex], exit: true });
        site("missing_project_refusal", "missing_project_refusal", () => assert(missing.stderr.includes("Run ./lifecycle up first.")), { labels: [releaseIndex], exit: missing.status });
      } catch (error) { failures.keep(error); }
      finally { failures.attempt(() => site("project_record_restore", "project_record_restore", () => renameSync(held, projectFile), { labels: [releaseIndex] })); }
      failures.finish();
      const unchangedApp = site("handoff_application_before", "handoff_application_before", () => container("application"), { labels: [releaseIndex], exit: true });
      const unchangedDatabase = site("handoff_database_before", "handoff_database_before", () => container("database"), { labels: [releaseIndex], exit: true });
      for (const [serviceIndex, service] of ["database", "application"].entries()) {
        const denied = site("required_handoff_command", "required_handoff_command", () => run(from, release, ["--project-name", project, "up", "--no-build", "--force-recreate", "-d", service], undefined, { ...env, OPENLUP_STARTER_RUNTIME_SOURCE: source }, "not_success"), { labels: [releaseIndex, serviceIndex], exit: true });
        const labels = [releaseIndex, serviceIndex];
        site("required_handoff_refusal", "required_handoff_refusal", () => assert(denied.stderr.includes("starter_runtime_preflight_handoff_missing")), { labels, exit: denied.status });
        const appAfter = site("handoff_application_after", "handoff_application_after", () => container("application"), { labels, exit: true });
        site("required_handoff_application_unchanged", "required_handoff_application_unchanged", () => assert.equal(appAfter, unchangedApp), { labels });
        const dbAfter = site("handoff_database_after", "handoff_database_after", () => container("database"), { labels, exit: true });
        site("required_handoff_database_unchanged", "required_handoff_database_unchanged", () => assert.equal(dbAfter, unchangedDatabase), { labels });
      }
      mark("project_record_commands_settings_job_readback_and_startup_gate_on_compose", "project-record commands, settings, job readback and startup gate on Compose " + expected, releaseIndex);
    }
    const { prepareRuntimeHandoff } = await site("runtime_handoff_import", "runtime_handoff_import",
      () => import("../../examples/neutral-store/host/runtime-database.ts"));
    const handoff = site("missing_bind_handoff_prepare", "missing_bind_handoff_prepare", () => prepareRuntimeHandoff(project, [from]));
    const override = join(scratch, "missing-bind.yaml");
    try {
      site("missing_bind_override_write", "missing_bind_override_write",
        () => writeFileSync(override, 'services:\n  application:\n    command: ["sleep", "infinity"]\n    volumes: !override []\n'));
      site("missing_bind_fixture", "missing_bind_fixture", () => run(from, "docker", ["compose", "--project-name", project, "-f", "compose.yaml", "-f", override,
        "up", "--no-deps", "--no-build", "--force-recreate", "-d", "application"], undefined, { ...env, ...handoff.environment }), { exit: true });
    } catch (error) { failures.keep(error); }
    finally { failures.attempt(() => site("missing_bind_handoff_cleanup", "missing_bind_handoff_cleanup", () => handoff.cleanup())); }
    failures.finish();
    for (const [releaseIndex, [release]] of releases.entries()) {
      exerciseJobs("missing_bind", releaseIndex, release, true);
      for (const [modeIndex, mode] of ["show", "preview"].entries()) {
        const labels = [releaseIndex, modeIndex];
        const helpResult = site("unbound_settings_help_exec", "unbound_settings_help_exec",
          () => exec(release, "settings", [mode, "--help", "--json"]), { labels, exit: true });
        const help = site("unbound_settings_help_format", "unbound_settings_help_format", () => JSON.parse(helpResult.stdout), { labels, exit: helpResult.status });
        site("settings_help_output", "settings_help_output", () => assert(help?.help?.includes("settings (experimental) " + mode)), { labels, exit: helpResult.status });
      }
      const result = site("unbound_settings_preview_exec", "unbound_settings_preview_exec", () => exec(release, "settings", preview, policy, 2), { labels: [releaseIndex], exit: true });
      const refusedPreview = site("unbound_settings_preview_format", "unbound_settings_preview_format", () => JSON.parse(result.stdout), { labels: [releaseIndex], exit: result.status });
      site("unbound_settings_preview_refusal", "unbound_settings_preview_refusal", () => assert.equal(refusedPreview?.findings?.[0]?.code, "starter_runtime_credential_read_failed"), { labels: [releaseIndex], exit: result.status });
    }
    site("restore_application_bind", "restore_application_bind", () => up(), { exit: true });
    for (const [releaseIndex, [release]] of releases.entries()) exerciseJobs("restored_bind", releaseIndex, release);
    mark("lifecycle_settings_show_and_preview_help_work_without_a_credential_bind_on_both_compose_versions", "lifecycle settings show and preview help work without a credential bind on both Compose versions");
    mark("missing_credential_bind_refusal_and_restoration_on_both_compose_versions", "missing credential bind refusal and restoration on both Compose versions");

    const firstAdmin = `import {argv} from 'node:process';
      import {runtimeConnectionString} from './host/runtime-database.ts';
      import {createPostgresOperatorIdentityStore} from '@openlup/platform/identity';
      const operators=createPostgresOperatorIdentityStore({connectionString:await runtimeConnectionString()});
      try { await operators.bootstrapFirstAdministrator({email:argv[1]}); } finally { await operators.close(); }`;
    site("first_administrator", "first_administrator", () => compose("exec", "-T", "--user", "node", "application", "node", "--input-type=module", "-e", firstAdmin, "operator@example.test").stdout.trim(), { exit: true });
    const administrators = site("first_administrator_count", "first_administrator_count",
      () => rawSql("select count(*) from public.platform_human_principals where email='operator@example.test'"), { exit: true });
    site("first_administrator_invitation", "first_administrator_invitation", () => assert.equal(administrators, "1"), { exit: 0 });
    mark("first_administrator_invitation", "first administrator invitation through mounted runtime resolver");

    const afterRotation = site("rotation_credential_random", "rotation_credential_random", () => randomBytes(32)).toString("hex");
    const previousApp = site("pre_rotation_application", "pre_rotation_application", () => container("application"), { exit: true });
    const replacement = source + ".next";
    site("rotation_replacement_write", "rotation_replacement_write", () => writeFileSync(replacement, afterRotation + "\n", { mode: 0o444 }));
    site("rotation_replacement_rename", "rotation_replacement_rename", () => renameSync(replacement, source));
    const rotated = site("rotation_handoff_prepare", "rotation_handoff_prepare", () => prepareRuntimeHandoff(project, [from]));
    try {
      site("interrupt_after_installer", "interrupt_after_installer", () => run(from, "docker", ["compose", "--project-name", project, "run", "--rm", "-T", "--no-deps",
        "installation", "node", "lifecycle.mjs", "install", "--configuration", "coffee", "--json"], undefined, { ...env, ...rotated.environment }), { exit: true });
    } catch (error) { failures.keep(error); }
    finally { failures.attempt(() => site("rotation_handoff_cleanup", "rotation_handoff_cleanup", () => rotated.cleanup())); }
    failures.finish();
    const changedVerifier = verifier("interrupted_installer");
    site("interrupted_verifier_unchanged", "interrupted_verifier_unchanged", () => assert.notEqual(changedVerifier, committedVerifier));
    const interruptedInstallerApp = site("interrupted_installer_application", "interrupted_installer_application", () => container("application"), { exit: true });
    site("interrupted_installer_app_unchanged", "interrupted_installer_app_unchanged", () => assert.equal(interruptedInstallerApp, previousApp));
    const interruptedResponse = await site("interrupted_replacement_http_request", "interrupted_replacement_http_request", () => fetch(`${origin}/api/config`));
    site("interrupted_replacement_fixture", "interrupted_replacement_fixture", () => assert.equal(interruptedResponse.status, 200));
    const stale = site("stale_mount_probe_command", "stale_mount_probe_command", () => composeWithExit(project, ["exec", "-T", "application", "node", "lifecycle.mjs", "runtime-probe"], 2), { exit: true });
    site("stale_mount_probe_refusal", "stale_mount_probe_refusal", () => assert.equal(stale.stdout.trim(), "starter_runtime_database_auth_failed"), { exit: stale.status });
    site("resume_runtime_rotation", "resume_runtime_rotation", () => up(), { exit: true });
    const resumedVerifier = verifier("resumed_rotation");
    site("resumed_rotation_verifier_unchanged", "resumed_rotation_verifier_unchanged", () => assert.equal(resumedVerifier, changedVerifier));
    const resumedApp = site("resumed_rotation_application", "resumed_rotation_application", () => container("application"), { exit: true });
    site("resumed_rotation_app_changed", "resumed_rotation_app_changed", () => assert.notEqual(resumedApp, previousApp));
    const rotatedLogin = tcpClient("resumed_rotation_login", 1, afterRotation, 0);
    site("resumed_rotation_login_valid", "resumed_rotation_login_valid", () => assert.equal(rotatedLogin.stdout.trim(), "starter_runtime"), { exit: rotatedLogin.status });
    const rotatedOld = tcpClient("resumed_rotation_old_login", 1, initial, "finding");
    site("rotation_failed", "rotation_failed", () => assert(/password authentication failed/u.test(rotatedOld.stderr)), { exit: rotatedOld.status });
    mark("interrupted_credential_recreation", "credential replacement, interrupted recreation and fresh runtime read");

    const heldSource = source + ".held";
    const rotationScript = site("rotation_recipe", "rotation_recipe", () => recipe("Rotate the runtime credential"));
    site("rotation_from_fresh_shell", "rotation_from_fresh_shell", () => run(from, "/bin/sh", ["-ec", rotationScript], undefined,
      { ...fresh, OPENLUP_STARTER_PORT: undefined, CONFIGURATION: "coffee", PORT: String(port) }), { exit: true });
    const rotatedResponse = await site("rotation_configuration_request", "rotation_configuration_request", () => fetch(`${origin}/api/config`));
    site("rotation_configuration_http", "rotation_configuration_http", () => assert.equal(rotatedResponse.status, 200));
    const rotatedEnvelope = await site("rotation_configuration_decode", "rotation_configuration_decode",
      () => rotatedResponse.json() as Promise<{ config?: { id?: unknown } }>);
    site("rotation_configuration", "rotation_configuration", () => assert.equal(rotatedEnvelope?.config?.id, "coffee"));
    const current = site("rotated_credential_read", "rotated_credential_read", () => readFileSync(source, "utf8").trim());
    const currentVerifier = verifier("documented_rotation");
    site("rotation_credential_replaced", "rotation_credential_replaced", () => assert.notEqual(current, afterRotation));
    const currentLogin = tcpClient("documented_rotation_login", 1, current, 0);
    site("documented_rotation_login_valid", "documented_rotation_login_valid", () => assert.equal(currentLogin.stdout.trim(), "starter_runtime"), { exit: currentLogin.status });
    const currentOld = tcpClient("documented_rotation_old_login", 1, afterRotation, "finding");
    site("documented_rotation_old_login_refused", "documented_rotation_old_login_refused", () => assert(/password authentication failed/u.test(currentOld.stderr)), { exit: currentOld.status });
    const rotatedDB = identity("documented_rotation");
    site("documented_rotation_database_retained", "documented_rotation_database_retained", () => assert.equal(rotatedDB[2], original[2]));
    const rotatedProject = site("rotation_project_record_read", "rotation_project_record_read", () => readFileSync(projectFile, "utf8"));
    site("stopped_rotation", "stopped_rotation", () => assert.equal(rotatedProject, project + "\n"));
    mark("verbatim_documented_rotation", "verbatim documented rotation preserves the custom project, coffee configuration and listener port");

    function refusal(labels: readonly ProofLabel[], result: ReturnType<typeof run>, code: string, jsonMode: boolean) {
      const options = { labels, exit: result.status };
      const observed = jsonMode
        ? site("refusal_envelope_decode", "refusal_envelope_decode", () => JSON.parse(result.stdout), options)?.findings?.[0]?.code
        : result.stderr.split("\n").find(line => /^starter_[a-z0-9_]+$/u.test(line));
      site("refusal_finding", "refusal_finding", () => assert(observed === code), options);
      if (!jsonMode) site("refusal_text_details", "refusal_text_details",
        () => assert(["Cause:", "Fix:", "Recheck:"].every(label => result.stderr.includes(label))), options);
    }
    const projectBefore = site("before_project_mismatch", "before_project_mismatch", () => container("application"), { exit: true });
    const wrongProject = site("wrong_project", "wrong_project", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, selectNext, 2), { exit: true });
    refusal(["wrong_project"], wrongProject, "starter_runtime_project_mismatch", true);
    site("mismatch_project_guidance", "mismatch_project_guidance", () => assert(wrongProject.stdout.includes("./lifecycle down")), { exit: wrongProject.status });
    const mismatchRecord = site("mismatch_project_record_read", "mismatch_project_record_read", () => readFileSync(projectFile, "utf8"));
    site("mismatch_project_record_unchanged", "mismatch_project_record_unchanged", () => assert.equal(mismatchRecord, project + "\n"));
    const mismatchApp = site("after_project_mismatch", "after_project_mismatch", () => container("application"), { exit: true });
    site("mismatch_project_application_unchanged", "mismatch_project_application_unchanged", () => assert.equal(mismatchApp, projectBefore));
    const unused = site("unused_project", "unused_project", () => run(from, dockerBin,
      ["ps", "-aq", "--filter", "label=com.docker.compose.project=" + alternate]).stdout.trim(), { exit: true });
    site("other_project_mutation", "other_project_mutation", () => assert(!unused), { exit: 0 });
    site("missing_credential_hold", "missing_credential_hold", () => renameSync(source, heldSource));
    try { site("stop_with_missing_credential", "stop_with_missing_credential", () => run(from, "./lifecycle", ["down"], undefined, fresh), { exit: true }); }
    catch (error) { failures.keep(error); }
    finally { failures.attempt(() => site("missing_credential_restore", "missing_credential_restore", () => renameSync(heldSource, source))); }
    failures.finish();
    const downRecord = site("down_project_record_exists", "down_project_record_exists", () => existsSync(projectFile));
    site("down_did_not_clear_project", "down_did_not_clear_project", () => assert(!downRecord));
    const alternateSource = join(dirname(dirname(source)), alternate, "runtime-password");
    try {
      const existingVolumes = site("replacement_volume_inventory", "replacement_volume_inventory", () => run(from, dockerBin,
        ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + alternate]).stdout.trim(), { exit: true });
      site("replacement_volume_not_fresh", "replacement_volume_not_fresh", () => assert(!existingVolumes), { exit: 0 });
      site("start_second_project", "start_second_project", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, selectNext), { exit: true });
      const alternatePassword = site("alternate_credential_read", "alternate_credential_read", () => readFileSync(alternateSource, "utf8").trim());
      const alternateRecord = site("alternate_project_record_read", "alternate_project_record_read", () => readFileSync(projectFile, "utf8"));
      site("second_project_record", "second_project_record", () => assert(alternateRecord === alternate + "\n" && alternatePassword !== current));
      const replacement = identity("blank_replacement", alternate);
      site("blank_replacement_volume_identity", "blank_replacement_volume_identity",
        () => assert(replacement[1]?.split(" ").at(-1) === alternate + "_database" && replacement[2] !== live[2]));
      const listener = site("replacement_listener", "replacement_listener", () => composeFor(alternate, "port", "application", String(port)).stdout.trim(), { exit: true });
      site("replacement_listener_identity", "replacement_listener_identity", () => assert.equal(listener, `127.0.0.1:${port}`), { exit: 0 });
      const blankOrders = site("blank_replacement_order_count", "blank_replacement_order_count",
        () => rawSql("select count(*) from public.commerce_orders", "neutral_store", alternate), { exit: true });
      site("blank_replacement_orders", "blank_replacement_orders", () => assert.equal(blankOrders, "0"), { exit: 0 });
      const missing = await readSettlementContinuity("blank_replacement_receipt", settled, alternate);
      const absent = site("blank_replacement_record_format", "blank_replacement_record_format", () => JSON.parse(missing.records), { exit: 0 }) as Record<string, unknown[]>;
      site("blank_replacement_volume_red_control", "blank_replacement_volume_red_control", () => assert(!(Object.values(absent).some(rows => rows.length) || missing.receipt.ok
        || missing.receipt.code !== "starter_recovery_unavailable" || missing.matches)));
      mark("blank_replacement_volume_refused_the_original_order_and_receipt", "blank replacement volume refused the original order and receipt");
      site("stop_second_project", "stop_second_project", () => run(from, "./lifecycle", ["down"], undefined, fresh).stdout.trim(), { exit: true });
    } catch (error) { failures.keep(error); }
    finally {
      failures.attempt(() => site("remove_blank_project", "remove_blank_project", () => run(from, dockerBin,
        ["compose", "--project-name", alternate, "down", "--volumes", "--remove-orphans"], undefined, selectNext), { exit: true }));
      failures.attempt(() => site("remove_blank_state", "remove_blank_state", () => rmSync(dirname(alternateSource), { recursive: true, force: true })));
    }
    failures.finish();
    site("return_to_original_project", "return_to_original_project", () => up(), { exit: true });
    const restoredDB = identity("restored_original");
    site("original_project_changed", "original_project_changed", () => assert.equal(restoredDB[2], original[2]));
    const restoredVerifier = verifier("restored_original");
    site("original_project_verifier_changed", "original_project_verifier_changed", () => assert.equal(restoredVerifier, currentVerifier));
    mark("one_project_per_directory_down_clears_record_and_permits_switching", "one project per directory, down clears record and permits switching");

    const listener = project + "-port-holder";
    try {
      site("occupy_listener_port", "occupy_listener_port", () => run(from, dockerBin, ["run", "-d", "--name", listener,
        "-p", "127.0.0.1::5432", "--entrypoint", "sleep", postgresImage, "120"]).stdout.trim(), { exit: true });
      const portMapping = site("occupied_port", "occupied_port", () => run(from, dockerBin, ["port", listener, "5432/tcp"]).stdout.trim(), { exit: true });
      const occupied = portMapping.match(/^127\.0\.0\.1:([0-9]+)$/u)?.[1];
      site("unsafe_occupied_port", "unsafe_occupied_port", () => assert(occupied && occupied !== "4319"), { exit: 0 });
      const result = site("occupied_listener_refusal", "occupied_listener_refusal", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, { ...env, OPENLUP_STARTER_PORT: occupied }, 2), { exit: true });
      refusal(["occupied_listener"], result, "starter_installation_failed", true);
      site("lost_listener_diagnostic", "lost_listener_diagnostic", () => assert(/port is already allocated|address already in use|failed to bind/u.test(result.stderr)), { exit: result.status });
    } catch (error) { failures.keep(error); }
    finally {
      failures.attempt(() => {
        if (site("listener_holder_inventory", "listener_holder_inventory", () => run(from, dockerBin, ["ps", "-aq", "--filter", "name=^/" + listener + "$"]).stdout.trim(), { exit: true })) {
          site("listener_holder_cleanup", "listener_holder_cleanup", () => run(from, dockerBin, ["rm", "-f", listener]), { exit: true });
        }
      });
    }
    failures.finish();
    site("restart_after_listener_refusal", "restart_after_listener_refusal", () => up(), { exit: true });
    const dockerfile = join(from, "Dockerfile");
    const originalDockerfile = site("proof_dockerfile_read", "proof_dockerfile_read", () => readFileSync(dockerfile));
    const redactedFixture = site("build_fixture_random", "build_fixture_random", () => randomBytes(32)).toString("hex");

    try {
      site("build_fixture_write", "build_fixture_write",
        () => writeFileSync(dockerfile, Buffer.concat([originalDockerfile, Buffer.from(`\nRUN echo '${redactedFixture}' >&2; exit 17\n`)])));
      const build = site("failing_build", "failing_build", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, undefined, 2), { exit: true });
      refusal(["failing_build"], build, "starter_installation_failed", true);
      site("lost_or_unsanitized_build_diagnostic", "lost_or_unsanitized_build_diagnostic", () => assert(!(!build.stderr.includes("exit code: 17") || !build.stderr.includes("[redacted]")
        || build.stderr.includes(redactedFixture))), { exit: build.status });
    } catch (error) { failures.keep(error); }
    finally { failures.attempt(() => site("proof_dockerfile_restore", "proof_dockerfile_restore", () => writeFileSync(dockerfile, originalDockerfile))); }
    failures.finish();
    mark("occupied_listener_and_failing_build_retain_sanitized_docker_diagnostics", "occupied listener and failing build retain sanitized Docker diagnostics");

    const alias = source + ".linked";
    site("credential_hard_link_create", "credential_hard_link_create", () => linkSync(source, alias));
    try {
      refusal(["hard_link"], site("hard_link_refusal", "hard_link_refusal", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", "--json"], undefined, undefined, 2), { exit: true }), "starter_runtime_credential_source_invalid", true);
      const linkedProbe = site("linked_runtime_probe", "linked_runtime_probe", () => composeWithExit(project, ["exec", "-T", "application", "node", "lifecycle.mjs", "runtime-probe"], 2), { exit: true });
      site("linked_reader_admitted", "linked_reader_admitted", () => assert(!(linkedProbe.status !== 2 || linkedProbe.stdout.trim() !== "starter_runtime_credential_read_failed")), { exit: linkedProbe.status });
    } catch (error) { failures.keep(error); }
    finally { failures.attempt(() => site("credential_hard_link_remove", "credential_hard_link_remove", () => rmSync(alias))); }
    failures.finish();
    mark("host_preflight_and_mounted_reader_refuse_hard_links", "host preflight and mounted reader refuse hard links");

    // Refuse shape, permissions and special files before Compose build.
    const installedApp = site("before_invalid_credential_application", "before_invalid_credential_application", () => container("application"), { exit: true });
    for (const [kindIndex, kind] of ["bad-mode", "payload", "fifo"].entries()) {
      site("invalid_credential_hold", "invalid_credential_hold", () => renameSync(source, heldSource), { labels: [kindIndex] });
      try {
        if (kind === "fifo") site("fifo_fixture", "fifo_fixture", () => run(from, "mkfifo", [source]), { labels: [kindIndex], exit: true });
        else site("invalid_credential_write", "invalid_credential_write", () => writeFileSync(source, kind === "payload" ? "DEMO_SETTING=fixture\n" : current + "\n",
          { mode: kind === "bad-mode" ? 0o000 : 0o444 }), { labels: [kindIndex] });
        for (const [modeIndex, mode] of [false, true].entries()) {
          const labels = [kindIndex, modeIndex];
          const rejected = site("credential_source_refusal", "credential_source_refusal", () => run(from, "./lifecycle",
            ["up", "--configuration", "coffee", ...(mode ? ["--json"] : [])], undefined, env, 2), { labels, exit: true });
          refusal(["credential_source", ...labels], rejected, "starter_runtime_credential_source_invalid", mode);
        }
        const app = site("invalid_source_application", "invalid_source_application", () => container("application"), { labels: [kindIndex], exit: true });
        site("invalid_source_application_unchanged", "invalid_source_application_unchanged", () => assert.equal(app, installedApp), { labels: [kindIndex] });
        const invalidVerifier = verifier("invalid_source", kindIndex);
        site("invalid_source_mutation", "invalid_source_mutation", () => assert.equal(invalidVerifier, currentVerifier), { labels: [kindIndex] });
      } catch (error) { failures.keep(error); }
      finally {
        failures.attempt(() => site("invalid_credential_remove", "invalid_credential_remove", () => rmSync(source, { force: true }), { labels: [kindIndex] }));
        failures.attempt(() => site("invalid_credential_restore", "invalid_credential_restore", () => renameSync(heldSource, source), { labels: [kindIndex] }));
      }
      failures.finish();
    }
    mark("invalid_sources_refused_before_build", "invalid sources refused before build");

    const synthetic = site("changed_source_fixture_random", "changed_source_fixture_random", () => randomBytes(24)).toString("hex");
    const wrongPassword = site("auth_fixture_random", "auth_fixture_random", () => randomBytes(32)).toString("hex");
    const shim = join(scratch, "docker");
    site("proof_docker_shim_write", "proof_docker_shim_write", () => writeFileSync(shim, `#!/bin/sh
"${dockerBin}" "$@" || exit $?
case " $STARTER_PROOF_FAULT $* " in
  *" auth "*" run "*" installation "*)
    mv -- "$OPENLUP_STARTER_RUNTIME_SOURCE" "$OPENLUP_STARTER_RUNTIME_SOURCE.held"
    printf '%s\\n' "$STARTER_PROOF_VALUE" > "$OPENLUP_STARTER_RUNTIME_SOURCE"
    chmod 444 "$OPENLUP_STARTER_RUNTIME_SOURCE"
    ;;
  *" auth "*) ;;
  *" --wait database "*)
    mv -- "$OPENLUP_STARTER_RUNTIME_SOURCE" "$OPENLUP_STARTER_RUNTIME_SOURCE.held"
    if [ "$STARTER_PROOF_FAULT" = read ]; then
      printf 'STARTER_SAMPLE=%s\\n' "$STARTER_PROOF_VALUE" > "$OPENLUP_STARTER_RUNTIME_SOURCE"
      chmod 444 "$OPENLUP_STARTER_RUNTIME_SOURCE"
    fi
    ;;
esac
`, { mode: 0o700 }));
    for (const [faultIndex, fault] of ["mount", "read"].entries()) for (const [modeIndex, mode] of [false, true].entries()) {
      try {
        const result = site("changed_source_up", "changed_source_up", () => run(from, "./lifecycle", ["up", "--configuration", "coffee", ...(mode ? ["--json"] : [])], undefined, { ...env, PATH: scratch + ":" + env.PATH, STARTER_PROOF_FAULT: fault, STARTER_PROOF_VALUE: synthetic }, 2), { labels: [faultIndex, modeIndex], exit: true });
        refusal(["changed_source", faultIndex, modeIndex], result, "starter_runtime_credential_" + fault + "_failed", mode);
        const config = site("changed_source_model", "changed_source_model", () => run(from, dockerBin, ["compose", "--project-name", project, "config", "--format", "json"], undefined, { ...env, OPENLUP_STARTER_PREFLIGHT_HANDOFF: "/dev/null", OPENLUP_STARTER_RUNTIME_SOURCE: source }), { labels: [faultIndex, modeIndex], exit: true });
        const model = checked(config);
        const labels = [faultIndex, modeIndex];
        const db = site("changed_source_database", "changed_source_database", () => container("database"), { labels, exit: true });
        const app = site("changed_source_application", "changed_source_application", () => container("application"), { labels, exit: true });
        const inspected = site("inspect_service_environments", "inspect_service_environments", () => run(from, dockerBin,
          ["inspect", "--format", "{{json .Config.Env}}", db, app]).stdout.trim(), { labels, exit: true });
        site("changed_source_reached_environment", "changed_source_reached_environment", () => assert(![model, inspected].some(value =>
          value.includes("STARTER_SAMPLE") || value.includes(synthetic))), { labels });
      } catch (error) { failures.keep(error); }
      finally { failures.attempt(() => {
        const labels = [faultIndex, modeIndex];
        if (site("changed_held_credential_exists", "changed_held_credential_exists", () => existsSync(heldSource), { labels })) {
          failures.attempt(() => site("changed_credential_remove", "changed_credential_remove", () => rmSync(source, { force: true }), { labels }));
          failures.attempt(() => site("changed_credential_restore", "changed_credential_restore", () => renameSync(heldSource, source), { labels }));
        }
      }); }
      failures.finish();
      site("restore_changed_source", "restore_changed_source", () => up(), { labels: [faultIndex, modeIndex], exit: true });
    }
    mark("changed_source_mount_and_bounded_read_refusal_with_environment_isolation", "changed source mount and bounded read refusal with environment isolation");
    for (const [modeIndex, mode] of [false, true].entries()) {
      const labels = [modeIndex];
      site("auth_replacement_write", "auth_replacement_write", () => writeFileSync(replacement, current + "\n", { mode: 0o444 }), { labels });
      site("auth_replacement_rename", "auth_replacement_rename", () => renameSync(replacement, source), { labels });
      try {
        const rejected = site("application_authentication_refusal", "application_authentication_refusal", () => run(from, "./lifecycle",
          ["up", "--configuration", "coffee", ...(mode ? ["--json"] : [])], undefined,
          { ...env, PATH: scratch + ":" + env.PATH, STARTER_PROOF_FAULT: "auth", STARTER_PROOF_VALUE: wrongPassword }, 2), { labels, exit: true });
        refusal(["application_authentication", modeIndex], rejected, "starter_runtime_database_auth_failed", mode);
      } catch (error) { failures.keep(error); }
      finally { failures.attempt(() => {
        if (site("auth_held_credential_exists", "auth_held_credential_exists", () => existsSync(heldSource), { labels })) {
          failures.attempt(() => site("auth_credential_remove", "auth_credential_remove", () => rmSync(source, { force: true }), { labels }));
          failures.attempt(() => site("auth_credential_restore", "auth_credential_restore", () => renameSync(heldSource, source), { labels }));
        }
      }); }
      failures.finish();
      site("restore_authenticated_source", "restore_authenticated_source", () => up(), { labels: [modeIndex], exit: true });
    }
    mark("application_authentication_refusal_and_same_store_retry", "application authentication refusal and same-store retry");

    const crashedDB = site("crashed_database_container", "crashed_database_container", () => container("database"), { exit: true });
    site("crash_database", "crash_database", () => run(from, dockerBin, ["kill", "--signal", "KILL", crashedDB]), { exit: true });
    const staleLock = site("occupied_stale_lock_startup", "occupied_stale_lock_startup", () => up(2), { exit: true });
    const staleReport = site("occupied_stale_lock_report", "occupied_stale_lock_report", () => JSON.parse(staleLock), { exit: 2 });
    site("occupied_stale_lock", "occupied_stale_lock", () => assert.equal(staleReport?.findings?.[0]?.code, "starter_runtime_database_lock_held"), { exit: 2 });
    recover("documented_occupied_recovery");
    site("restart_after_database_recovery", "restart_after_database_recovery", () => up(), { exit: true });
    const recoveredDB = identity("recovered");
    site("crash_restart_changed_store", "crash_restart_changed_store", () => assert.equal(recoveredDB[2], live[2]));
    const recoveredCredential = site("recovered_credential_read", "recovered_credential_read", () => readFileSync(source, "utf8").trim());
    site("crash_restart_changed_credential", "crash_restart_changed_credential", () => assert.equal(recoveredCredential, current));
    const recoveredVerifier = verifier("recovered");
    site("crash_restart_changed_verifier", "crash_restart_changed_verifier", () => assert.equal(recoveredVerifier, currentVerifier));
    mark("postgresql_crash_recovery_with_unchanged_occupied_fallback", "PostgreSQL crash recovery with unchanged occupied fallback");

    const { browserContainerArguments, resolveBrowserImage } = await site("browser_module_import", "browser_module_import", () => import("../starter-browser-ci.mjs"));
    const localImage = env.OPENLUP_STARTER_LOCAL_IMAGE;
    const browser = await site("browser_image_resolve", "browser_image_resolve", () => resolveBrowserImage(undefined, localImage), { exit: true });
    const readiness = join(scratch, "browser-ready");
    site("browser_readiness_directory", "browser_readiness_directory", () => mkdirSync(readiness));
    const fixtures = join(from, ".context/care-browser"), builds = join(from, ".context/catalogue-builds");
    for (const [index, directory] of [fixtures, builds].entries()) site("browser_fixture_directory", "browser_fixture_directory",
      () => mkdirSync(directory, { recursive: true }), { labels: [index] });
    const mounts = ["--mount", `type=bind,src=${fixtures},dst=/app/.context/care-browser`,
      "--mount", `type=bind,src=${builds},dst=/app/.context/catalogue-builds`,
      "--mount", `type=bind,src=${readiness},dst=/readiness`];
    const browserName = project + "-installed-browser";
    const args = site("browser_container_arguments", "browser_container_arguments", () => browserContainerArguments(from, browser, browserName, localImage, mounts));
    try {
      site("installed_browser_container", "installed_browser_container", () => run(from, "docker", [args[0]!, "--detach", ...args.slice(1), "sleep", "120"]).stdout.trim(), { exit: true });
      const inventory = site("installed_browser_mounts", "installed_browser_mounts", () => run(from, "docker",
        ["inspect", "--format", "{{json .Mounts}}", browserName]), { exit: true });
      const inspected = site("installed_browser_mount_format", "installed_browser_mount_format", () => JSON.parse(inventory.stdout), { exit: inventory.status });
      site("installed_browser_mount_shape", "installed_browser_mount_shape", () => assert(Array.isArray(inspected) &&
        inspected.every(mount => mount && typeof mount.Type === "string" && (mount.Type !== "bind" || typeof mount.Source === "string"))), { exit: inventory.status });
      for (const [index, mount] of inspected.entries()) if (mount.Type === "bind") {
        const root = site("installed_browser_mount_realpath", "installed_browser_mount_realpath", () => realpathSync(mount.Source), { labels: [index] });
        site("installed_browser_mount_overlap", "installed_browser_mount_overlap", () => assert(source !== root && !source.startsWith(root + "/")), { labels: [index] });
      }
      const opens = `const fs=require('node:fs'), {argv}=require('node:process');
        for(const path of argv.slice(1)) {
          try { fs.closeSync(fs.openSync(path,'r')); }
          catch(error) { if (['ENOENT','EACCES'].includes(error.code)) continue; throw error; }
          process.exit(2);
        } console.log('PASS');`;
      const hidden = site("installed_browser_credential_visibility", "installed_browser_credential_visibility", () => run(from, "docker", ["exec", browserName,
        "timeout", "5", "node", "-e", opens, source, "/run/secrets/starter_runtime_password"]).stdout.trim(), { exit: true });
      const browserCheck = `const {chromium}=require('@playwright/test'), {argv}=require('node:process');
        (async()=>{const browser=await chromium.launch({headless:true});
        try{const page=await browser.newPage(); const response=await page.goto(argv[1]);
        if (response.status()!==200) process.exitCode=2; } finally{await browser.close();}})();`;
      site("installed_browser_http", "installed_browser_http", () => run(from, "docker", ["exec", browserName, "timeout", "15", "node", "-e",
        browserCheck, `http://127.0.0.1:${port}/`]).stdout.trim(), { exit: true });
      site("installed_browser_open", "installed_browser_open", () => assert(!(hidden !== "PASS")), { exit: 0 });
    } catch (error) { failures.keep(error); }
    finally {
      failures.attempt(() => {
        if (site("browser_container_inventory", "browser_container_inventory", () => run(from, dockerBin, ["ps", "-aq", "--no-trunc", "--filter", "name=^/" + browserName + "$"]).stdout.trim(), { exit: true })) {
          site("installed_browser_cleanup", "installed_browser_cleanup", () => run(from, dockerBin, ["rm", "-f", browserName]), { exit: true });
        }
      });
    }
    failures.finish();
    mark("installed_browser_mount_inventory_and_both_credential_opens", "installed browser, mount inventory and both credential opens");

    const credentialApp = site("credential_check_application", "credential_check_application", () => container("application"), { exit: true });
    const image = site("application_image", "application_image", () => run(from, "docker", ["inspect", "--format", "{{.Image}}", credentialApp]).stdout.trim(), { exit: true });
    const imagePaths = site("application_image_file_list", "application_image_file_list", () => run(from, "docker", ["run", "--rm", "--network", "none", image,
      "find", "/application", "/run", "-name", "runtime-password", "-o", "-name", "starter_runtime_password"]).stdout.trim(), { exit: true });
    site("credential_path_in_image", "credential_path_in_image", () => assert(!imagePaths), { exit: 0 });
  } catch (error) {
    failures.keep(error);
  } finally {
    failures.attempt(() => site("primary_project_down", "primary_project_down", () => downProject(project), { exit: true }));
    failures.attempt(() => site("replacement_project_down", "replacement_project_down", () => downProject(alternate), { exit: true }));
    const cleanup = [dirname(source), join(dirname(dirname(source)), alternate), scratch];
    for (const [index, path] of cleanup.entries()) {
      failures.attempt(() => site("remove_proof_state", "remove_proof_state",
        () => rmSync(path, { recursive: true, force: true }), { labels: [index] }));
    }
  }
  failures.finish();
}
