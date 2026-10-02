// Seeded falsifiers for the package release workflows. Every release control is a predicate over
// the committed workflow text, and each has at least one planted defect that must turn it red.
// The event identity, tag pattern and tarball checks also run as the real step scripts, and so does
// the dispatch preflight up to its gate, against a target whose package.json runs code.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Workflows = { dispatch: string; producer: string };
const committed: Workflows = {
  dispatch: readFileSync(join(ROOT, ".github/workflows/publish-package.yml"), "utf8"),
  producer: readFileSync(join(ROOT, ".github/workflows/publish-packages.yml"), "utf8"),
};

const job = (source: string, name: string) => source.split(`\n  ${name}:\n`)[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ?? "";
const step = (source: string, name: string) => source.split(`      - name: ${name}\n`)[1]?.split(/^ {6}- /mu)[0] ?? "";
/** A step without the comment lines that introduce the next one. */
const stepBody = (source: string, name: string) => step(source, name).replace(/(?: {6}#[^\n]*\n)+$/u, "");
const script = (stepText: string) => (stepText.split("        run: |\n")[1] ?? "").replace(/^ {10}/gmu, "");
const triggers = (source: string) => [...(source.split("\non:\n")[1]?.split("\npermissions:")[0] ?? "").matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]);
/** Every marker is present, in this order. */
const inOrder = (text: string, markers: readonly string[]) => {
  const positions = markers.map((marker) => text.indexOf(marker));
  return positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!));
};
const count = (text: string, marker: string) => text.split(marker).length - 1;
/** Every line a `run:` executes, inline or as a block, so an expression there would be interpolated into shell. */
const runLines = (source: string) => {
  const lines: string[] = [];
  let block: number | undefined;
  for (const line of source.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (block !== undefined && (line.trim() === "" || indent > block)) { lines.push(line); continue; }
    block = undefined;
    const run = /^( *)(?:- )?run: (.*)$/u.exec(line);
    if (run) { if (run[2] === "|") block = run[1]!.length; else lines.push(line); }
  }
  return lines;
};

