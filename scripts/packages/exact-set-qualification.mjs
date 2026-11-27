/** Prove published sets and digest-verified candidate starter upgrades through the shared consumer. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { imageReference, pullWithRetry, readCiImage } from '../ci-image-pull.mjs';
import { needsStarterCareUpgrade, previousPublishedSet, proveDistributionCliConsumer, proveStarterRuntimeUpgrade, proveSettingsDiscovery, proveSettingsMcp,
  StarterRuntimeProofError, starterCareJourney, starterCareWitness, starterSettingsHost } from './distribution-cli-proof.ts';
import { assertInstalledPackages, isolatedConsumerEnv, readCurrentPackManifest } from './pack-manifest-input.ts';
import { parsePackagesConfig } from './package-manifest-policy.ts';
import { generateExactSetReleaseBom } from './generate-release-bom.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = detail => { throw new Error(`exact-set-qualification: ${detail}`); };

/**
 * Required dependencies remain explicit inputs even when npm will refuse their platform.
 * @param {{ os?: string | readonly string[], cpu?: string | readonly string[], libc?: string | readonly string[] }} manifest
 * @param {boolean} optional
 * @param {{ os: string, cpu: string, libc?: string }} target
 */
export function starterDependencyMatchesPlatform(manifest, optional, target) {
  return !optional || ["os", "cpu", "libc"].every(key => {
    if (key === "libc" && target.os !== "linux") return true;
    const constraint = manifest[key];
    if (constraint === undefined) return true;
    const values = typeof constraint === "string" ? [constraint] : constraint;
    return (values.length === 1 && values[0] === "any") || (!values.includes("!" + target[key]) &&
      (values.every(value => value.startsWith("!")) || values.includes(target[key] ?? "")));
  });
}

/**
 * One starter proof for locally packed candidates and verified, committed released locks.
 * @overload
 * @param {string} checkout
 * @param {ReadonlyMap<string, import('./pack-manifest-input.ts').VerifiedPack>} input
 * @param {(name: string) => string} packInstalled
 * @returns {void}
 */
/**
 * @overload
 * @param {string} checkout
 * @param {{mode: 'released' | 'candidate', application: string, environment: NodeJS.ProcessEnv,
 *   run: (command: string, args: string[], cwd: string) => string, lockfileSha256: string,
 *   packages: string[], verifyInstalled: () => void, settingsDiscovery?: boolean}} input
 * @returns {void}
 */
