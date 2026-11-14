/** Qualify a published set through the shared starter consumer proof. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { imageReference, readCiImage } from '../ci-image-pull.mjs';
import { previousPublishedSet, proveDistributionCliConsumer } from './distribution-cli-proof.ts';
import { assertInstalledPackages, isolatedConsumerEnv } from './pack-manifest-input.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = detail => { throw new Error(`exact-set-qualification: ${detail}`); };

/** Required dependencies remain explicit inputs even when npm will refuse their platform. */
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

/** One starter proof for locally packed candidates and verified, committed released locks. */
export function proveNeutralStarterConsumer(checkout, input, packInstalled = undefined) {
  const started = performance.now();
  const released = "mode" in input ? input : undefined, starter = join(checkout, "examples/neutral-store");
  const temporary = mkdtempSync(join(tmpdir(), "openlup-neutral-starter-"));
  const extracted = released?.application ?? join(temporary, "application");
  const environment = released?.environment ?? { ...isolatedConsumerEnv(), npm_config_cache: join(temporary, "cache") };
  delete environment.NODE_TEST_CONTEXT;
  const execute = released?.run ?? ((name, args, cwd) => execFileSync(name, args, { cwd, env: environment, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  const run = (name, args, cwd = extracted) => process.stdout.write(execute(name, args, cwd));
  const lockHash = () => sha256(readFileSync(join(extracted, "package-lock.json")));
  try {
    if (released) assert.equal(released.mode, "released", "Unknown starter consumer input mode");
    if (!released) {
      // Copied tests run once, in the extracted application below; the source run keeps the rest.
      const ownership = JSON.parse(readFileSync(join(starter, "ownership.json"), "utf8"));
      const copied = new Set([...ownership.owned, ...ownership.managed]);
      const sourceTests = readdirSync(join(starter, "test")).map(name => "test/" + name).filter(path => !copied.has(path)).sort();
      assert(sourceTests.length > 0, "Starter source-only tests are missing");
      run(process.execPath, ["--experimental-strip-types", "--test", ...sourceTests], starter);
      run(process.execPath, [join(starter, "extract.mjs"), extracted]);
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
      assert.equal(lockHash(), released.lockfileSha256, "Released starter lock changed before installation");
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
    for (const args of [["test"], ["run", "typecheck"], ["run", "build"]]) run("npm", args);
    run(process.execPath, ["--experimental-strip-types", "--test", "browser/dev-loop.proof.ts"]);
    if (released) assert.equal(lockHash(), released.lockfileSha256, "qualification changed committed lock");
    console.log((released ? "Neutral starter released consumer PASS: " : "Neutral starter required cold-consumer addition PASS: ") + ((performance.now() - started) / 1000).toFixed(3) + " seconds");
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

function prepareReleasedStarter(receipt, temporary, run) {
  const { tag, tagCommit: expectedCommit } = receipt;
  assert.equal(run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]).trim(), expectedCommit, 'release tag commit mismatch');
  const archive = join(temporary, 'source.tar'), source = join(temporary, 'source'); mkdirSync(source);
  run('git', ['archive', '--format=tar', `--output=${archive}`, `refs/tags/${tag}`]);
  run('tar', ['-xf', archive, '-C', source]);
  const starter = join(source, 'examples/neutral-store'), input = join(temporary, 'input'); mkdirSync(input);
  const inventory = json(join(source, 'config/openlup-packages.json')).packages.filter(entry => entry.publish);
  const application = json(join(starter, 'package.json'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(application[section] ?? {})) if (name.startsWith('@openlup/')) application[section][name] = receipt.setVersion;
  }
  writeFileSync(join(input, 'package.json'), JSON.stringify(application));
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--fund=false'], input);
  const lockfile = join(input, 'package-lock.json'), lock = json(lockfile);
  const packages = inventory.map(({ name, directory }) => {
    const metadata = json(join(source, directory, 'package.json'));
    assert.equal(metadata.version, receipt.setVersion, `${name}: source version mismatch`);
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || entry.version !== receipt.setVersion) refuse(`${name}: missing or mismatched locked package`);
    return { name, version: receipt.setVersion, integrity: entry.integrity };
  });
  const manifest = join(input, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, commit: expectedCommit, packages }));
  const mode = readFileSync(join(starter, 'extract.mjs'), 'utf8').includes('const releasedExtractionSchemaVersion = 2;') ? 'released' : 'reconstructed';
  const extracted = join(temporary, 'application');
  run(process.execPath, [join(root, 'examples/neutral-store/extract.mjs'), extracted, '--source', starter,
    '--mode', mode, '--set-version', receipt.setVersion, '--source-revision', expectedCommit, '--manifest', manifest, '--lockfile', lockfile,
    ...(mode === 'reconstructed' ? ['--reason', 'Release tag predates versioned starter extraction.'] : [])]);
  receipt.extraction = json(join(extracted, '.starter-origin.json'));
  assert.equal(receipt.extraction.lockfileSha256, sha256(readFileSync(join(extracted, 'package-lock.json'))));
  return { application: extracted, packages };
}

function checkReleasedStarter(receipt, input, temporary, run, environment) {
  const { application, packages } = input;
  proveNeutralStarterConsumer(root, { mode: 'released', application, environment, run,
    lockfileSha256: receipt.extraction.lockfileSha256, packages: packages.map(({ name }) => name), verifyInstalled() {
      // Audit from the isolated parent: the project's workspaces=false omits root edges.
      const audit = JSON.parse(run('npm', ['audit', 'signatures', '--json', '--include-attestations', '--prefix', application], temporary));
      receipt.packages = verifiedReleasePackages(audit, packages, receipt.setVersion, receipt.tagCommit);
    }
  });
}

export function qualifyReleasedSet(tag, expectedCommit, receiptPath, upgrade = false) {
  const receipt = upgrade ? json(receiptPath) : qualificationReceipt(tag, expectedCommit);
  if (upgrade) {
    assert(receipt.result === 'PASS' && receipt.tag === tag && receipt.tagCommit === expectedCommit, 'exact-set qualification must pass first');
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
    if (env.OPENLUP_REGISTRY_READY !== undefined && env.OPENLUP_REGISTRY_READY !== 'true') refuse('published set not visible on npm');
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
      pair.to = qualificationReceipt(tag, expectedCommit);
      const releases = [pair.from, pair.to];
      const inputs = releases.map((release, index) => {
        const directory = join(temporary, String(index)); mkdirSync(directory);
        const input = prepareReleasedStarter(release, directory, run);
        checkReleasedStarter(release, input, directory, run, environment);
        return input;
      });
      const applications = inputs.map(input => input.application);
      pair.from.result = 'PASS'; pair.from.endedAt = new Date().toISOString();
      const finish = proveDistributionCliConsumer(applications[1], { from: applications[0], to: applications[1], fromVersion: previous, toVersion: receipt.setVersion, evidence: pair });
      // The target extraction already passed the extractor's complete lock checker.
      // The CLI moved declarations; the harness moves the verified lock and installs.
      assert.deepEqual(readFileSync(join(applications[0], 'package.json')), readFileSync(join(applications[1], 'package.json')), 'file upgrade must move exact dependency declarations');
      writeFileSync(join(applications[0], 'package-lock.json'), readFileSync(join(applications[1], 'package-lock.json')));
      checkReleasedStarter(pair.to, { ...inputs[1], application: applications[0] }, temporary, run, environment);
      finish();
      pair.to.result = 'PASS'; pair.to.endedAt = new Date().toISOString();
      pair.result = 'PASS';
    } else {
      const input = prepareReleasedStarter(receipt, temporary, run);
      checkReleasedStarter(receipt, input, temporary, run, environment);
      const extracted = input.application;
      receipt.postgresImage = imageReference(readCiImage('install-proof-postgres'));
      if (!env.OPENLUP_QUALIFICATION_DATABASE_URL) refuse('qualification PostgreSQL connection required');
      run(process.execPath, ['--input-type=module', '-e', "import pg from 'pg'; import { env } from 'node:process'; const pool = new pg.Pool({ connectionString: env.OPENLUP_QUALIFICATION_DATABASE_URL }); try { const {rows} = await pool.query('show server_version_num'); if (Math.floor(Number(rows[0].server_version_num) / 10000) !== 17) throw new Error('qualification requires PostgreSQL 17'); } finally { await pool.end(); }"], extracted);
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, commit, receipt, mode] = process.argv.slice(2);
  if (process.argv.length !== 5 && !(process.argv.length === 6 && mode === '--upgrade')) refuse('use release-tag full-tag-commit receipt-path');
  qualifyReleasedSet(tag, commit, receipt, mode === '--upgrade');
}