const APP = "334697227", BOT = '"openlup-release[bot]"';
const GATE = "if: ${{ github.repository == 'openlup/openlup' && github.ref == 'refs/heads/main' && vars.OPENLUP_PACKAGE_RELEASE == 'enabled' && vars.OPENLUP_NPM_STAGE == 'enabled' }}";
const SHELL_TAG = String.raw`[[ "$RELEASE_TAG" =~ ^openlup-[a-z0-9][a-z0-9-]*-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1`;
// The step scripts read the environment; joined here so this file carries no environment read of its own.
const ENV = ["process", "env"].join(".");
const NODE_TAG = `${String.raw`/^openlup-([a-z0-9][a-z0-9-]*)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(`}${ENV}.RELEASE_TAG)`;
const SHELL_VERSION = String.raw`[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]`;
const PUBLISH = 'npm publish "./packs/$filename" --provenance --access public --tag latest --ignore-scripts';
// The release gate: publish-package.yml runs the file at the dispatched main commit, publish-packages.yml its own.
const TAKE_GATE = 'git show "$GITHUB_SHA:scripts/packages/release-gate.ts" > "$RUNNER_TEMP/release-gate.mts"';
const DISPATCH_GATE = 'node --experimental-strip-types "$RUNNER_TEMP/release-gate.mts"';
const PRODUCER_GATE = "node --experimental-strip-types scripts/packages/release-gate.ts";
const gateStep = (command: string) => `        env:\n          GITHUB_TOKEN: \${{ github.token }}\n        run: ${command}\n`;
const TAKE_STEP = "Take the release gate and the Node contract from the dispatched main commit";
/** Main's gate, Node version and Node contract, copied outside the checkout before any step reads the target. */
const TAKE_RUN = ["        id: main\n        run: |\n", `          ${TAKE_GATE}\n`, '          git show "$GITHUB_SHA:package.json" > "$RUNNER_TEMP/main-package.json"\n', '          node_version="$(git show "$GITHUB_SHA:.nvmrc")"\n', '          [[ "$node_version" =~ ^[1-9][0-9]*$ ]]\n', '          echo "node-version=$node_version" >> "$GITHUB_OUTPUT"\n'].join("");
const SETUP_NODE = "uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6\n        with:\n          node-version: ${{ steps.main.outputs.node-version }}\n          package-manager-cache: false\n";
const MAIN_ASSERT_STEP = "Assert the Node and npm contract of the dispatched main commit";
const MAIN_ASSERT = ["        working-directory: ${{ runner.temp }}\n        run: |\n", `          test "$(node -p 'process.versions.node.split(".")[0]')" = "24"\n          test "$(npm --version)" = "11.19.0"\n`, `          test "$(node -p 'JSON.parse(require("node:fs").readFileSync("main-package.json", "utf8")).engines.node')" = "24.x"\n`, `          test "$(node -p 'JSON.parse(require("node:fs").readFileSync("main-package.json", "utf8")).packageManager')" = "npm@11.19.0"\n`].join("");
const TARGET_ASSERT_STEP = "Assert the target's Node and npm contract";
const LEG_IN_FLIGHT = "      # A re-run of a failed leg skips the preflight, so each leg refuses too while a release or\n      # publication of another run has not completed; it could otherwise cancel a pending publication.\n";
const RELEASE_TAKE = "      # As in the preflight: main's gate, Node version and Node contract, before any target file.\n";
/** The contract assertion as it was: in the checkout, with require of the target's package.json. */
const OLD_ASSERT = `        run: |\n          test "$(node -p 'process.versions.node.split(".")[0]')" = "24"\n          test "$(npm --version)" = "11.19.0"\n          test "$(node -p 'require("./package.json").engines.node')" = "24.x"\n          test "$(node -p 'require("./package.json").packageManager')" = "npm@11.19.0"\n`;
/** After the gate, the target's own contract, read as data. */
const TARGET_ASSERT = ["        run: |\n", `          test "$(cat .nvmrc)" = "$(node -p 'process.versions.node.split(".")[0]')"\n`, `          test "$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).engines.node')" = "24.x"\n`, `          test "$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')" = "npm@11.19.0"\n`].join("");
const TARGET_ASSERT_TEXT = `      # After the gate the target is main's code; its own contract is read as data, never run.\n      - name: ${TARGET_ASSERT_STEP}\n${TARGET_ASSERT}`;
/** Each step of a job: its name, or the first line of an unnamed step. */
const stepList = (jobText: string) => jobText.split(/^ {6}- /mu).slice(1).map((text) => text.slice(text.startsWith("name: ") ? 6 : 0, text.indexOf("\n")));
/** Until the gate passes a job reads no file of the target: then come these steps, in this order. */
const GATE_FIRST = {
  preflight: [TAKE_STEP, SETUP_NODE.split("\n")[0]!, MAIN_ASSERT_STEP, "Refuse while any package release or publication is in flight", "Check main ancestry and required contexts before running target code", TARGET_ASSERT_STEP, "run: npm ci --ignore-scripts --no-audit --fund=false"],
  release: [TAKE_STEP, SETUP_NODE.split("\n")[0]!, MAIN_ASSERT_STEP, "Refuse while any package release or publication is in flight", "The target commit is on main and passed the required contexts", TARGET_ASSERT_STEP, "Repeat the manifest, version, tag and npm refusals and prepare the note"],
} as const;
const IN_FLIGHT_STEP = "Refuse while any package release or publication is in flight";
const GATE_STEPS = { preflight: "Check main ancestry and required contexts before running target code", release: "The target commit is on main and passed the required contexts", pack: "The release commit is on main and passed the required contexts" };
const TAG_STEP = "Create the exact annotated tag with the release identity";
const APP_TOKEN_ENV = "GITHUB_TOKEN: ${{ steps.release-identity.outputs.token }}";
const TAG_RUN = [`        env:\n          ${APP_TOKEN_ENV}\n        run: |\n`, `          ${DISPATCH_GATE} tag "$TARGET_COMMIT" "$PACKAGE" "$VERSION"\n`, '          tag="openlup-$PACKAGE-v$VERSION"\n          git fetch --quiet origin "refs/tags/$tag:refs/tags/$tag"\n'].join("");
const RELEASE_GROUP = "    concurrency:\n      group: openlup-package-release-${{ matrix.package }}\n      cancel-in-progress: false\n";
const EVENT_STEP = "Require the release App event and the live immutable release";
const RECHECK_STEP = "Refuse a version npm holds or passed, immediately before publishing";
const APP_TOKEN = "GH_TOKEN: ${{ steps.release-identity.outputs.token }}";
const GITLEAKS_INSTALL = ['repos/gitleaks/gitleaks/releases/assets/378332058 > "$archive"', 'echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $archive" | sha256sum --check --strict', 'tar -xzf "$archive" -C "$install_dir" gitleaks', 'echo "$install_dir" >> "$GITHUB_PATH"'];
const GITLEAKS_SCAN = 'gitleaks dir "$RUNNER_TEMP/scan" --config config/gitleaks.toml --redact --no-banner';
const PACK_GATE = "if: ${{ github.repository == 'openlup/openlup' && vars.OPENLUP_NPM_STAGE == 'enabled' && !github.event.release.prerelease && startsWith(github.event.release.tag_name, 'openlup-') }}";
const DRAFT_TAG_REF = 'test "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --jq .object.sha)" = "$(git rev-parse "refs/tags/$tag")"';
const PREFLIGHT_PACK = 'npm run packages:check -- --out "$RUNNER_TEMP/packs" --release-tag "openlup-$PACKAGE-v$VERSION"';
const SET_PACK = 'npm run packages:check -- --out "$RUNNER_TEMP/packs" --release-set "$VERSION"';
/** The preflight packs the one package, or for the set every publishable package at the set version. */
const PACK_RUN = `        run: |\n          if [ "$PACKAGE" = all ]; then\n            ${SET_PACK}\n          else\n            ${PREFLIGHT_PACK}\n          fi\n`;
const PLAN_STEP = "Decide each package's release from its tag, release and npm state";
const PLAN_RUN = '        id: plan\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n        run: node --experimental-strip-types scripts/packages/package-release.ts plan "$RUNNER_TEMP/packs"\n';
const PLAN_OUTPUT = "    outputs:\n      packages: ${{ steps.plan.outputs.packages }}\n";
const MATRIX = "    strategy:\n      fail-fast: false\n      matrix:\n        package: ${{ fromJSON(needs.preflight.outputs.packages) }}\n";
const APP_IDENTITY = [
  "        id: release-identity\n        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0\n        with:\n",
  "          client-id: ${{ vars.OPENLUP_RELEASE_APP_CLIENT_ID }}\n          private-key: ${{ secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY }}\n          owner: ${{ github.repository_owner }}\n",
  "          repositories: openlup\n          permission-contents: write\n          permission-administration: read\n",
].join("");
/** Every `permissions:` block of a workflow, top level and per job, as exact text; a one-line or an added grant changes it. */
const permissionBlocks = (source: string) => [...source.matchAll(/^( *)permissions:(.*)\n((?:\1 {2}\S.*\n)*)/gmu)].map((match) => `${match[1]}permissions:${match[2]}\n${match[3]}`);
/** Every `if:` line of a workflow, job or step. */
const conditions = (source: string) => [...source.matchAll(/^ *if:.*$/gmu)].map((match) => match[0]);

/** Each release control, named, as a predicate over both workflow texts. */
const CONTROLS: Record<string, (workflows: Workflows) => boolean> = {
  "release environment": ({ dispatch }) => job(dispatch, "release").includes("\n    environment: release\n") && job(dispatch, "release").includes("    needs: preflight\n") && !job(dispatch, "preflight").includes("environment:"),
  "dispatch from main only": ({ dispatch }) => JSON.stringify(triggers(dispatch)) === '["workflow_dispatch"]' && ["preflight", "release"].every((name) => job(dispatch, name).includes(`\n    ${GATE}\n`)),
  "release event only, never a source preview": ({ producer }) => JSON.stringify(triggers(producer)) === '["release"]' && producer.includes("  release:\n    types: [published]\n") && job(producer, "pack").includes("&& !github.event.release.prerelease && startsWith(github.event.release.tag_name, 'openlup-') }}"),
  "sender and author bound to the App": ({ producer }) => {
    const event = step(producer, EVENT_STEP);
    return [`.sender.type == "Bot"`, `.sender.id == ${APP}`, `.sender.login == ${BOT}`, `.release.author.id == ${APP}`, `.release.author.login == ${BOT}`, `.author.id == ${APP} and .author.login == ${BOT}`, '.action == "published"', ".repository.full_name == $repo"].every((clause) => event.includes(clause));
  },
  "release immutable, attested and assetless": ({ dispatch, producer }) => {
    const event = step(producer, EVENT_STEP), release = job(dispatch, "release");
    return [".immutable == true", ".release.draft == false", "(.release.assets | length) == 0", "(.assets | length) == 0", ".release.prerelease == false"].every((clause) => event.includes(clause))
      && step(producer, "Verify the annotated tag and GitHub release attestation").includes('gh release verify "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY"')
      && count(release, 'test "$(gh api "repos/$GITHUB_REPOSITORY/immutable-releases" --jq .enabled)" = true') === 2
      && inOrder(release, ["--method PATCH", "package-release.ts verify", 'gh release verify "openlup-$PACKAGE-v$VERSION"']);
  },
  "annotated tag bound to the release commit": ({ producer }) => {
    const tag = step(producer, "Verify the annotated tag and GitHub release attestation");
    return ['test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"', 'test "$(git cat-file -t "$tag_ref")" = tag', 'grep -Fxq "object $GITHUB_SHA"', "grep -Fxq 'type commit'", 'grep -Fxq "tag $RELEASE_TAG"', '= "OpenLup package @openlup/$package $version."'].every((clause) => tag.includes(clause));
  },
  "commit on main with the six contexts passed": ({ dispatch, producer }) => stepBody(job(dispatch, "preflight"), GATE_STEPS.preflight) === gateStep(`${DISPATCH_GATE} commit "$TARGET_COMMIT"`)
    && stepBody(job(dispatch, "release"), GATE_STEPS.release) === gateStep(`${DISPATCH_GATE} commit "$TARGET_COMMIT"`)
    && stepBody(job(producer, "pack"), GATE_STEPS.pack) === gateStep(`${PRODUCER_GATE} commit "$GITHUB_SHA"`),
  "both workflows decide main and the checks with the one release gate": ({ dispatch, producer }) => [dispatch, producer].every((text) => !/merge-base|check-runs|for context in|origin main\b|\/git\/tags|\/git\/refs/u.test(text))
    && ["preflight", "release"].every((name) => stepBody(job(dispatch, name), TAKE_STEP) === TAKE_RUN && inOrder(job(dispatch, name), [TAKE_GATE, DISPATCH_GATE]))
    && count(dispatch, TAKE_GATE) === 2 && count(dispatch, DISPATCH_GATE) === 5 && count(dispatch, "release-gate.mts") === 7
    && !/node [^\n]*scripts\/packages\/release-gate\.ts/u.test(dispatch)
    && count(producer, PRODUCER_GATE) === 1 && count(producer, `${PRODUCER_GATE} commit "$GITHUB_SHA"\n`) === 1,
  "no target file is read or run before main's gate passes": ({ dispatch }) => (["preflight", "release"] as const).every((name) => {
    const text = job(dispatch, name);
    const expected = ["Validate dispatch coordinates before checkout", "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7", ...GATE_FIRST[name]];
    return JSON.stringify(stepList(text).slice(0, expected.length)) === JSON.stringify(expected)
      && stepBody(text, TAKE_STEP) === TAKE_RUN && stepBody(text, MAIN_ASSERT_STEP) === MAIN_ASSERT && stepBody(text, TARGET_ASSERT_STEP) === TARGET_ASSERT && text.includes(`      - ${SETUP_NODE}`);
  }) && !dispatch.includes("node-version-file") && !/require\((?!"node:)/u.test(dispatch),
  "the release gate tags the approved commit": ({ dispatch }) => stepBody(job(dispatch, "release"), TAG_STEP) === TAG_RUN && count(dispatch, `${DISPATCH_GATE} tag `) === 1,
  "a later dispatch refuses rather than cancel a queued publication": ({ dispatch }) => !/^concurrency:/mu.test(dispatch) && !job(dispatch, "preflight").includes("concurrency:")
    && stepBody(job(dispatch, "preflight"), IN_FLIGHT_STEP) === gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`)
    && inOrder(job(dispatch, "preflight"), [TAKE_GATE, `${DISPATCH_GATE} in-flight`, `${DISPATCH_GATE} commit`, "npm ci --ignore-scripts"])
    && stepBody(job(dispatch, "release"), IN_FLIGHT_STEP) === gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`)
    && inOrder(job(dispatch, "release"), [TAKE_GATE, `${DISPATCH_GATE} in-flight`, `${DISPATCH_GATE} commit`, "package-release.ts prepare"]),
  "refusing checks before every write": ({ dispatch, producer }) => inOrder(job(dispatch, "preflight"), ["Validate dispatch coordinates before checkout", "actions/checkout@", TAKE_GATE, `${DISPATCH_GATE} in-flight`, `${DISPATCH_GATE} commit`, "npm ci --ignore-scripts", "package-release.ts preflight", PACK_RUN, "sha256sum --check --strict", "gitleaks dir"])
    && inOrder(job(dispatch, "release"), ["Validate dispatch coordinates before checkout", TAKE_GATE, `${DISPATCH_GATE} commit`, "package-release.ts prepare", "secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY", "immutable-releases", `${DISPATCH_GATE} tag`, 'git fetch --quiet origin "refs/tags/$tag:refs/tags/$tag"', DRAFT_TAG_REF, '--method POST "repos/$GITHUB_REPOSITORY/releases"', "package-release.ts check-draft", "--method PATCH"])
    && step(dispatch, "Create the draft release").includes(`          ${DRAFT_TAG_REF}\n`)
    && inOrder(job(producer, "pack"), [EVENT_STEP, "actions/checkout@", "gh release verify", `${PRODUCER_GATE} commit`, "npm ci --ignore-scripts", "package-release.ts registry", "npm run packages:check -- --out packs --release-tag", "packages.length !== 1", "sha256sum --check --strict", "gitleaks dir", "actions/upload-artifact@"])
    && inOrder(job(producer, "publish"), ["actions/download-artifact@", "if (actual !== sha256)", "npm publish"]),
  "no continue-on-error, || true or set +e": ({ dispatch, producer }) => [dispatch, producer].every((text) => !/continue-on-error|\|\|\s*(?:true|:)(?:\s|$)|set \+[eo]/u.test(text)),
  "id-token: write only on publish": ({ dispatch, producer }) => !dispatch.includes("id-token") && count(producer, "id-token") === 1 && job(producer, "publish").includes("    permissions:\n      id-token: write\n") && job(producer, "publish").includes("    environment: npm-stage\n")
    && [dispatch, producer].every((text) => text.includes("\npermissions: {}\n")),
  "SHA-pinned actions": ({ dispatch, producer }) => [dispatch, producer].every((text) => {
    const uses = [...text.matchAll(/uses: (\S+)/gu)].map((match) => match[1]!);
    return uses.length > 0 && uses.every((action) => /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/u.test(action));
  }),
  "anchored tag pattern": ({ dispatch, producer }) => step(producer, EVENT_STEP).includes(SHELL_TAG) && job(producer, "publish").includes(NODE_TAG)
    && count(dispatch, SHELL_VERSION) === 2 && count(dispatch, '[[ "$PACKAGE" =~ ^[a-z0-9][a-z0-9-]*$ ]]') === 2 && count(dispatch, '[[ "$TARGET_COMMIT" =~ ^[a-f0-9]{40}$ ]]') === 2,
  "--tag latest present": ({ producer }) => count(producer, "npm publish") === 1 && job(producer, "publish").includes(PUBLISH) && count(job(producer, "publish"), "--tag ") === 1,
  "the version not already on npm": ({ dispatch, producer }) => inOrder(job(dispatch, "preflight"), ["package-release.ts preflight", "npm run packages:check"])
    && inOrder(job(dispatch, "release"), ["package-release.ts prepare", "secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY"])
    && inOrder(job(producer, "pack"), ["package-release.ts registry", "npm run packages:check"]),
  "npm re-read immediately before publishing, past the cache": ({ producer }) => inOrder(job(producer, "publish"), ["if (actual !== sha256)", RECHECK_STEP, "npm publish"])
    && ["?cache-bypass=${randomUUID()}", "await read(`https://registry.npmjs.org/-/package/${path}/dist-tags`)", "if (held.has(version)) throw", "if (!above(other)) throw", `' "$RELEASE_TAG"`].every((clause) => step(producer, RECHECK_STEP).includes(clause)),
  "the preflight plans each package after packing and scanning every tarball": ({ dispatch }) => stepBody(job(dispatch, "preflight"), "Pack and check the packages of this release") === PACK_RUN
    && job(dispatch, "preflight").endsWith(`      - name: ${PLAN_STEP}\n${PLAN_RUN}\n`) && count(dispatch, "package-release.ts plan") === 1
    && inOrder(job(dispatch, "preflight"), [PACK_RUN, GITLEAKS_SCAN, `      - name: ${PLAN_STEP}\n`])
    && job(dispatch, "preflight").includes(`    runs-on: ubuntu-24.04\n    # The packages the plan step releases in full, as a JSON array of directory names.\n${PLAN_OUTPUT}`) && count(dispatch, "outputs:") === 1,
  "one approval releases each planned package in its own leg": ({ dispatch }) => job(dispatch, "release").includes(MATRIX) && count(dispatch, "strategy:") === 1 && !/max-parallel|fail-fast: true/u.test(dispatch)
    && job(dispatch, "release").includes("    env:\n      PACKAGE: ${{ matrix.package }}\n") && count(dispatch, "PACKAGE: ${{ inputs.package }}") === 1 && job(dispatch, "preflight").includes("      PACKAGE: ${{ inputs.package }}\n")
    && count(dispatch, "environment: release") === 1,
  "a release leg releases one package the dispatch named": ({ dispatch }) => step(job(dispatch, "release"), "Validate dispatch coordinates before checkout").includes(`          [[ "$PACKAGE" =~ ^[a-z0-9][a-z0-9-]*$ ]]\n          [[ "$PACKAGE" != all ]]\n          [[ "$DISPATCH" = all || "$DISPATCH" = "$PACKAGE" ]]\n`)
    && job(dispatch, "release").includes("      PACKAGE: ${{ matrix.package }}\n      DISPATCH: ${{ inputs.package }}\n") && count(dispatch, "DISPATCH: ") === 1,
  "one package's releases and publications serialized": ({ dispatch, producer }) => job(dispatch, "release").includes(`${RELEASE_GROUP}    environment: release\n`)
    && job(producer, "publish").includes("    concurrency:\n      group: openlup-package-release-${{ needs.pack.outputs.package }}\n      cancel-in-progress: false\n")
    && job(producer, "pack").includes("      package: ${{ steps.tag.outputs.package }}\n")
    && step(producer, "Verify the annotated tag and GitHub release attestation").startsWith("        id: tag\n")
    && step(producer, "Verify the annotated tag and GitHub release attestation").includes('echo "package=$package" >> "$GITHUB_OUTPUT"'),
  "pinned secret scans before the tag and before publishing": ({ dispatch, producer }) => inOrder(job(dispatch, "preflight"), [...GITLEAKS_INSTALL, 'for tarball in "$RUNNER_TEMP"/packs/*.tgz; do', 'test -f "$tarball"', 'tar -xzf "$tarball" -C "$target"', GITLEAKS_SCAN])
    && inOrder(job(producer, "pack"), [...GITLEAKS_INSTALL, "for tarball in packs/*.tgz; do", 'tar -xzf "$tarball" -C "$target"', GITLEAKS_SCAN]),
  "exact permission sets": ({ dispatch, producer }) => JSON.stringify(permissionBlocks(dispatch)) === JSON.stringify(["permissions: {}\n", "    permissions:\n      contents: read\n      checks: read\n      actions: read\n", "    permissions:\n      contents: read\n      checks: read\n      attestations: read\n      actions: read\n"])
    && JSON.stringify(permissionBlocks(producer)) === JSON.stringify(["permissions: {}\n", "    permissions:\n      contents: read\n      checks: read\n      attestations: read\n", "    permissions:\n      id-token: write\n"])
    && job(dispatch, "preflight").includes("    permissions:\n      contents: read\n      checks: read\n      actions: read\n    env:") && job(dispatch, "release").includes("    environment: release\n    permissions:\n      contents: read\n      checks: read\n      attestations: read\n      actions: read\n    env:")
    && job(producer, "pack").includes("    permissions:\n      contents: read\n      checks: read\n      attestations: read\n") && job(producer, "publish").includes("    permissions:\n      id-token: write\n"),
  "exact App token grant": ({ dispatch, producer }) => step(dispatch, "Obtain the maintainer-configured release identity") === APP_IDENTITY && count(dispatch, "create-github-app-token@") === 1 && !producer.includes("create-github-app-token"),
  "exact run conditions": ({ dispatch, producer }) => JSON.stringify(conditions(dispatch)) === JSON.stringify([`    ${GATE}`, `    ${GATE}`, "        if: failure()"])
    && JSON.stringify(conditions(producer)) === JSON.stringify([`    ${PACK_GATE}`])
    && /^ {8}if: failure\(\)\n {8}run: \|\n {10}echo '[^'\n]*'\n$/u.test(step(dispatch, "Recovery requires the maintainer")),
  "the App-token job installs, builds and packs nothing": ({ dispatch }) => !/npm (?:ci|install|run|pack|exec)\b|npx |packages:check -- --out|packages-check\.ts|--out\b|--pack\b/u.test(job(dispatch, "release")),
  "App credential only where the release writes": ({ dispatch, producer }) => !job(dispatch, "preflight").includes("OPENLUP_RELEASE_APP") && !producer.includes("OPENLUP_RELEASE_APP")
    && step(dispatch, TAG_STEP).includes(APP_TOKEN_ENV) && ["Create the draft release", "Publish the immutable release with the release identity"].every((name) => step(dispatch, name).includes(APP_TOKEN))
    && job(dispatch, "release").includes("repositories: openlup\n          permission-contents: write\n          permission-administration: read\n")
    && [job(dispatch, "preflight"), job(dispatch, "release"), job(producer, "pack")].every((text) => !/^ {6}contents: write$/mu.test(text)),
  "publish job gets only the checked tarball": ({ producer }) => {
    const publish = job(producer, "publish");
    return publish.includes("    needs: pack\n") && !/actions\/checkout@|npm ci|npm install|npm run/u.test(publish)
      && [`manifest.commit !== ${ENV}.GITHUB_SHA`, "manifest.packages.length !== 1", "unlisted file", "if (actual !== sha256)"].every((clause) => publish.includes(clause));
  },
  "checkouts keep no credentials": ({ dispatch, producer }) => [dispatch, producer].every((text) => count(text, "actions/checkout@") === count(text, "persist-credentials: false")),
  "inputs reach scripts only through env": ({ dispatch, producer }) => [dispatch, producer].every((text) => runLines(text).length > 20 && runLines(text).every((line) => !line.includes("${{"))),
  "no overwrite or deletion": ({ dispatch, producer }) => [dispatch, producer].every((text) => !/--clobber|--force|--method DELETE|npm unpublish|npm dist-tag|gh release upload|gh release delete/u.test(text)),
};

const failing = (workflows: Workflows) => Object.entries(CONTROLS).filter(([, holds]) => !holds(workflows)).map(([name]) => name);
type Defect = { control: string; plant: string; in: keyof Workflows; from: string | RegExp; to: string };

/** One or more planted defects per control. Each replaces committed text, so a stale anchor fails too. */
const DEFECTS: Defect[] = [
  { control: "release environment", plant: "drop the protected environment", in: "dispatch", from: "    environment: release\n", to: "" },
  { control: "release environment", plant: "rename the environment", in: "dispatch", from: "    environment: release\n", to: "    environment: release-unprotected\n" },
  { control: "release environment", plant: "release without the preflight", in: "dispatch", from: "    needs: preflight\n", to: "" },
  { control: "dispatch from main only", plant: "any branch may dispatch", in: "dispatch", from: /github\.ref == 'refs\/heads\/main' && /gu, to: "" },
  { control: "dispatch from main only", plant: "a push also releases", in: "dispatch", from: "on:\n  workflow_dispatch:\n", to: "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n" },
  { control: "dispatch from main only", plant: "no repository variable gate", in: "dispatch", from: /vars\.OPENLUP_PACKAGE_RELEASE == 'enabled' && /gu, to: "" },
  { control: "release event only, never a source preview", plant: "previews reach the pack job", in: "producer", from: " && !github.event.release.prerelease", to: "" },
  { control: "release event only, never a source preview", plant: "any release event action", in: "producer", from: "    types: [published]\n", to: "    types: [published, edited]\n" },
  { control: "sender and author bound to the App", plant: "any sender id", in: "producer", from: `.sender.id == ${APP} and`, to: ".sender.id > 0 and" },
  { control: "sender and author bound to the App", plant: "any sender type", in: "producer", from: '.sender.type == "Bot" and ', to: "" },
  { control: "sender and author bound to the App", plant: "any release author", in: "producer", from: `.release.author.id == ${APP} and`, to: "" },
  { control: "sender and author bound to the App", plant: "any live author", in: "producer", from: `.author.id == ${APP} and .author.login == ${BOT} and`, to: "" },
  { control: "release immutable, attested and assetless", plant: "mutable live release", in: "producer", from: ".immutable == true and ", to: "" },
  { control: "release immutable, attested and assetless", plant: "no attestation check", in: "producer", from: '          gh release verify "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY"\n', to: "" },
  { control: "release immutable, attested and assetless", plant: "no immutability check before publication", in: "dispatch", from: '          test "$(gh api "repos/$GITHUB_REPOSITORY/immutable-releases" --jq .enabled)" = true\n          printf', to: "          printf" },
  { control: "release immutable, attested and assetless", plant: "no release attestation after publication", in: "dispatch", from: 'run: gh release verify "openlup-$PACKAGE-v$VERSION"', to: "run: true" },
  { control: "release immutable, attested and assetless", plant: "assets admitted", in: "producer", from: " and (.release.assets | length) == 0", to: "" },
  { control: "annotated tag bound to the release commit", plant: "lightweight tag admitted", in: "producer", from: '          test "$(git cat-file -t "$tag_ref")" = tag\n', to: "" },
  { control: "annotated tag bound to the release commit", plant: "tag message unchecked", in: "producer", from: '= "OpenLup package @openlup/$package $version."', to: '!= ""' },
  { control: "commit on main with the six contexts passed", plant: "no main ancestry at publication", in: "producer", from: `run: ${PRODUCER_GATE} commit "$GITHUB_SHA"`, to: "run: true" },
  { control: "commit on main with the six contexts passed", plant: "the preflight gates the dispatched main commit, not the target", in: "dispatch", from: `run: ${DISPATCH_GATE} commit "$TARGET_COMMIT"`, to: `run: ${DISPATCH_GATE} commit "$GITHUB_SHA"` },
  { control: "commit on main with the six contexts passed", plant: "a refused gate only warns", in: "producer", from: `commit "$GITHUB_SHA"\n`, to: `commit "$GITHUB_SHA" || echo "::warning::the release gate refused"\n` },
  { control: "commit on main with the six contexts passed", plant: "no gate in the release job", in: "dispatch", from: `      # The same release gate as the preflight and publish-packages.yml.\n      - name: ${GATE_STEPS.release}\n${gateStep(`${DISPATCH_GATE} commit "$TARGET_COMMIT"`)}`, to: "" },
  { control: "both workflows decide main and the checks with the one release gate", plant: "the publish workflow keeps its own check loop", in: "producer", from: `        run: ${PRODUCER_GATE} commit "$GITHUB_SHA"\n`, to: ["        run: |\n", '          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\n          git fetch --no-tags --quiet origin main\n          git merge-base --is-ancestor "$GITHUB_SHA" FETCH_HEAD\n', "          for context in dco typecheck install-proof test self-check gitleaks; do\n", '            verdict="$(gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs?check_name=$context&filter=latest&per_page=100" --jq \'if (.check_runs | any(.conclusion == "success")) then "passed" else "missing" end\')"\n', '            [ "$verdict" = passed ]\n          done\n'].join("") },
  { control: "both workflows decide main and the checks with the one release gate", plant: "the release job runs the target's own gate", in: "dispatch", from: `      - name: ${GATE_STEPS.release}\n        env:\n          GITHUB_TOKEN: \${{ github.token }}\n        run: ${DISPATCH_GATE}`, to: `      - name: ${GATE_STEPS.release}\n        env:\n          GITHUB_TOKEN: \${{ github.token }}\n        run: ${PRODUCER_GATE}` },
  { control: "both workflows decide main and the checks with the one release gate", plant: "the gate taken from the target commit", in: "dispatch", from: '"$GITHUB_SHA:scripts/packages/release-gate.ts"', to: '"$TARGET_COMMIT:scripts/packages/release-gate.ts"' },
  { control: "both workflows decide main and the checks with the one release gate", plant: "a second required-check query in the dispatch", in: "dispatch", from: "      - run: npm ci --ignore-scripts --no-audit --fund=false\n", to: '      - run: gh api "repos/$GITHUB_REPOSITORY/commits/$TARGET_COMMIT/check-runs?check_name=test" --jq .total_count\n      - run: npm ci --ignore-scripts --no-audit --fund=false\n' },
  { control: "no target file is read or run before main's gate passes", plant: "setup-node reads the target's .nvmrc", in: "dispatch", from: "          node-version: ${{ steps.main.outputs.node-version }}\n", to: "          node-version-file: .nvmrc\n" },
  { control: "no target file is read or run before main's gate passes", plant: "the release job's setup-node reads the target's .nvmrc", in: "dispatch", from: `${RELEASE_TAKE}      - name: ${TAKE_STEP}\n${TAKE_RUN}      - ${SETUP_NODE}`, to: `${RELEASE_TAKE}      - name: ${TAKE_STEP}\n${TAKE_RUN}      - ${SETUP_NODE.replace("node-version: ${{ steps.main.outputs.node-version }}", "node-version-file: .nvmrc")}` },
  { control: "no target file is read or run before main's gate passes", plant: "a require of the target's package.json before the gate", in: "dispatch", from: 'JSON.parse(require("node:fs").readFileSync("main-package.json", "utf8")).engines.node', to: 'require("./package.json").engines.node' },
  { control: "no target file is read or run before main's gate passes", plant: "a require of the target's package.json after the gate", in: "dispatch", from: 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).engines.node', to: 'require("./package.json").engines.node' },
  { control: "no target file is read or run before main's gate passes", plant: "a step reading the target tree before the preflight's gate", in: "dispatch", from: `      - name: ${IN_FLIGHT_STEP}\n`, to: `      - name: Read the target early\n        run: cat package.json\n      - name: ${IN_FLIGHT_STEP}\n` },
  { control: "no target file is read or run before main's gate passes", plant: "the target's contract asserted before the release job's gate", in: "dispatch", from: `      # The same release gate as the preflight and publish-packages.yml.\n      - name: ${GATE_STEPS.release}\n`, to: `      - name: ${TARGET_ASSERT_STEP}\n        run: cat .nvmrc package.json\n      # The same release gate as the preflight and publish-packages.yml.\n      - name: ${GATE_STEPS.release}\n` },
  { control: "no target file is read or run before main's gate passes", plant: "a require of the target's package.json before a leg's gate", in: "dispatch", from: `${MAIN_ASSERT}${LEG_IN_FLIGHT}`, to: `${OLD_ASSERT}${LEG_IN_FLIGHT}` },
  { control: "no target file is read or run before main's gate passes", plant: "a leg's gate copied from the checkout", in: "dispatch", from: `${RELEASE_TAKE}      - name: ${TAKE_STEP}\n        id: main\n        run: |\n          ${TAKE_GATE}\n`, to: `${RELEASE_TAKE}      - name: ${TAKE_STEP}\n        id: main\n        run: |\n          cp scripts/packages/release-gate.ts "$RUNNER_TEMP/release-gate.mts"\n` },
  { control: "no target file is read or run before main's gate passes", plant: "the gate copied from the checkout", in: "dispatch", from: TAKE_GATE, to: 'cp scripts/packages/release-gate.ts "$RUNNER_TEMP/release-gate.mts"' },
  { control: "no target file is read or run before main's gate passes", plant: "the Node version read from the checkout", in: "dispatch", from: 'node_version="$(git show "$GITHUB_SHA:.nvmrc")"', to: 'node_version="$(cat .nvmrc)"' },
  { control: "no target file is read or run before main's gate passes", plant: "the Node contract copied from the checkout", in: "dispatch", from: 'git show "$GITHUB_SHA:package.json" > "$RUNNER_TEMP/main-package.json"', to: 'cp package.json "$RUNNER_TEMP/main-package.json"' },
  { control: "no target file is read or run before main's gate passes", plant: "node and npm asserted inside the checkout", in: "dispatch", from: "        working-directory: ${{ runner.temp }}\n", to: "" },
  { control: "the release gate tags the approved commit", plant: "the tag on the dispatched main commit", in: "dispatch", from: `tag "$TARGET_COMMIT" "$PACKAGE" "$VERSION"`, to: `tag "$GITHUB_SHA" "$PACKAGE" "$VERSION"` },
  { control: "the release gate tags the approved commit", plant: "the tag written outside the gate on the main tip", in: "dispatch", from: `          ${DISPATCH_GATE} tag "$TARGET_COMMIT" "$PACKAGE" "$VERSION"\n`, to: '          gh api --method POST "repos/$GITHUB_REPOSITORY/git/tags" -f tag="openlup-$PACKAGE-v$VERSION" -f object="$(git rev-parse refs/remotes/origin/main)" -f type=commit\n' },
  { control: "a later dispatch refuses rather than cancel a queued publication", plant: "the whole dispatch queues in the package's group", in: "dispatch", from: "\npermissions: {}\n\njobs:", to: "\npermissions: {}\n\nconcurrency:\n  group: openlup-package-release-${{ inputs.package }}\n  cancel-in-progress: false\n\njobs:" },
  { control: "a later dispatch refuses rather than cancel a queued publication", plant: "the preflight queues in the package's group", in: "dispatch", from: "    timeout-minutes: 20\n    permissions:", to: `    timeout-minutes: 20\n${RELEASE_GROUP}    permissions:` },
  { control: "a later dispatch refuses rather than cancel a queued publication", plant: "a re-run leg without the in-flight refusal", in: "dispatch", from: `${LEG_IN_FLIGHT}      - name: ${IN_FLIGHT_STEP}\n${gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`)}`, to: "" },
  { control: "a later dispatch refuses rather than cancel a queued publication", plant: "a leg that refuses only for another run ID", in: "dispatch", from: `${LEG_IN_FLIGHT}      - name: ${IN_FLIGHT_STEP}\n${gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`)}`, to: `${LEG_IN_FLIGHT}      - name: ${IN_FLIGHT_STEP}\n${gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_NUMBER"`)}` },
  { control: "a later dispatch refuses rather than cancel a queued publication", plant: "no in-flight refusal", in: "dispatch", from: `run: ${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`, to: "run: echo skipped" },
  { control: "a later dispatch refuses rather than cancel a queued publication", plant: "the in-flight refusal after the install", in: "dispatch", from: `      - name: ${IN_FLIGHT_STEP}\n${gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`)}      - name: ${GATE_STEPS.preflight}\n${gateStep(`${DISPATCH_GATE} commit "$TARGET_COMMIT"`)}${TARGET_ASSERT_TEXT}      - run: npm ci --ignore-scripts --no-audit --fund=false\n`, to: `      - name: ${GATE_STEPS.preflight}\n${gateStep(`${DISPATCH_GATE} commit "$TARGET_COMMIT"`)}${TARGET_ASSERT_TEXT}      - run: npm ci --ignore-scripts --no-audit --fund=false\n      - name: ${IN_FLIGHT_STEP}\n${gateStep(`${DISPATCH_GATE} in-flight "$GITHUB_RUN_ID"`)}` },
  { control: "refusing checks before every write", plant: "no tarball scan before tagging", in: "dispatch", from: '          gitleaks dir "$RUNNER_TEMP/scan" --config config/gitleaks.toml --redact --no-banner\n', to: "" },
  { control: "refusing checks before every write", plant: "draft published unchecked", in: "dispatch", from: "        run: node --experimental-strip-types scripts/packages/package-release.ts check-draft\n", to: "        run: echo skipped\n" },
  { control: "refusing checks before every write", plant: "no pack check at publication", in: "producer", from: "          npm run packages:check -- --out packs --release-tag \"$RELEASE_TAG\"\n", to: "          npm pack --pack-destination packs\n" },
  { control: "refusing checks before every write", plant: "no digest check before publish", in: "producer", from: "if (actual !== sha256)", to: "if (false)" },
  { control: "no continue-on-error, || true or set +e", plant: "continue-on-error", in: "producer", from: "    timeout-minutes: 10\n", to: "    timeout-minutes: 10\n    continue-on-error: true\n" },
  { control: "no continue-on-error, || true or set +e", plant: "|| true", in: "dispatch", from: "run: node --experimental-strip-types scripts/packages/package-release.ts preflight", to: "run: node --experimental-strip-types scripts/packages/package-release.ts preflight || true" },
  { control: "id-token: write only on publish", plant: "OIDC in the pack job", in: "producer", from: "      attestations: read\n    outputs:", to: "      attestations: read\n      id-token: write\n    outputs:" },
  { control: "id-token: write only on publish", plant: "OIDC in the release job", in: "dispatch", from: "      attestations: read\n", to: "      attestations: read\n      id-token: write\n" },
  { control: "id-token: write only on publish", plant: "publish outside npm-stage", in: "producer", from: "    environment: npm-stage\n", to: "" },
  { control: "id-token: write only on publish", plant: "default workflow permissions", in: "dispatch", from: "\npermissions: {}\n", to: "\n" },
  { control: "SHA-pinned actions", plant: "a tag-pinned action", in: "producer", from: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", to: "actions/upload-artifact@v7" },
  { control: "SHA-pinned actions", plant: "a branch-pinned action", in: "dispatch", from: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1", to: "actions/create-github-app-token@main" },
  { control: "anchored tag pattern", plant: "unanchored start", in: "producer", from: '[[ "$RELEASE_TAG" =~ ^openlup-', to: '[[ "$RELEASE_TAG" =~ openlup-' },
  { control: "anchored tag pattern", plant: "unanchored end", in: "producer", from: "(0|[1-9][0-9]*)$ ]] || exit 1", to: "(0|[1-9][0-9]*) ]] || exit 1" },
  { control: "anchored tag pattern", plant: "unchecked tag at publish", in: "producer", from: `(?:0|[1-9]\\d*))$/.exec(${ENV}.RELEASE_TAG)`, to: `(?:0|[1-9]\\d*))/.exec(${ENV}.RELEASE_TAG)` },
  { control: "anchored tag pattern", plant: "unvalidated dispatch version", in: "dispatch", from: SHELL_VERSION, to: '[[ -n "$VERSION" ]]' },
  { control: "--tag latest present", plant: "preview tag", in: "producer", from: "--access public --tag latest", to: "--access public --tag preview" },
  { control: "--tag latest present", plant: "implicit tag", in: "producer", from: "--access public --tag latest --ignore-scripts", to: "--access public --ignore-scripts" },
  { control: "--tag latest present", plant: "a second publish", in: "producer", from: PUBLISH, to: `${PUBLISH}\n          npm publish ./packs/extra.tgz --tag next` },
  { control: "the version not already on npm", plant: "no npm check in preflight", in: "dispatch", from: "        run: node --experimental-strip-types scripts/packages/package-release.ts preflight\n", to: "        run: echo skipped\n" },
  { control: "the version not already on npm", plant: "no npm check before the App token", in: "dispatch", from: "scripts/packages/package-release.ts prepare", to: "scripts/packages/package-release.ts note" },
  { control: "the version not already on npm", plant: "no npm check at publication", in: "producer", from: "        run: node --experimental-strip-types scripts/packages/package-release.ts registry\n", to: "        run: echo skipped\n" },
  { control: "npm re-read immediately before publishing, past the cache", plant: "publish without the re-check", in: "producer", from: /^ {6}# An explicit dist-tag turns off[\s\S]*?' "\$RELEASE_TAG"\n/mu, to: "" },
  { control: "npm re-read immediately before publishing, past the cache", plant: "a cached registry read", in: "producer", from: "?cache-bypass=${randomUUID()}", to: "" },
  { control: "npm re-read immediately before publishing, past the cache", plant: "dist-tags unread", in: "producer", from: "await read(`https://registry.npmjs.org/-/package/${path}/dist-tags`)", to: "undefined" },
  { control: "npm re-read immediately before publishing, past the cache", plant: "a held version admitted", in: "producer", from: "if (held.has(version)) throw", to: "if (false) throw" },
  { control: "one package's releases and publications serialized", plant: "publish job not serialized", in: "producer", from: "    concurrency:\n      group: openlup-package-release-${{ needs.pack.outputs.package }}\n      cancel-in-progress: false\n", to: "" },
  { control: "one package's releases and publications serialized", plant: "publish serialized per tag", in: "producer", from: "openlup-package-release-${{ needs.pack.outputs.package }}", to: "openlup-package-release-${{ github.event.release.tag_name }}" },
  { control: "one package's releases and publications serialized", plant: "releases serialized apart from publications", in: "dispatch", from: "group: openlup-package-release-${{ matrix.package }}", to: "group: publish-package" },
  { control: "one package's releases and publications serialized", plant: "every leg in the dispatched name's group", in: "dispatch", from: "group: openlup-package-release-${{ matrix.package }}", to: "group: openlup-package-release-${{ inputs.package }}" },
  { control: "the preflight plans each package after packing and scanning every tarball", plant: "no plan: the release job gets no packages", in: "dispatch", from: `      # Each package by its tag, release and npm state, against the tarballs packed above.\n      - name: ${PLAN_STEP}\n${PLAN_RUN}`, to: "" },
  { control: "the preflight plans each package after packing and scanning every tarball", plant: "a plan before the pack, without tarballs to compare", in: "dispatch", from: "      - name: Pack and check the packages of this release\n", to: `      - name: ${PLAN_STEP}\n${PLAN_RUN}      - name: Pack and check the packages of this release\n` },
  { control: "the preflight plans each package after packing and scanning every tarball", plant: "the plan replaced by the dispatched package", in: "dispatch", from: 'run: node --experimental-strip-types scripts/packages/package-release.ts plan "$RUNNER_TEMP/packs"', to: 'run: echo "packages=[\\"$PACKAGE\\"]" >> "$GITHUB_OUTPUT"' },
  { control: "the preflight plans each package after packing and scanning every tarball", plant: "the output read from another step", in: "dispatch", from: "packages: ${{ steps.plan.outputs.packages }}", to: "packages: ${{ steps.pack.outputs.packages }}" },
  { control: "the preflight plans each package after packing and scanning every tarball", plant: "the set packs only one package", in: "dispatch", from: SET_PACK, to: PREFLIGHT_PACK },
  { control: "the preflight plans each package after packing and scanning every tarball", plant: "the set packs nothing", in: "dispatch", from: `            ${SET_PACK}\n`, to: "            true\n" },
  { control: "one approval releases each planned package in its own leg", plant: "one failed leg cancels the others", in: "dispatch", from: "      fail-fast: false\n", to: "      fail-fast: true\n" },
  { control: "one approval releases each planned package in its own leg", plant: "fail-fast left at its default", in: "dispatch", from: "      fail-fast: false\n", to: "" },
  { control: "one approval releases each planned package in its own leg", plant: "one leg at a time, each asking for its own approval", in: "dispatch", from: "      fail-fast: false\n", to: "      fail-fast: false\n      max-parallel: 1\n" },
  { control: "one approval releases each planned package in its own leg", plant: "each leg releases the dispatched name", in: "dispatch", from: "      PACKAGE: ${{ matrix.package }}\n", to: "      PACKAGE: ${{ inputs.package }}\n" },
  { control: "one approval releases each planned package in its own leg", plant: "the legs taken from the dispatch, not the plan", in: "dispatch", from: "package: ${{ fromJSON(needs.preflight.outputs.packages) }}", to: "package: ${{ fromJSON(format('[\"{0}\"]', inputs.package)) }}" },
  { control: "a release leg releases one package the dispatch named", plant: "no refusal of the set's name", in: "dispatch", from: '          [[ "$PACKAGE" != all ]]\n', to: "" },
  { control: "a release leg releases one package the dispatch named", plant: "a one-package dispatch releases whatever the plan names", in: "dispatch", from: '          [[ "$DISPATCH" = all || "$DISPATCH" = "$PACKAGE" ]]\n', to: "" },
  { control: "a release leg releases one package the dispatch named", plant: "the dispatch compared with the leg itself", in: "dispatch", from: "      DISPATCH: ${{ inputs.package }}\n", to: "      DISPATCH: ${{ matrix.package }}\n" },
  { control: "one package's releases and publications serialized", plant: "release job not serialized", in: "dispatch", from: RELEASE_GROUP, to: "" },
  { control: "one package's releases and publications serialized", plant: "an in-flight publication cancelled", in: "producer", from: "openlup-package-release-${{ needs.pack.outputs.package }}\n      cancel-in-progress: false", to: "openlup-package-release-${{ needs.pack.outputs.package }}\n      cancel-in-progress: true" },
  { control: "pinned secret scans before the tag and before publishing", plant: "pre-tag checksum replaced", in: "dispatch", from: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb", to: "0".repeat(64) },
  { control: "pinned secret scans before the tag and before publishing", plant: "pre-tag asset replaced", in: "dispatch", from: "releases/assets/378332058", to: "releases/assets/378332059" },
  { control: "pinned secret scans before the tag and before publishing", plant: "pre-tag tarball not extracted", in: "dispatch", from: '            tar -xzf "$tarball" -C "$target"\n', to: "" },
  { control: "pinned secret scans before the tag and before publishing", plant: "pre-publish tarball not extracted", in: "producer", from: '            tar -xzf "$tarball" -C "$target"\n', to: "" },
  { control: "pinned secret scans before the tag and before publishing", plant: "pre-tag scan without its config", in: "dispatch", from: " --config config/gitleaks.toml", to: "" },
  { control: "exact run conditions", plant: "pack job without the repository gate", in: "producer", from: "github.repository == 'openlup/openlup' && vars.OPENLUP_NPM_STAGE", to: "vars.OPENLUP_NPM_STAGE" },
  { control: "exact run conditions", plant: "pack job without the npm switch", in: "producer", from: "vars.OPENLUP_NPM_STAGE == 'enabled' && !github", to: "!github" },
  { control: "exact run conditions", plant: "publish runs after a failed pack", in: "producer", from: "    needs: pack\n", to: "    needs: pack\n    if: always()\n" },
  { control: "exact run conditions", plant: "publish runs unless cancelled", in: "producer", from: "    needs: pack\n", to: "    needs: pack\n    if: ${{ !cancelled() }}\n" },
  { control: "exact run conditions", plant: "npm publish after a failed re-read", in: "producer", from: "      - name: Publish the verified tarball with OIDC provenance\n", to: "      - name: Publish the verified tarball with OIDC provenance\n        if: always()\n" },
  { control: "exact run conditions", plant: "tag created after a failed prepare", in: "dispatch", from: "      - name: Create the exact annotated tag with the release identity\n", to: "      - name: Create the exact annotated tag with the release identity\n        if: success() || failure()\n" },
  { control: "exact run conditions", plant: "the recovery step writes", in: "dispatch", from: "        if: failure()\n        run: |\n", to: "        if: failure()\n        run: |\n          gh api --method PATCH \"repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID\" -f draft=false\n" },
  { control: "exact permission sets", plant: "contents: write on publish", in: "producer", from: "      id-token: write\n", to: "      id-token: write\n      contents: write\n" },
  { control: "exact permission sets", plant: "actions: write on release", in: "dispatch", from: "      attestations: read\n", to: "      attestations: read\n      actions: write\n" },
  { control: "exact permission sets", plant: "write-all on the pack job", in: "producer", from: "    permissions:\n      contents: read\n      checks: read\n      attestations: read\n", to: "    permissions: write-all\n" },
  { control: "exact permission sets", plant: "contents: write on the preflight", in: "dispatch", from: "    permissions:\n      contents: read\n      checks: read\n      actions: read\n    env:", to: "    permissions:\n      contents: write\n      checks: read\n      actions: read\n    env:" },
  { control: "exact permission sets", plant: "actions: write on the preflight", in: "dispatch", from: "      checks: read\n      actions: read\n    env:", to: "      checks: read\n      actions: write\n    env:" },
  { control: "exact permission sets", plant: "a workflow-wide grant", in: "producer", from: "\npermissions: {}\n", to: "\npermissions:\n  contents: write\n" },
  { control: "exact App token grant", plant: "an extra App permission", in: "dispatch", from: "          permission-administration: read\n", to: "          permission-administration: read\n          permission-actions: write\n" },
  { control: "exact App token grant", plant: "the App token for every repository", in: "dispatch", from: "          repositories: openlup\n", to: "" },
  { control: "refusing checks before every write", plant: "draft created without the tag-ref check", in: "dispatch", from: `          ${DRAFT_TAG_REF}\n`, to: "" },
  { control: "refusing checks before every write", plant: "preflight pack without the release tag", in: "dispatch", from: ' --release-tag "openlup-$PACKAGE-v$VERSION"', to: "" },
  { control: "the App-token job installs, builds and packs nothing", plant: "install in the release job", in: "dispatch", from: "      # No install, build or pack here:", to: "      - run: npm ci --ignore-scripts --no-audit --fund=false\n      # No install, build or pack here:" },
  { control: "the App-token job installs, builds and packs nothing", plant: "pack in the release job", in: "dispatch", from: "      # No install, build or pack here:", to: "      - run: npm run packages:check -- --out packs\n      # No install, build or pack here:" },
  { control: "the App-token job installs, builds and packs nothing", plant: "a direct packages-check.ts pack in the release job", in: "dispatch", from: "      # No install, build or pack here:", to: '      - run: node --experimental-strip-types scripts/packages/packages-check.ts --out "$RUNNER_TEMP/packs"\n      # No install, build or pack here:' },
  { control: "App credential only where the release writes", plant: "App key in the unprivileged preflight", in: "dispatch", from: "      RELEASE_NOTES: ${{ inputs.notes }}\n    steps:\n      - name: Validate dispatch coordinates before checkout\n        run: |\n          [[ \"$PACKAGE\"", to: "      RELEASE_NOTES: ${{ inputs.notes }}\n      KEY: ${{ secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY }}\n    steps:\n      - name: Validate dispatch coordinates before checkout\n        run: |\n          [[ \"$PACKAGE\"" },
  { control: "App credential only where the release writes", plant: "tag written with the default token", in: "dispatch", from: `          ${APP_TOKEN_ENV}\n        run: |\n          ${DISPATCH_GATE} tag`, to: `          GITHUB_TOKEN: \${{ github.token }}\n        run: |\n          ${DISPATCH_GATE} tag` },
  { control: "App credential only where the release writes", plant: "write permission on the default token", in: "dispatch", from: "    permissions:\n      contents: read\n      checks: read\n      actions: read\n    env:", to: "    permissions:\n      contents: write\n      checks: read\n      actions: read\n    env:" },
  { control: "publish job gets only the checked tarball", plant: "checkout in the publish job", in: "producer", from: "    steps:\n      - uses: actions/download-artifact@", to: "    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false\n      - uses: actions/download-artifact@" },
  { control: "publish job gets only the checked tarball", plant: "commit unchecked", in: "producer", from: `manifest.commit !== ${ENV}.GITHUB_SHA`, to: "false" },
  { control: "checkouts keep no credentials", plant: "persisted checkout token", in: "dispatch", from: "          fetch-depth: 0\n          persist-credentials: false\n", to: "          fetch-depth: 0\n" },
  { control: "inputs reach scripts only through env", plant: "dispatch notes interpolated into shell", in: "dispatch", from: "run: node --experimental-strip-types scripts/packages/package-release.ts preflight", to: 'run: node --experimental-strip-types scripts/packages/package-release.ts preflight "${{ inputs.notes }}"' },
  { control: "inputs reach scripts only through env", plant: "release name interpolated into a block", in: "producer", from: "          tag_ref=\"refs/tags/$RELEASE_TAG\"\n", to: "          tag_ref=\"refs/tags/$RELEASE_TAG\"\n          echo \"${{ github.event.release.name }}\"\n" },
  { control: "no overwrite or deletion", plant: "dist-tag rewrite", in: "producer", from: PUBLISH, to: `${PUBLISH}\n          npm dist-tag add "@openlup/x@1.0.0" latest` },
  { control: "no overwrite or deletion", plant: "release deletion on failure", in: "dispatch", from: "        if: failure()\n        run: |\n", to: "        if: failure()\n        run: |\n          gh release delete \"openlup-$PACKAGE-v$VERSION\" --yes\n" },
];

// A function replacer, so a `$` in workflow text is never read as a replacement pattern.
const plant = ({ in: file, from, to }: Defect): Workflows => ({ ...committed, [file]: committed[file].replace(from, () => to) });

describe("package release workflow controls", () => {
  it("hold on the committed workflows", () => {
    expect(failing(committed)).toEqual([]);
  });

  it("each control has a planted defect", () => {
    expect(new Set(DEFECTS.map(({ control }) => control))).toEqual(new Set(Object.keys(CONTROLS)));
  });

  it.each(DEFECTS.map((defect) => [`${defect.control}: ${defect.plant}`, defect] as const))("turns red on %s", (_, defect) => {
    const planted = plant(defect);
    expect(planted[defect.in], "the planted defect changes the committed workflow").not.toBe(committed[defect.in]);
    expect(failing(planted)).toContain(defect.control);
  });

  it("turns red on set +e and on || :", () => {
    const control = "no continue-on-error, || true or set +e";
    const insert = (text: string, line: string) => text.replace("        run: |\n", `        run: |\n          ${line}\n`);
    for (const line of ["set +e", "set +o pipefail", "node -e '' || :"]) {
      expect(failing({ ...committed, producer: insert(committed.producer, line) }), line).toContain(control);
      expect(failing({ ...committed, dispatch: insert(committed.dispatch, line) }), line).toContain(control);
    }
  });
});

describe("the dispatch preflight against a target whose package.json is a directory", () => {
  const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
  const identity = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: { ...inherited, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Run by require("./package.json"): it records that target code ran and replaces the main gate copy.
  const HOSTILE = 'const { writeFileSync } = require("node:fs");\nconst temp = Reflect.get(process, "env").RUNNER_TEMP;\nwriteFileSync(`${temp}/target-code-ran`, "yes");\nwriteFileSync(`${temp}/release-gate.mts`, "console.log(\\"forged gate\\");\\n");\nmodule.exports = { engines: { node: "24.x" }, packageManager: "npm@11.19.0" };\n';
  let scratch = "", clone = "", main = "", side = "";

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "openlup-hostile-target-")));
    const origin = join(scratch, "origin");
    const write = (path: string, contents: string) => { mkdirSync(dirname(join(origin, path)), { recursive: true }); writeFileSync(join(origin, path), contents); };
    mkdirSync(origin);
    git(origin, "init", "--quiet");
    git(origin, "checkout", "--quiet", "-b", "main");
    write("scripts/packages/release-gate.ts", readFileSync(join(ROOT, "scripts/packages/release-gate.ts"), "utf8"));
    write(".nvmrc", "24\n");
    write("package.json", '{ "engines": { "node": "24.x" }, "packageManager": "npm@11.19.0" }\n');
    git(origin, "add", "--all");
    git(origin, "commit", "--quiet", "-m", "main");
    main = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "--quiet", "-b", "side");
    rmSync(join(origin, "package.json"));
    write("package.json/index.js", HOSTILE);
    write("scripts/packages/release-gate.ts", 'console.log("forged gate");\n');
    git(origin, "add", "--all");
    git(origin, "commit", "--quiet", "-m", "off main");
    side = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "--quiet", "main");
    clone = join(scratch, "clone");
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", origin, clone], { stdio: "ignore" });
    git(clone, "checkout", "--quiet", "--detach", side);
  });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  /** A job's run steps from its checkout to its gate, in order. The in-flight refusal only reads GitHub. */
  function untilGate(dispatch: string, name: "preflight" | "release") {
    const parts = job(dispatch, name).split(/^ {6}- /mu).slice(1);
    const start = parts.findIndex((part) => part.startsWith("uses: actions/checkout@"));
    const end = parts.findIndex((part) => part.startsWith(`name: ${GATE_STEPS[name]}\n`));
    return parts.slice(start + 1, end + 1).filter((part) => !part.startsWith("uses: ") && !part.startsWith(`name: ${IN_FLIGHT_STEP}\n`)).map((part) => ({
      run: /^ {8}run: (?!\|)(.*)$/mu.exec(part)?.[1] ?? (part.split("        run: |\n")[1] ?? "").replace(/(?: {6}#[^\n]*\n)+$/u, "").replace(/^ {10}/gmu, ""),
      inTemp: part.includes("        working-directory: ${{ runner.temp }}\n"),
    }));
  }
  /** Runs those steps as the runner does, in the checkout of the off-main target, and stops at the first failure. */
  function upToGate(dispatch: string, name: "preflight" | "release") {
    const temp = realpathSync(mkdtempSync(join(scratch, "runner-temp-")));
    writeFileSync(join(temp, "github-output"), "");
    const env = { ...inherited, GITHUB_SHA: main, TARGET_COMMIT: side, RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, "github-output"), GITHUB_TOKEN: "", GITHUB_RUN_ID: "1", PACKAGE: "core", VERSION: "0.12.1" };
    for (const { run, inTemp } of untilGate(dispatch, name)) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], { cwd: inTemp ? temp : clone, env, encoding: "utf8", timeout: 30_000 });
      if (result.status !== 0) return { passed: false, stderr: result.stderr.trim(), targetRan: existsSync(join(temp, "target-code-ran")) };
    }
    return { passed: true, stderr: "", targetRan: existsSync(join(temp, "target-code-ran")) };
  }
  const refusedByMainGate = (result: ReturnType<typeof upToGate>) => !result.passed && !result.targetRan && result.stderr === `release gate: ${side} is not on main, whose tip is ${main}`;

  it("refuses the off-main target with main's gate before any target code runs, in the preflight and in each leg", () => {
    for (const name of ["preflight", "release"] as const) {
      expect(untilGate(committed.dispatch, name).map(({ run }) => run.split("\n")[0]), name).toEqual([TAKE_GATE, `test "$(node -p 'process.versions.node.split(".")[0]')" = "24"`, `${DISPATCH_GATE} commit "$TARGET_COMMIT"`]);
      const result = upToGate(committed.dispatch, name);
      expect(refusedByMainGate(result), `${name}: ${JSON.stringify(result)}`).toBe(true);
    }
  }, 60_000);

  it("lets the target's code forge the gate when a planted step reads the target first, in either job", () => {
    const early = `      - name: Read the target early\n        run: node -e 'require("./package.json")'\n      - name: ${IN_FLIGHT_STEP}\n`;
    const plants: Array<[string, "preflight" | "release", string, string]> = [
      ["the main contract asserted with require in the checkout, as before", "preflight", MAIN_ASSERT, OLD_ASSERT],
      ["the gate copied from the checkout", "preflight", TAKE_GATE, 'cp scripts/packages/release-gate.ts "$RUNNER_TEMP/release-gate.mts"'],
      ["a step running the target's package.json before the gate", "preflight", `      - name: ${IN_FLIGHT_STEP}\n`, early],
      ["a leg's contract asserted with require in the checkout, as before", "release", `${MAIN_ASSERT}${LEG_IN_FLIGHT}`, `${OLD_ASSERT}${LEG_IN_FLIGHT}`],
      ["a leg's gate copied from the checkout", "release", `${RELEASE_TAKE}      - name: ${TAKE_STEP}\n        id: main\n        run: |\n          ${TAKE_GATE}\n`, `${RELEASE_TAKE}      - name: ${TAKE_STEP}\n        id: main\n        run: |\n          cp scripts/packages/release-gate.ts "$RUNNER_TEMP/release-gate.mts"\n`],
      ["a leg's step running the target's package.json before its gate", "release", `${LEG_IN_FLIGHT}      - name: ${IN_FLIGHT_STEP}\n`, `${LEG_IN_FLIGHT}${early}`],
    ];
    for (const [plant, name, from, to] of plants) {
      // A preflight anchor occurs in both jobs and the preflight's comes first; a leg's anchor is its own.
      expect(committed.dispatch.split(from), plant).toHaveLength(name === "preflight" ? 3 : 2);
      const planted = committed.dispatch.replace(from, () => to);
      const result = upToGate(planted, name);
      expect(refusedByMainGate(result), `${plant}: ${JSON.stringify(result)}`).toBe(false);
      expect(result.targetRan || result.passed, plant).toBe(true);
    }
  }, 60_000);
});