export function proveNeutralStarterConsumer(checkout, input, packInstalled = undefined) {
  const started = performance.now();
  const released = "mode" in input ? input : undefined, starter = join(checkout, "examples/neutral-store");
  const temporary = mkdtempSync(join(tmpdir(), "openlup-neutral-starter-"));
  const extracted = released?.application ?? join(temporary, "application");
  const environment = released?.environment ?? { ...isolatedConsumerEnv(), npm_config_cache: join(temporary, "cache") };
  delete environment.NODE_TEST_CONTEXT;
  // Each consumer command (npm ci, the node test run) is bounded; hosted runners exceeded 120 s, so the bound is doubled.
  const execute = released?.run ?? ((name, args, cwd) => execFileSync(name, args, { cwd, env: environment, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  const run = (name, args, cwd = extracted) => process.stdout.write(execute(name, args, cwd));
  const lockHash = () => sha256(readFileSync(join(extracted, "package-lock.json")));
  try {
    if (released) assert(["released", "candidate"].includes(released.mode), "Unknown starter consumer input mode");
    if (!released) {
      // Copied tests run once, in the extracted application below; the source run keeps the rest.
      const ownership = JSON.parse(readFileSync(join(starter, "ownership.json"), "utf8"));
      const copied = new Set([...ownership.owned, ...ownership.managed, ...(ownership.providerQualification?.managed ?? [])]);
      const sourceTests = readdirSync(join(starter, "test")).map(name => "test/" + name).filter(path => !copied.has(path)).sort();
      assert(sourceTests.length > 0, "Starter source-only tests are missing");
      run(process.execPath, ["--experimental-strip-types", "--test", ...sourceTests], starter);
      run(process.execPath, [join(starter, "extract.mjs"), extracted], temporary);
    }
    assert.equal(execute("git", ["rev-parse", "--show-toplevel"], extracted).trim(), realpathSync(extracted));
    for (let parent = dirname(extracted); ; parent = dirname(parent)) {
      assert(!lstatSync(join(parent, "node_modules"), { throwIfNoEntry: false }), "Starter ancestor can supply dependencies");
      if (parent === dirname(parent)) break;
    }
    const metadata = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
    assert.equal(metadata.workspaces, undefined);
    if (released) {
      run("git", ["ls-files", "--error-unmatch", "package-lock.json"]);
      assert.equal(lockHash(), released.lockfileSha256, "Starter lock changed before installation");
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--fund=false"]);
    } else {
      assert(packInstalled, "Candidate starter needs locked dependency tarballs");
      const localPacks = ["core", "outbox", "platform"].map(name => {
        const pack = input.get("@openlup/" + name);
        assert(pack, "Starter needs the complete locally packed set");
        const bytes = readFileSync(pack.path);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), pack.sha256);
        const target = join(extracted, "artifacts", "openlup-" + name + ".tgz");
        writeFileSync(target, bytes);
        return target;
      });
      // Every selected dependency comes from the root's already locked ordinary install.
      // Supplying its complete installed closure as tarballs avoids registry metadata resolution.
      const dependencies = new Set();
      const platform = { os: process.platform, cpu: process.arch, libc: process.platform === "linux"
        ? ((process.report.getReport()).header.glibcVersionRuntime ? "glibc" : "musl") : undefined };
      const collect = (name, optional = false) => {
        if (dependencies.has(name) || name.startsWith("@openlup/")) return;
        const directory = join(checkout, "node_modules", name);
        assert(lstatSync(directory, { throwIfNoEntry: false })?.isDirectory(), "Missing locked starter dependency: " + name);
        const dependency = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (!starterDependencyMatchesPlatform(dependency, optional, platform)) return;
        dependencies.add(name);
        for (const child of Object.keys(dependency.dependencies ?? {})) collect(child);
        for (const child of Object.keys(dependency.optionalDependencies ?? {})) {
          if (lstatSync(join(checkout, "node_modules", child), { throwIfNoEntry: false })) collect(child, true);
        }
      };
      for (const name of [...Object.keys(metadata.dependencies), ...Object.keys(metadata.devDependencies), "zod"]) collect(name);
      localPacks.push(...[...dependencies].sort().map(packInstalled));
      run("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--fund=false", "--no-save", ...localPacks]);
    }
    assertInstalledPackages(extracted, released?.packages ?? ["@openlup/core", "@openlup/outbox", "@openlup/platform"]);
    released?.verifyInstalled();
    // Only a historical release without the settings files can skip the check.
    if (released?.mode !== "released" || released.settingsDiscovery) proveSettingsDiscovery(extracted, execute);
    if (!released) proveSettingsMcp(extracted, environment);
    for (const args of [["test"], ["run", "typecheck"], ["run", "build"]]) run("npm", args);
    run(process.execPath, ["--experimental-strip-types", "--test", "browser/dev-loop.proof.ts"]);
    if (released) assert.equal(lockHash(), released.lockfileSha256, "starter proof changed committed lock");
    console.log((released ? "Neutral starter " + (released.mode === "candidate" ? "candidate, local digest-verified" : "released") + " consumer PASS: " : "Neutral starter required cold-consumer addition PASS: ") + ((performance.now() - started) / 1000).toFixed(3) + " seconds");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Consume ONLY npm audit signatures' successfully verified bundles, never a raw registry attestation.
export function verifiedReleasePackages(audit, packages, version, commit) {
  if (!Array.isArray(audit.invalid) || !Array.isArray(audit.missing) || audit.invalid.length || audit.missing.length) refuse(`signature verification failed: ${JSON.stringify(audit)}`);
  return packages.map(({ name, integrity }) => {
    const fail = reason => refuse(`${name}@${version}: ${reason}`);
    const entries = audit.verified?.filter(entry => entry.name === name && entry.version === version) ?? [];
    if (entries.length !== 1) fail('missing or duplicated verified provenance');
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? '')) fail('invalid locked integrity');
    const bundles = entries[0].attestationBundles?.filter(entry => entry.predicateType === 'https://slsa.dev/provenance/v1') ?? [];
    if (bundles.length !== 1) fail('missing or duplicated provenance bundle');
    const bundle = bundles[0].bundle, material = bundle?.verificationMaterial;
    if (!material || !bundle.dsseEnvelope?.payload) fail('malformed verified provenance');
    const certificate = material.certificate ?? material.x509CertificateChain?.certificates[0];
    let signer, statement;
    try {
      signer = new X509Certificate(Buffer.from(certificate.rawBytes, 'base64')).subjectAltName;
      statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString());
    } catch { fail('malformed verified provenance'); }
    assertReleaseProvenance(statement, signer, name, integrity, version, commit);
    return { name, version, integrity, verificationSource: 'npm audit signatures --json --include-attestations', provenanceSha256: sha256(JSON.stringify(bundles[0])) };
  });
}

export function assertReleaseProvenance(statement, signer, name, integrity, version, commit) {
  const fail = reason => refuse(`${name}@${version}: ${reason}`);
  const definition = statement.predicate?.buildDefinition, workflow = definition?.externalParameters?.workflow;
  const tag = `openlup-${name.slice(9)}-v${version}`;
  if (signer !== `URI:https://github.com/openlup/openlup/.github/workflows/publish-packages.yml@refs/tags/${tag}`) fail('provenance signer mismatch');
  if (statement.predicateType !== 'https://slsa.dev/provenance/v1' || statement.subject?.length !== 1
    || statement.subject[0].name !== `pkg:npm/%40openlup/${name.slice(9)}@${version}`
    || statement.subject[0].digest?.sha512 !== Buffer.from(integrity.slice(7), 'base64').toString('hex')) fail('provenance subject differs from locked tarball');
  if (workflow?.repository !== 'https://github.com/openlup/openlup' || workflow.ref !== `refs/tags/${tag}`
    || workflow.path !== '.github/workflows/publish-packages.yml'
    || !definition.resolvedDependencies?.some(input => input.uri === `git+https://github.com/openlup/openlup@refs/tags/${tag}` && input.digest?.gitCommit === commit)) fail('provenance repository/tag/commit mismatch');
}

