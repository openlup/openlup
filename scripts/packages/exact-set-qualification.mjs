/** Released-input counterpart of proveNeutralStarterConsumer; no candidate packing or workspace imports. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { imageReference, readCiImage } from '../ci-image-pull.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = detail => { throw new Error(`exact-set-qualification: ${detail}`); };

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

export function qualifyReleasedSet(tag, expectedCommit, receiptPath) {
  const receipt = qualificationReceipt(tag, expectedCommit);
  const temporary = mkdtempSync(join(tmpdir(), 'openlup-exact-set-'));
  const environment = { ...env, npm_config_cache: join(temporary, 'cache'), npm_config_registry: 'https://registry.npmjs.org', npm_config_fetch_retries: '0' };
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'npm_config_node_options', 'NPM_CONFIG_NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete environment[name];
  const run = (command, args, cwd = root) => {
    const check = { command: [command, ...args], result: 'FAIL' }; receipt.checks.push(check);
    const output = execFileSync(command, args, { cwd, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    check.result = 'PASS'; return output;
  };
  try {
    if (env.OPENLUP_REGISTRY_READY !== undefined && env.OPENLUP_REGISTRY_READY !== 'true') refuse('published set not visible on npm');
    assert.equal(process.version, 'v24.21.0');
    assert.equal(run('npm', ['--version']).trim(), '11.19.0');
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
    // Same Git independence, ancestor isolation and package confinement assertions as the candidate proof.
    assert.equal(run('git', ['rev-parse', '--show-toplevel'], extracted).trim(), realpathSync(extracted));
    assert.equal(json(join(extracted, 'package.json')).workspaces, undefined);
    for (let parent = dirname(extracted); ; parent = dirname(parent)) {
      assert(!existsSync(join(parent, 'node_modules')), 'Starter ancestor can supply dependencies');
      if (parent === dirname(parent)) break;
    }
    run('git', ['ls-files', '--error-unmatch', 'package-lock.json'], extracted);
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--fund=false'], extracted);
    // npm 11.19's workspaces=false filter omits direct root edges. Audit the installed
    // prefix from its isolated parent, without loading the starter's project .npmrc.
    const audit = JSON.parse(run('npm', ['audit', 'signatures', '--json', '--include-attestations', '--prefix', extracted], temporary));
    receipt.packages = verifiedReleasePackages(audit, packages, receipt.setVersion, expectedCommit);
    receipt.postgresImage = imageReference(readCiImage('install-proof-postgres'));
    if (!env.OPENLUP_QUALIFICATION_DATABASE_URL) refuse('qualification PostgreSQL connection required');
    run(process.execPath, ['--input-type=module', '-e', "import pg from 'pg'; import { env } from 'node:process'; const pool = new pg.Pool({ connectionString: env.OPENLUP_QUALIFICATION_DATABASE_URL }); try { const {rows} = await pool.query('show server_version_num'); if (Math.floor(Number(rows[0].server_version_num) / 10000) !== 17) throw new Error('qualification requires PostgreSQL 17'); } finally { await pool.end(); }"], extracted);
    for (const { name } of packages) {
      const path = join(extracted, 'node_modules', name);
      assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink() && realpathSync(path) === join(realpathSync(extracted), 'node_modules', name), `${name}: installed package escapes application`);
    }
    for (const args of [['run', 'typecheck'], ['run', 'build'], ['test']]) process.stdout.write(run('npm', args, extracted));
    process.stdout.write(run(process.execPath, ['--experimental-strip-types', '--test', 'browser/dev-loop.proof.ts'], extracted));
    assert.equal(sha256(readFileSync(join(extracted, 'package-lock.json'))), receipt.extraction.lockfileSha256, 'qualification changed committed lock');
    receipt.result = 'PASS';
  } catch (error) { receipt.error = error.message; throw error; }
  finally {
    receipt.endedAt = new Date().toISOString();
    mkdirSync(dirname(resolve(receiptPath)), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    rmSync(temporary, { recursive: true, force: true });
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, commit, receipt] = process.argv.slice(2);
  if (process.argv.length !== 5) refuse('use release-tag full-tag-commit receipt-path');
  qualifyReleasedSet(tag, commit, receipt);
}