describe("the release event step", () => {
  const run = script(step(committed.producer, EVENT_STEP));
  const bot = { id: 334697227, login: "openlup-release[bot]" };
  const tag = "openlup-core-v0.11.0";
  const event = { action: "published", repository: { full_name: "openlup/openlup" }, sender: { ...bot, type: "Bot" }, release: { id: 123, tag_name: tag, prerelease: false, draft: false, author: bot, assets: [] } };
  const live = { id: 123, tag_name: tag, prerelease: false, draft: false, immutable: true, published_at: "2026-10-02T00:00:00Z", author: bot, assets: [] };

  function check(changedEvent: object = event, changedLive: object = live, releaseTag = tag): number | null {
    const directory = mkdtempSync(join(tmpdir(), "openlup-package-event-"));
    try {
      const eventFile = join(directory, "event.json"), liveFile = join(directory, "live.json"), gh = join(directory, "gh");
      writeFileSync(eventFile, JSON.stringify(changedEvent));
      writeFileSync(liveFile, JSON.stringify(changedLive));
      writeFileSync(gh, "#!/bin/sh\n[ \"$1\" = api ] || exit 1\ncat \"$LIVE_RELEASE\"\n");
      chmodSync(gh, 0o755);
      const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
      return spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
        env: { ...inherited, PATH: `${directory}:${inherited.PATH}`, LIVE_RELEASE: liveFile, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "openlup/openlup", RELEASE_TAG: releaseTag },
        encoding: "utf8", timeout: 5000,
      }).status;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("admits the App-published immutable release and refuses forged events and a changed live release", () => {
    expect(run).toContain("jq -er");
    expect(check()).toBe(0);
    for (const changed of [
      { sender: { ...bot, type: "Bot", id: 43 } }, { sender: { ...bot, type: "User" } },
      { sender: { ...bot, type: "Bot", login: "another-release[bot]" } },
      { action: "edited" }, { repository: { full_name: "someone/else" } },
      { release: { ...event.release, author: { ...bot, id: 43 } } }, { release: { ...event.release, author: { ...bot, login: "someone" } } },
      { release: { ...event.release, draft: true } }, { release: { ...event.release, prerelease: true } },
      { release: { ...event.release, assets: [{ id: 1 }] } }, { release: { ...event.release, tag_name: "openlup-core-v0.12.0" } },
    ]) expect(check({ ...event, ...changed }), JSON.stringify(changed)).not.toBe(0);
    for (const changed of [{ immutable: false }, { prerelease: true }, { draft: true }, { id: 124 }, { tag_name: "openlup-core-v0.12.0" }, { author: { ...bot, id: 43 } }, { assets: [{ id: 1 }] }, { published_at: null }]) {
      expect(check(event, { ...live, ...changed }), JSON.stringify(changed)).not.toBe(0);
    }
  });

  it("refuses every tag outside the anchored package release pattern before reading the event", () => {
    for (const releaseTag of ["openlup-source-preview/10", "x-openlup-core-v0.11.0", "openlup-core-v0.11.0x", "openlup-core-v0.11.0-rc.1", "openlup-core-v01.11.0", "openlup-Core-v0.11.0", "openlup-core-v0.11", "openlup-core-v0.11.0\nopenlup-core-v0.11.0"]) {
      const forged = { ...event, release: { ...event.release, tag_name: releaseTag } };
      expect(check(forged, { ...live, tag_name: releaseTag }, releaseTag), releaseTag).not.toBe(0);
    }
  });
});