export function qualificationReceipt(tag, commit, runnerImage = { image: env.ImageOS ?? process.platform, version: env.ImageVersion ?? 'local', node: process.version }) {
  if (!/^openlup-core-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) refuse('invalid core release tag');
  if (!/^[a-f0-9]{40}$/.test(commit)) refuse('tag commit must be a full SHA');
  return { schemaVersion: 1, setVersion: tag.slice(14), tag, tagCommit: commit, runnerImage, startedAt: new Date().toISOString(), endedAt: null, result: 'FAIL', extraction: null, packages: [], checks: [] };
}

export const candidatePreparationStages = Object.freeze({
  checkoutLookup: ['candidate_checkout', 'checkout_lookup_failed'],
  wrongCheckout: ['candidate_checkout', 'wrong_checkout'],
  workspace: ['candidate_workspace', 'workspace_failed'],
  revisionLookup: ['candidate_revision', 'revision_lookup_failed'],
  revisionMismatch: ['candidate_revision', 'revision_mismatch'],
  sourceExtraction: ['candidate_source', 'source_extraction_failed'],
  sourceInputs: ['candidate_inputs', 'source_input_validation_failed'],
  manifest: ['candidate_manifest', 'manifest_validation_failed'],
  lockfileGeneration: ['candidate_lockfile', 'lockfile_generation_failed'],
  generatedLockfile: ['candidate_lockfile_validation', 'generated_lockfile_validation_failed'],
  starterExtraction: ['candidate_extraction', 'starter_extraction_failed'],
  artifactStaging: ['candidate_artifacts', 'artifact_staging_failed'],
  dependencyInstall: ['candidate_install', 'npm_install_failed'],
});

function prepareReleasedStarter(receipt, temporary, run, candidateManifest = undefined, qualifyProvider = true,
  stage = (_stage, operation) => operation()) {
  const { tag, tagCommit: expectedCommit } = receipt;
  const revision = candidateManifest ? expectedCommit : `refs/tags/${tag}`;
  const resolvedRevision = stage('revisionLookup', () => run('git', ['rev-parse', `${revision}^{commit}`]).trim());
  stage('revisionMismatch', () => assert.equal(resolvedRevision, expectedCommit, 'source commit mismatch'));
  const archive = join(temporary, 'source.tar'), source = join(temporary, 'source');
  stage('sourceExtraction', () => {
    mkdirSync(source);
    run('git', ['archive', '--format=tar', `--output=${archive}`, revision]);
    run('tar', ['-xf', archive, '-C', source]);
  });
  const starter = join(source, 'examples/neutral-store'), input = join(temporary, 'input');
  const inventory = stage('sourceInputs', () => {
    const contents = readFileSync(join(source, 'config/openlup-packages.json'), 'utf8');
    const config = candidateManifest ? parsePackagesConfig(contents) : JSON.parse(contents);
    return config.packages.filter(entry => entry.publish).map(({ name, directory }) => {
      const metadata = json(join(source, directory, 'package.json'));
      if (candidateManifest) assert.equal(metadata.name, name, 'source package name mismatch');
      assert.equal(metadata.version, receipt.setVersion, `${name}: source version mismatch`);
      return { name, version: metadata.version };
    });
  });
  const packs = candidateManifest && stage('manifest',
    () => readCurrentPackManifest(source, candidateManifest, expectedCommit));
  const qualification = stage('sourceInputs', () => {
    mkdirSync(input);
    const application = json(join(starter, 'package.json'));
    const profile = application.providerQualification;
    const enabled = Boolean(packs && profile && qualifyProvider);
    delete application.providerQualification;
    if (enabled) Object.assign(application.dependencies, profile.dependencies);
    else if (profile) delete application.scripts['provider:qualify'];
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(application[section] ?? {})) if (name.startsWith('@openlup/')) application[section][name] = packs ? `file:${packs.get(name).path}` : receipt.setVersion;
    }
    writeFileSync(join(input, 'package.json'), JSON.stringify(application));
    return enabled;
  });
  stage('lockfileGeneration',
    () => run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--fund=false'], input));
  const lockfile = join(input, 'package-lock.json');
  const packages = stage('generatedLockfile', () => {
    const lock = packs ? readCandidateLockfile(lockfile) : json(lockfile);
    if (packs) for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(lock.packages[''][section] ?? {})) if (packs.has(name)) lock.packages[''][section][name] = receipt.setVersion;
    }
    if (packs) {
      for (const pack of packs.values()) {
        const entry = lock.packages[`node_modules/${pack.name}`];
        assert.equal(entry?.integrity, pack.integrity);
        entry.resolved = `file:${pack.path}`;
      }
      writeFileSync(lockfile, JSON.stringify(lock, null, 2) + '\n');
    }
    return inventory.map(({ name, version }) => {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry || entry.version !== version) refuse(`${name}: missing or mismatched locked package`);
      return { name, version, integrity: entry.integrity };
    });
  });
  const manifest = join(input, 'manifest.json');
  const extracted = join(temporary, 'application');
  receipt.extraction = stage('starterExtraction', () => {
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, commit: expectedCommit, packages }));
    const mode = packs ? 'candidate' : readFileSync(join(starter, 'extract.mjs'), 'utf8').includes('const releasedExtractionSchemaVersion = 2;') ? 'released' : 'reconstructed';
    run(process.execPath, [join(root, 'examples/neutral-store/extract.mjs'), extracted, '--source', starter,
      '--mode', mode, '--set-version', receipt.setVersion, '--source-revision', expectedCommit, '--manifest', packs ? resolve(candidateManifest) : manifest, '--lockfile', lockfile,
      ...(qualification ? ['--provider-qualification', 'enabled'] : []),
      ...(mode === 'reconstructed' ? ['--reason', 'Release tag predates versioned starter extraction.'] : [])]);
    return json(join(extracted, '.starter-origin.json'));
  });
  return { application: extracted, packages, source };
}

