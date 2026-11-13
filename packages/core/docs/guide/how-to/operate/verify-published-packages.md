# Verify the published packages

Check that the exact `@openlup/*` packages you intend to install match OpenLup's
published release, source commit and publishing workflow. Repeat the check for
each package you use before adopting a release set.

## Choose the release

Select the package, exact version and full source commit from the release you
intend to adopt. Keep these expected values independent of the attestation you
are about to inspect. The package tag is `openlup-<package>-v<version>`, where
`<package>` is the suffix after `@openlup/`.

Use the Node.js and npm toolchain specified in the
[publishing workflow](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/.github/workflows/publish-packages.yml),
and an authenticated `gh` that supports `gh release verify`. Your npm must
support `npm audit signatures --json --include-attestations`; this option
returns the verified attestation bundles used below. An unrecognized option
does not establish verification.

## Download and verify

Run the following in a shell whose temporary-directory location is outside any
checkout. At the prompts, enter the package suffix (for example, `core`), the
selected version and its full commit. The commands create a disposable
directory, install an exact dependency without running lifecycle scripts, and
download the registry tarball. They do not change your application's dependencies.

```sh
(
set -eu
printf 'Package suffix: '
IFS= read -r OPENLUP_PACKAGE
printf 'Release version: '
IFS= read -r OPENLUP_VERSION
printf 'Full source commit: '
IFS= read -r OPENLUP_COMMIT
OPENLUP_NAME="@openlup/$OPENLUP_PACKAGE"
OPENLUP_TAG="openlup-$OPENLUP_PACKAGE-v$OPENLUP_VERSION"

OPENLUP_VERIFY_DIR=$(mktemp -d)
mkdir "$OPENLUP_VERIFY_DIR/verify-package"
cd "$OPENLUP_VERIFY_DIR/verify-package"
printf 'Verification files: %s\n' "$PWD"

gh release verify "$OPENLUP_TAG" --repo openlup/openlup
npm init -y
npm install --save-exact --ignore-scripts --no-audit --fund=false \
  --registry=https://registry.npmjs.org "$OPENLUP_NAME@$OPENLUP_VERSION"
npm view "$OPENLUP_NAME@$OPENLUP_VERSION" dist --json \
  --registry=https://registry.npmjs.org > registry-dist.json
npm pack "$OPENLUP_NAME@$OPENLUP_VERSION" --ignore-scripts --json \
  --registry=https://registry.npmjs.org > registry-pack.json
npm audit signatures --json --include-attestations \
  --registry=https://registry.npmjs.org > signatures.json

node --input-type=module - "$OPENLUP_PACKAGE" "$OPENLUP_VERSION" "$OPENLUP_COMMIT" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const [pkg, version, commit] = process.argv.slice(2);
assert.match(pkg, /^[a-z0-9][a-z0-9-]*$/);
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.match(commit, /^[a-f0-9]{40}$/);
const name = `@openlup/${pkg}`, tag = `refs/tags/openlup-${pkg}-v${version}`;
const dist = json('registry-dist.json'), audit = json('signatures.json');
assert.deepEqual(audit.invalid, []);
assert.deepEqual(audit.missing, []);
const [pack] = json('registry-pack.json');
const digest = createHash('sha512').update(readFileSync(pack.filename)).digest();
const integrity = `sha512-${digest.toString('base64')}`;
assert.equal(dist.integrity, integrity);
const installed = json(`node_modules/${name}/package.json`);
assert.equal(installed.name, name);
assert.equal(installed.version, version);
const locked = json('package-lock.json').packages[`node_modules/${name}`];
assert.equal(locked.version, version);
assert.equal(locked.integrity, integrity);
const verified = audit.verified?.find(row => row.name === name && row.version === version);
assert(verified, 'No verified attestation for the selected package');
const provenance = verified.attestationBundles?.find(
  row => row.predicateType === 'https://slsa.dev/provenance/v1');
assert(provenance, 'No verified provenance bundle');
const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, 'base64'));
assert(statement.subject.some(row =>
  row.name === `pkg:npm/%40openlup/${pkg}@${version}` &&
  row.digest.sha512 === digest.toString('hex')));
const build = statement.predicate.buildDefinition;
assert.deepEqual(build.externalParameters.workflow, {
  ref: tag, repository: 'https://github.com/openlup/openlup',
  path: '.github/workflows/publish-packages.yml',
});
assert(build.resolvedDependencies.some(row =>
  row.uri === `git+https://github.com/openlup/openlup@${tag}` &&
  row.digest.gitCommit === commit));
console.log('PASS: installation integrity and verified provenance match the selected release');
JS
)
```

Require every command to succeed. Release verification checks the release's
signed attestation; it does not establish that npm published the package.
`npm audit signatures` verifies registry signatures and attestations before
the snippet reads its verified bundles. Decoding a raw attestation alone does
not verify its signature.

The snippet compares the registry tarball's digest with registry integrity,
the installation's lockfile integrity and the signed subject digest. It then
checks the provenance's package identity, tag, repository, workflow path and
source commit. A locally built tarball can differ; use the downloaded registry
tarball for this comparison. This check does not inspect later modifications
to installed files or prove application behaviour.

## Check a newly published set

When confirming a newly published set, also query `latest`. This command checks
core; replace the package name for each package in the set:

```sh
npm view @openlup/core dist-tags.latest --registry=https://registry.npmjs.org
```

Require its result to equal the selected version for every package in that set.
The publishing workflow moves `latest` forward; an older release can still be authentic after `latest` has
advanced. Install the exact version you verified rather than selecting it
through `latest`.

## Handle a failed check

If a bundle is absent, an option is unsupported, the network or authentication
fails, or release verification is unavailable, record **verification
unavailable** and the failed command. Fix the prerequisite and repeat the
check before adoption.

If a signature is invalid or a digest or identity differs, stop adoption and
ask the release maintainers to investigate. Keep the command output and the
verification files so they can identify the mismatch.