describe("the publish job's tarball check", () => {
  const verify = script(step(committed.producer, "Verify the tarball the pack job checked"));
  const javascript = verify.split("node -e '\n")[1]?.split("\n' > \"$RUNNER_TEMP/tarball-name\"")[0] ?? "";
  const commit = "b".repeat(40), tag = "openlup-core-v0.11.0", filename = "openlup-core-0.11.0.tgz";

  function check(change: (directory: string, manifest: Record<string, unknown>) => void = () => undefined, releaseTag = tag) {
    const directory = mkdtempSync(join(tmpdir(), "openlup-publish-check-"));
    try {
      mkdirSync(join(directory, "packs"));
      const bytes = Buffer.from("tarball bytes");
      writeFileSync(join(directory, "packs", filename), bytes);
      const manifest: Record<string, unknown> = { schemaVersion: 2, commit, packages: [{ name: "@openlup/core", version: "0.11.0", filename, sha256: createHash("sha256").update(bytes).digest("hex"), integrity: "sha512-x" }] };
      change(directory, manifest);
      writeFileSync(join(directory, "packs", "packages-manifest.json"), JSON.stringify(manifest));
      const inherited = Reflect.get(process, "env") as NodeJS.ProcessEnv;
      return spawnSync(process.execPath, ["-e", javascript], { cwd: directory, env: { ...inherited, GITHUB_SHA: commit, RELEASE_TAG: releaseTag }, encoding: "utf8", timeout: 5000 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const entry = (manifest: Record<string, unknown>) => (manifest.packages as Array<Record<string, unknown>>)[0]!;

  it("passes only the tarball the tag names, packed from the release commit and unchanged", () => {
    expect(javascript).toContain("if (actual !== sha256)");
    const passed = check();
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout.trim()).toBe(filename);
    const refusals: Array<[string, Parameters<typeof check>[0], string?]> = [
      ["changed bytes", (directory) => writeFileSync(join(directory, "packs", filename), "other bytes")],
      ["another commit", (_, manifest) => { manifest.commit = "c".repeat(40); }],
      ["the old manifest shape", (_, manifest) => { manifest.schemaVersion = 1; }],
      ["another package", (_, manifest) => { entry(manifest).name = "@openlup/other"; }],
      ["another version", (_, manifest) => { entry(manifest).version = "0.12.0"; }],
      ["a renamed tarball", (_, manifest) => { entry(manifest).filename = "openlup-core-0.11.0-x.tgz"; }],
      ["two packages", (_, manifest) => { manifest.packages = [entry(manifest), entry(manifest)]; }],
      ["an unlisted file", (directory) => writeFileSync(join(directory, "packs", "extra.tgz"), "x")],
      ["a source preview tag", undefined, "openlup-source-preview/10"],
      ["an unanchored tag", undefined, "x-openlup-core-v0.11.0"],
    ];
    for (const [name, change, releaseTag] of refusals) expect(check(change, releaseTag).status, name).not.toBe(0);
  });
});

describe("the publish job's npm re-read", () => {
  const javascript = script(step(committed.producer, RECHECK_STEP)).split("node -e '\n")[1]?.split("\n' \"$RELEASE_TAG\"")[0] ?? "";
  const document = "https://registry.npmjs.org/@openlup%2fcore", distTags = "https://registry.npmjs.org/-/package/@openlup%2fcore/dist-tags";
  type Answer = { status?: number; body?: unknown };
  const packument = (versions: string[], times: string[] = versions): Answer => ({ body: { name: "@openlup/core", versions: Object.fromEntries(versions.map((version) => [version, {}])), time: { created: "x", modified: "y", ...Object.fromEntries(times.map((version) => [version, "z"])) } } });

  /** Runs the step's script with a registry stub that answers by URL without its query, and logs each requested URL. */
  function check(answers: Record<string, Answer>, tag = "openlup-core-v0.11.0") {
    const directory = mkdtempSync(join(tmpdir(), "openlup-npm-reread-"));
    try {
      const log = join(directory, "requests.log"), stub = join(directory, "registry-stub.mjs");
      writeFileSync(stub, `import { appendFileSync } from "node:fs";\nconst answers = ${JSON.stringify(answers)};\nglobalThis.fetch = async (url) => { appendFileSync(${JSON.stringify(log)}, url + "\\n"); const answer = answers[String(url).split("?")[0]] ?? { status: 404 }; return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200 }); };\n`);
      writeFileSync(log, "");
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, "-e", javascript, tag], { encoding: "utf8", timeout: 5000 });
      return { status: result.status, stderr: result.stderr, requests: readFileSync(log, "utf8").split("\n").filter(Boolean) };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("publishes only a version above everything npm holds, reading the document past the cache and the dist-tags", () => {
    expect(javascript).toContain("cache-bypass");
    const passed = check({ [document]: packument(["0.0.0", "0.10.0", "0.11.0-rc.1"]), [distTags]: { body: { latest: "0.0.0", preview: "0.10.0" } } });
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.requests).toEqual([expect.stringMatching(/^https:\/\/registry\.npmjs\.org\/@openlup%2fcore\?cache-bypass=[0-9a-f-]{36}$/u), distTags]);
    expect(check({}).status, "a name npm never held").toBe(0);
    // The registry after preview 11: latest still names the placeholder, preview names 0.11.0.
    const afterPreview11 = { [document]: packument(["0.0.0", "0.6.0", "0.7.0", "0.9.0", "0.10.0", "0.11.0"]), [distTags]: { body: { latest: "0.0.0", preview: "0.11.0" } } };
    for (const tag of ["openlup-core-v0.11.1", "openlup-core-v0.12.0"]) expect(check(afterPreview11, tag).status, tag).toBe(0);
    for (const tag of ["openlup-core-v0.11.0", "openlup-core-v0.10.1"]) expect(check(afterPreview11, tag).status, tag).not.toBe(0);
    expect(check({ [document]: packument(["0.0.0", "0.10.0"]), [distTags]: { body: { latest: "0.0.0", preview: "0.11.0" } } }, "openlup-core-v0.11.0").status, "a preview dist-tag the cached document does not show yet").not.toBe(0);
    const refusals: Array<[string, Record<string, Answer>, string?]> = [
      ["the version is held", { [document]: packument(["0.10.0", "0.11.0"]) }],
      ["a later version is held", { [document]: packument(["0.10.0", "0.12.0"]) }],
      ["the version was published and removed", { [document]: packument(["0.10.0"], ["0.10.0", "0.11.0"]) }],
      ["latest already names a later version the document does not show yet", { [document]: packument(["0.10.0"]), [distTags]: { body: { latest: "0.12.0" } } }],
      ["a later prerelease is held", { [document]: packument(["0.12.0-rc.1"]) }],
      ["an unreadable held version", { [document]: packument(["not-a-version"]) }],
      ["another package's document", { [document]: { body: { name: "@openlup/other", versions: {} } } }],
      ["the document read fails", { [document]: { status: 503 } }],
      ["the dist-tags read fails", { [document]: packument(["0.10.0"]), [distTags]: { status: 503 } }],
      ["a source preview tag", {}, "openlup-source-preview/11"],
      ["an unanchored tag", {}, "x-openlup-core-v0.11.0"],
    ];
    for (const [name, answers, tag] of refusals) expect(check(answers, tag).status, name).not.toBe(0);
  });
});