/** Use the published-tree pack artifacts to qualify the owned catalogue upgrade. */
export function provePublishedCatalogueUpgrade(manifest, commit, browser) {
  assert(browser, 'Published-tree catalogue upgrade requires the resolved browser image');
  const previous = '1.3.0', tag = 'openlup-core-v' + previous;
  const predecessor = 'd25a5c7389c9dda63dada7ca880f18ccbf68dbe3';
  const temporary = mkdtempSync(join(tmpdir(), 'openlup-catalogue-upgrade-'));
  const run = (command, args, cwd = root) => execFileSync(command, args, {
    cwd, env: isolatedConsumerEnv(), encoding: 'utf8', timeout: 120_000, stdio: 'pipe',
  });
  const install = app => run('npm', ['ci', '--ignore-scripts', '--no-audit', '--fund=false'], app);
  try {
    run('git', ['fetch', '--no-tags', '--depth=1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
    const pack = readCurrentPackManifest(root, manifest, commit).get('@openlup/core');
    assert(pack, 'Catalogue upgrade requires the packed Core');
    const prepare = (name, receipt, candidate) => {
      const directory = join(temporary, name);
      mkdirSync(directory);
      const { application } = prepareReleasedStarter(receipt, directory, run, candidate, false);
      install(application);
      return application;
    };
    const from = prepare('from', qualificationReceipt(tag, predecessor));
    const to = prepare('to', qualificationReceipt('openlup-core-v' + pack.version, commit), manifest);
    const evidence = { phases: [] };
    const finish = proveDistributionCliConsumer(to, { from, to, fromVersion: previous, toVersion: pack.version + '-candidate.' + commit.slice(0, 12), evidence, browser });
    assert.deepEqual(readFileSync(join(from, 'package.json')), readFileSync(join(to, 'package.json')));
    cpSync(join(to, 'package-lock.json'), join(from, 'package-lock.json'));
    install(from);
    finish();
    assert.ok(evidence.phases.some(phase => phase.name === 'installed-catalogue-build-replay' && phase.result === 'PASS'));
    console.log('Published-tree catalogue upgrade PASS');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function auditInstalledRelease(application, run) {
  // Reset workspaces=false: npm 11 otherwise filters out the installed root's edges.
  return JSON.parse(run('npm', ['audit', 'signatures', '--json', '--include-attestations', '--workspaces=null', '--prefix', application], dirname(application)));
}

function proveReleasedStarter(receipt, input, run, environment) {
  const { application, packages } = input;
  proveNeutralStarterConsumer(root, { mode: receipt.mode ?? 'released', application, environment, run,
    lockfileSha256: receipt.extraction.lockfileSha256, packages: packages.map(({ name }) => name),
    settingsDiscovery: existsSync(join(input.source, 'examples/neutral-store', starterSettingsHost)), verifyInstalled() {
      if (receipt.mode === 'candidate') { receipt.packages = [...readCurrentPackManifest(input.source, receipt.candidateManifest, receipt.tagCommit).values()]; return; }
      const audit = auditInstalledRelease(application, run);
      receipt.packages = verifiedReleasePackages(audit, packages, receipt.setVersion, receipt.tagCommit);
    }
  });
}

export function proveInstalledCareUpgrade(run, application, previous, customized) {
  run('npx', ['--no', '--', 'playwright', 'install', 'chromium'], application);
  const fixture = join(application, '.context/care-browser/upgrade.json');
  mkdirSync(dirname(fixture), { recursive: true, mode: 0o700 });
  writeFileSync(fixture, JSON.stringify({ predecessor: previous, customized }), { flag: 'wx', mode: 0o600 });
  try { run(process.execPath, ['lifecycle.mjs', 'browser', starterCareJourney, '--grep', starterCareWitness], application); }
  finally { rmSync(fixture); }
}

/** Build only the verified extraction; the original Dockerfile remains in its content identity. */
export function buildQualifiedImage(application, commit, archive, reference = imageReference(readCiImage('starter-node'))) {
  const base = readCiImage('starter-node'), name = 'ghcr.io/openlup/neutral-store-starter';
  assert(base.sources.some(source => imageReference(base, source) === reference), 'qualified_image_base_pin_mismatch');
  const original = readFileSync(join(application, 'Dockerfile'), 'utf8');
  assert(original.startsWith('FROM node:24.21.0-bookworm-slim AS application\n') && original.match(/^FROM /gmu).length === 1, 'qualified_image_base_unexpected');
  const epoch = execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false',
    '--build-arg', `SOURCE_DATE_EPOCH=${epoch}`, '--output', `type=oci,dest=${archive},rewrite-timestamp=true`, '--file', '-', application],
    { input: original.replace(/^FROM \S+/u, `FROM ${reference}`), stdio: ['pipe', 'inherit', 'inherit'] });
  const raw = execFileSync('skopeo', ['inspect', '--raw', `oci-archive:${archive}`]);
  assert.equal(JSON.parse(raw).mediaType, 'application/vnd.oci.image.manifest.v1+json', 'qualified_image_requires_single_manifest');
  return { name, platform: 'linux/amd64', manifestDigest: `sha256:${sha256(raw)}`, baseImageDigest: base.digest };
}

/** Inventory the verified lock and the same single-manifest archive that the BOM binds. */
export async function qualifiedSboms(application, archive, image, packages, output) {
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(npmVersion, '11.19.0');
  const packageBytes = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--package-lock-only'], { cwd: application, maxBuffer: 32 * 1024 * 1024 });
  assertSbomPackages(JSON.parse(packageBytes), packages);
  writeFileSync(output + '.packages.cdx.json', packageBytes);
  assert.equal('sha256:' + sha256(execFileSync('skopeo', ['inspect', '--raw', `oci-archive:${archive}`])), image.manifestDigest, 'sbom_image_digest_mismatch');
  const scanner = readCiImage('qualification-syft'); scanner.sources = scanner.sources.slice(0, 1);
  const reference = await pullWithRetry(scanner);
  const scan = args => execFileSync('docker', ['run', '--rm', '--pull=never', '--network=none', '--mount', `type=bind,src=${resolve(archive)},dst=/image.tar,readonly`, reference, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const version = JSON.parse(scan(['version', '-o', 'json'])).version;
  assert.equal('v' + version, scanner.tag, 'sbom_scanner_version_mismatch');
  const imageBytes = scan(['scan', 'oci-archive:/image.tar', '-o', 'cyclonedx-json']);
  assert.equal(JSON.parse(imageBytes).bomFormat, 'CycloneDX', 'sbom_image_format_mismatch');
  writeFileSync(output + '.image.cdx.json', imageBytes);
  return { packages: { sha256: sha256(packageBytes), tool: { name: 'npm', version: npmVersion } },
    image: { sha256: sha256(imageBytes), subjectDigest: image.manifestDigest, tool: { name: 'syft', version, imageDigest: scanner.digest } } };
}

export function assertSbomPackages(sbom, packages) {
  const seen = new Set();
  for (const { name, version, hashes } of sbom.components ?? []) {
    if (!name?.startsWith('@openlup/')) continue;
    const expected = packages.find(pkg => pkg.name === name);
    if (!expected || version !== expected.version || !hashes?.some(hash => hash.alg === 'SHA-512' && hash.content === Buffer.from(expected.integrity.slice(7), 'base64').toString('hex'))) refuse(`sbom_package_mismatch: ${name}`);
    seen.add(name);
  }
  for (const { name } of packages) if (!seen.has(name)) refuse(`sbom_package_missing: ${name}`);
}

export function qualifyReleasedSet(tag, expectedCommit, receiptPath, upgrade = false, schema = false, bom = false, canary = false, candidateManifest = undefined) {
  const receipt = !candidateManifest && (upgrade || schema || bom || canary) ? json(receiptPath) : qualificationReceipt(tag, expectedCommit);
  if (candidateManifest) { assert(upgrade && !schema && !bom && !canary, 'candidate requires adjacent upgrade only'); Object.assign(receipt, { mode: 'candidate', verificationSource: 'candidate, local digest-verified', candidateManifest: resolve(candidateManifest) }); }
  const applicationsPath = resolve(receiptPath + '.applications');
  if (canary) {
    const qualified = receipt.result === 'PASS';
    receipt.result = 'FAIL'; receipt.endedAt = null;
    receipt.canary = { result: 'FAIL', startedAt: new Date().toISOString(), upgradeEvidence: ['upgrade', 'schemaUpgrade'] };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return (async () => { try {
      assert(qualified && receipt.tag === tag && receipt.tagCommit === expectedCommit && receipt.upgrade?.result === 'PASS' && receipt.schemaUpgrade?.result === 'PASS', 'canary: qualification_incomplete_or_mismatched');
      const bytes = readFileSync(receiptPath + '.bom.json'), bound = JSON.parse(bytes);
      assert.equal(sha256(bytes), receipt.bom.sha256, 'canary: bom_hash_mismatch');
      assert.equal(bound.image.manifestDigest, receipt.image.manifestDigest, 'canary: bom_image_mismatch');
      const { runStarterImageCanary } = await import('../starter-browser-ci.mjs');
      await runStarterImageCanary(join(applicationsPath, '1/application'), receiptPath + '.image.tar', bound.image.manifestDigest, receipt.canary);
      receipt.result = 'PASS';
    } catch (error) { receipt.error = error.message; throw error; }
    finally { receipt.endedAt = receipt.canary.endedAt = new Date().toISOString(); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); } })();
  }
  if (bom) {
    const qualified = receipt.result === 'FAIL';
    receipt.result = 'FAIL'; receipt.endedAt = null; delete receipt.bom; delete receipt.image; delete receipt.sbom;
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    const run = async () => { try {
      assert(qualified && receipt.upgrade?.result === 'PASS' && receipt.schemaUpgrade?.result === 'PASS' && receipt.tag === tag && receipt.tagCommit === expectedCommit, 'release-bom: qualification_incomplete_or_mismatched');
      const application = join(applicationsPath, '1/application');
      receipt.image = { ...buildQualifiedImage(application, expectedCommit, receiptPath + '.image.tar'), publishResult: 'refused', registryReadback: null };
      receipt.sbom = await qualifiedSboms(application, receiptPath + '.image.tar', receipt.image, receipt.packages, receiptPath);
      const bytes = JSON.stringify(generateExactSetReleaseBom(root, application, receipt), null, 2) + '\n';
      writeFileSync(receiptPath + '.bom.json', bytes);
      receipt.bom = { sha256: sha256(bytes) }; receipt.result = 'PASS';
    } catch (error) { receipt.error = error.message; throw error; }
    finally { receipt.endedAt = new Date().toISOString(); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); }
    return receipt; };
    return run();
  }
  if (schema) {
    const started = receipt.result === 'FAIL' && receipt.schemaUpgrade?.result === 'FAIL' && receipt.schemaUpgrade.startedAt;
    assert((receipt.result === 'PASS' || started) && receipt.upgrade?.result === 'PASS' && receipt.tag === tag && receipt.tagCommit === expectedCommit, 'adjacent-set qualification must pass first');
    receipt.result = 'FAIL'; receipt.endedAt = null;
    receipt.schemaUpgrade = { result: 'FAIL', startedAt: receipt.schemaUpgrade?.startedAt ?? new Date().toISOString(), postgresImage: imageReference(readCiImage('test-postgres')) };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    const run = async () => {
      let admin;
      const database = 'qualification_schema_' + process.pid;
      try {
        assert(env.OPENLUP_QUALIFICATION_DATABASE_URL, 'qualification PostgreSQL connection required');
        assert.equal(process.version, 'v24.21.0');
        assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), '11.19.0');
        execFileSync('npm', ['ci', '--prefer-offline', '--no-audit', '--fund=false'], { cwd: root, stdio: 'inherit' });
        execFileSync('npm', ['run', 'pretest'], { cwd: root, stdio: 'inherit' });
        const { default: pg } = await import('pg'), { tsImport } = await import('tsx/esm/api');
        const { runReleasedSchemaUpgradeProof } = await tsImport('../../tests/postgres/m14ReleasedSchemaUpgrade.proof.ts', import.meta.url);
        admin = new pg.Pool({ connectionString: env.OPENLUP_QUALIFICATION_DATABASE_URL });
        assert.equal(Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 16);
        await admin.query(`CREATE DATABASE ${database}`);
        const url = new URL(env.OPENLUP_QUALIFICATION_DATABASE_URL); url.pathname = '/' + database;
        const proof = await runReleasedSchemaUpgradeProof({ mode: 'released-pair',
          from: { application: join(applicationsPath, 'previous'), identity: receipt.upgrade.from },
          to: { application: join(applicationsPath, '1/application'), identity: receipt.upgrade.to },
          database: { connectionString: url.toString() } });
        Object.assign(receipt.schemaUpgrade, proof);
        assert.equal(proof.result, 'PASS', 'released-pair schema compatibility failed');
        // The BOM step records provisional PASS; canary completion grants final qualification PASS.
      } catch (error) { receipt.error = error.message; throw error; }
      finally {
        try { if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); } } }
        catch (error) { receipt.result = receipt.schemaUpgrade.result = 'FAIL'; receipt.error = error.message; throw error; }
        finally {
          receipt.endedAt = receipt.schemaUpgrade.endedAt = new Date().toISOString();
          writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
        }
      }
      return receipt;
    };
    return run();
  }
  if (upgrade) {
    assert((candidateManifest || receipt.result === 'PASS') && receipt.tag === tag && receipt.tagCommit === expectedCommit, 'exact-set qualification must pass first');
    receipt.result = 'FAIL'; receipt.endedAt = null;
    receipt.upgrade = { result: 'FAIL', startedAt: new Date().toISOString(), phases: [], checks: [] };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'openlup-exact-set-'));
  const environment = { ...env, npm_config_cache: join(temporary, 'cache'), npm_config_registry: 'https://registry.npmjs.org', npm_config_fetch_retries: '0' };
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'npm_config_node_options', 'NPM_CONFIG_NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete environment[name];
  const run = (command, args, cwd = root) => {
    const check = { command: [command, ...args], result: 'FAIL' }; (upgrade ? receipt.upgrade.checks : receipt.checks).push(check);
    const output = execFileSync(command, args, { cwd, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    check.result = 'PASS'; return output;
  };
  try {
    if (!candidateManifest && env.OPENLUP_REGISTRY_READY !== undefined && env.OPENLUP_REGISTRY_READY !== 'true') refuse('published set not visible on npm');
    assert.equal(process.version, 'v24.21.0');
    assert.equal(run('npm', ['--version']).trim(), '11.19.0');
    if (upgrade) {
      const versions = json(join(root, 'config/openlup-packages.json')).packages.filter(p => p.publish)
        .map(p => JSON.parse(run('npm', ['view', p.name, 'versions', '--json'])));
      const previous = previousPublishedSet(receipt.setVersion, run('git', ['ls-remote', '--tags', 'origin', 'refs/tags/openlup-core-v*']), versions);
      const previousTag = `openlup-core-v${previous}`;
      run('git', ['fetch', '--no-tags', '--depth=1', 'origin', `refs/tags/${previousTag}:refs/tags/${previousTag}`]);
      const pair = receipt.upgrade;
      pair.from = qualificationReceipt(previousTag, run('git', ['rev-parse', `${previousTag}^{commit}`]).trim());
      pair.to = candidateManifest ? { ...receipt, upgrade: undefined, checks: [] } : qualificationReceipt(tag, expectedCommit);
      const releases = [pair.from, pair.to];
      const inputs = releases.map((release, index) => {
        const directory = join(temporary, String(index)); mkdirSync(directory);
        const input = prepareReleasedStarter(release, directory, run, index === 1 ? candidateManifest : undefined);
        proveReleasedStarter(release, input, run, environment);
        return input;
      });
      const applications = inputs.map(input => input.application);
      const previousApplication = join(temporary, 'previous');
      cpSync(applications[0], previousApplication, { recursive: true });
      pair.from.result = 'PASS'; pair.from.endedAt = new Date().toISOString();
      const care = needsStarterCareUpgrade(applications[0], applications[1]);
      const upgradeApplication = (application, evidence, pristine) => {
        const finish = proveDistributionCliConsumer(applications[1], { from: application, to: applications[1],
          fromVersion: previous, toVersion: receipt.setVersion, evidence, pristine });
        // Keep the extracted target lock verified by the extractor and install it after moving declarations.
        assert.deepEqual(readFileSync(join(application, 'package.json')), readFileSync(join(applications[1], 'package.json')), 'file upgrade must move exact dependency declarations');
        writeFileSync(join(application, 'package-lock.json'), readFileSync(join(applications[1], 'package-lock.json')));
        proveReleasedStarter(pair.to, { ...inputs[1], application }, run, environment);
        finish();
        if (care) proveInstalledCareUpgrade(run, application, previousApplication, !pristine);
      };
      if (care) {
        const pristine = join(temporary, 'pristine');
        cpSync(previousApplication, pristine, { recursive: true });
        pair.pristine = { phases: [] };
        upgradeApplication(pristine, pair.pristine, true);
      }
      upgradeApplication(applications[0], pair, false);
      pair.to.result = 'PASS'; pair.to.endedAt = new Date().toISOString();
      pair.result = 'PASS';
    } else {
      const input = prepareReleasedStarter(receipt, temporary, run);
      proveReleasedStarter(receipt, input, run, environment);
      const extracted = input.application;
      receipt.postgresImage = imageReference(readCiImage('install-proof-postgres'));
      if (!env.OPENLUP_QUALIFICATION_DATABASE_URL) refuse('qualification PostgreSQL connection required');
      run(process.execPath, ['--input-type=module', '-e', "import pg from 'pg'; import { env } from 'node:process'; const pool = new pg.Pool({ connectionString: env.OPENLUP_QUALIFICATION_DATABASE_URL }); try { const {rows} = await pool.query('show server_version_num'); if (Math.floor(Number(rows[0].server_version_num) / 10000) !== 17) throw new Error('qualification requires PostgreSQL 17'); } finally { await pool.end(); }"], extracted);
    }
    if (upgrade) renameSync(temporary, applicationsPath);
    receipt.result = 'PASS';
  } catch (error) { receipt.error = error.message; throw error; }
  finally {
    receipt.endedAt = new Date().toISOString();
    if (upgrade) receipt.upgrade.endedAt = receipt.endedAt;
    mkdirSync(dirname(resolve(receiptPath)), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    rmSync(temporary, { recursive: true, force: true });
  }
  return receipt;
}

const runCandidate = (file, args, cwd = root) => execFileSync(file, args, {
  cwd, env: isolatedConsumerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

function candidateStage(stage, operation) {
  try { return operation(); }
  catch (error) {
    if (error instanceof StarterRuntimeProofError) throw error;
    const status = Number.isInteger(error?.status) ? error.status : null;
    const [step, reason] = candidatePreparationStages[stage];
    throw new StarterRuntimeProofError(step, status, reason);
  }
}

function readCandidateLockfile(path) {
  const lock = json(path);
  assert.equal(lock.lockfileVersion, 3);
  assert(lock.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages));
  const root = lock.packages[''];
  assert(root && typeof root === 'object' && !Array.isArray(root));
  return lock;
}

export function prepareStarterCandidate(commit, manifest, scratch, run = runCandidate) {
  candidateStage('workspace', () => mkdirSync(scratch, { recursive: true }));
  const { packs, receipt } = candidateStage('manifest', () => {
    const packs = readCurrentPackManifest(root, manifest, commit);
    return { packs, receipt: qualificationReceipt('openlup-core-v' + packs.get('@openlup/core').version, commit) };
  });
  const { application, packages } = prepareReleasedStarter(receipt, scratch, run, manifest, false, candidateStage);
  receipt.packages = packages;
  const lockfile = join(application, 'package-lock.json');
  const lock = candidateStage('generatedLockfile', () => {
    const lock = readCandidateLockfile(lockfile);
    for (const [name, pack] of packs) assert.equal(lock.packages[`node_modules/${name}`]?.integrity, pack.integrity);
    return lock;
  });
  candidateStage('artifactStaging', () => {
    mkdirSync(join(application, 'artifacts'), { recursive: true });
    for (const [name, pack] of packs) {
      const target = `artifacts/openlup-${name.slice(9)}.tgz`;
      cpSync(pack.path, join(application, target));
      lock.packages[`node_modules/${name}`].resolved = 'file:' + target;
    }
    const preparedLock = JSON.stringify(lock) + '\n';
    writeFileSync(lockfile, preparedLock);
    receipt.buildContextLockfileSha256 = sha256(preparedLock);
    writeFileSync(join(application, '.starter-origin.json'), JSON.stringify({
      ...receipt.extraction, lockfileSha256: receipt.buildContextLockfileSha256,
    }, null, 2) + '\n');
  });
  candidateStage('dependencyInstall',
    () => run('npm', ['ci', '--ignore-scripts', '--no-audit', '--fund=false'], application));
  return { application, receipt };
}

export async function qualifyCandidateCanary(commit, manifest, output) {
  assert.equal(runCandidate('git', ['rev-parse', 'HEAD']).trim(), commit, 'candidate checkout mismatch');
  const scratch = mkdtempSync(join(tmpdir(), 'openlup-candidate-image-'));
  let receipt = { mode: 'candidate-canary', tagCommit: commit, canary: { result: 'FAIL' }, result: 'FAIL' };
  try {
    const prepared = prepareStarterCandidate(commit, manifest, scratch);
    Object.assign(receipt, prepared.receipt);
    const archive = join(scratch, 'candidate.oci.tar'), started = performance.now();
    const reference = await pullWithRetry(readCiImage('starter-node'));
    receipt.image = buildQualifiedImage(prepared.application, commit, archive, reference);
    receipt.image.baseReference = reference;
    receipt.image.buildDurationMs = Math.round(performance.now() - started);
    console.log('Candidate starter image build complete', receipt.image.buildDurationMs + ' ms');
    const { runStarterImageCanary } = await import('../starter-browser-ci.mjs');
    await runStarterImageCanary(prepared.application, archive, receipt.image.manifestDigest, receipt.canary, {
      localImage: env.OPENLUP_STARTER_LOCAL_IMAGE,
      pull: () => pullWithRetry(readCiImage('test-postgres')),
    });
    receipt.result = 'PASS';
    console.log('Candidate starter retained image PASS');
  } finally {
    receipt.endedAt = new Date().toISOString();
    try { writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n'); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}

async function qualifyCandidateOccupied(predecessor, previousManifest, candidate, candidateManifest, port) {
  const failures = [];
  let scratch;
  try {
    const checkedOut = candidateStage('checkoutLookup', () => runCandidate('git', ['rev-parse', 'HEAD']).trim());
    candidateStage('wrongCheckout', () => assert.equal(checkedOut, candidate, 'candidate checkout mismatch'));
    scratch = candidateStage('workspace', () => mkdtempSync(join(tmpdir(), 'openlup-occupied-upgrade-')));
    const from = prepareStarterCandidate(predecessor, previousManifest, join(scratch, 'from'));
    const to = prepareStarterCandidate(candidate, candidateManifest, join(scratch, 'to'));
    await proveStarterRuntimeUpgrade(from.application, to.application, Number(port));
  } catch (error) { failures.push(StarterRuntimeProofError.diagnostic(error, 'candidate_occupied')); }
  finally {
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); }
      catch (error) { failures.push(StarterRuntimeProofError.diagnostic(error, 'candidate_cleanup')); }
    }
  }
  if (failures.length) throw new StarterRuntimeProofError(failures);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, commit, receipt, mode, candidateManifest] = process.argv.slice(2);
  if (tag === '--candidate-canary') {
    if (process.argv.length !== 6) refuse('use --candidate-canary commit manifest receipt');
    await qualifyCandidateCanary(commit, receipt, mode);
  } else if (tag === '--candidate-occupied') {
    try {
      if (process.argv.length !== 8) throw new StarterRuntimeProofError('candidate_occupied', null, 'invalid_arguments');
      await qualifyCandidateOccupied(...process.argv.slice(3));
    } catch (error) {
      process.stderr.write(StarterRuntimeProofError.diagnostic(error, 'candidate_occupied') + '\n');
      process.exitCode = 1;
    }
  } else {
    if (!(process.argv.length === 7 && mode === '--candidate') && process.argv.length !== 5 && !(process.argv.length === 6 && ['--upgrade', '--schema-upgrade', '--bom', '--canary'].includes(mode))) refuse('use release-tag full-tag-commit receipt-path');
    // Finish module evaluation before recovery imports this module; incomplete work exits nonzero.
    process.exitCode = 1;
    Promise.resolve(qualifyReleasedSet(tag, commit, receipt, mode === '--upgrade' || mode === '--candidate', mode === '--schema-upgrade', mode === '--bom', mode === '--canary', candidateManifest))
      .then(() => { process.exitCode = 0; }, error => { console.error(error); });
  }
}
