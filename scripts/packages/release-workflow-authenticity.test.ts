// Seeded falsifiers for the package release workflows. Every release control is a predicate over
// the committed workflow text, and each has at least one planted defect that must turn it red.
// The event identity, tag pattern and tarball checks also run as the real step scripts.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Workflows = { dispatch: string; producer: string };
const committed: Workflows = {
  dispatch: readFileSync(join(ROOT, ".github/workflows/publish-package.yml"), "utf8"),
  producer: readFileSync(join(ROOT, ".github/workflows/publish-packages.yml"), "utf8"),
};

const job = (source: string, name: string) => source.split(`\n  ${name}:\n`)[1]?.split(/^ {2}[a-z][a-z-]*:\n/mu)[0] ?? "";
const step = (source: string, name: string) => source.split(`      - name: ${name}\n`)[1]?.split(/^ {6}- /mu)[0] ?? "";
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
const CONTEXTS = "for context in dco typecheck install-proof test self-check gitleaks; do";
const EVENT_STEP = "Require the release App event and the live immutable release";
const APP_TOKEN = "GH_TOKEN: ${{ steps.release-identity.outputs.token }}";

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
  "commit on main with the six contexts passed": ({ dispatch, producer }) => [
    [job(dispatch, "preflight"), "TARGET_COMMIT"], [job(dispatch, "release"), "TARGET_COMMIT"], [job(producer, "pack"), "GITHUB_SHA"],
  ].every(([text, commit]) => text!.includes(`git merge-base --is-ancestor "$${commit}" FETCH_HEAD`) && text!.includes(CONTEXTS) && text!.includes(`if [ "$verdict" != "passed" ]; then echo "::error::$context has not passed at $${commit}"; exit 1; fi`)),
  "refusing checks before every write": ({ dispatch, producer }) => inOrder(job(dispatch, "preflight"), ["Validate dispatch coordinates before checkout", "actions/checkout@", "git merge-base --is-ancestor", CONTEXTS, "npm ci --ignore-scripts", "package-release.ts preflight", "npm run packages:check -- --out", "sha256sum --check --strict", "gitleaks dir"])
    && inOrder(job(dispatch, "release"), ["Validate dispatch coordinates before checkout", "git merge-base --is-ancestor", CONTEXTS, "package-release.ts prepare", "secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY", "immutable-releases", "/git/tags", "/git/refs", '--method POST "repos/$GITHUB_REPOSITORY/releases"', "package-release.ts check-draft", "--method PATCH"])
    && inOrder(job(producer, "pack"), [EVENT_STEP, "actions/checkout@", "gh release verify", "git merge-base --is-ancestor", CONTEXTS, "npm ci --ignore-scripts", "package-release.ts registry", "npm run packages:check -- --out packs --release-tag", "packages.length !== 1", "sha256sum --check --strict", "gitleaks dir", "actions/upload-artifact@"])
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
  "App credential only where the release writes": ({ dispatch, producer }) => !job(dispatch, "preflight").includes("OPENLUP_RELEASE_APP") && !producer.includes("OPENLUP_RELEASE_APP")
    && ["Create the exact annotated tag with the release identity", "Create the draft release", "Publish the immutable release with the release identity"].every((name) => step(dispatch, name).includes(APP_TOKEN))
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
  { control: "commit on main with the six contexts passed", plant: "no main ancestry at publication", in: "producer", from: 'git merge-base --is-ancestor "$GITHUB_SHA" FETCH_HEAD', to: "true" },
  { control: "commit on main with the six contexts passed", plant: "a required context dropped", in: "dispatch", from: "for context in dco typecheck install-proof test self-check gitleaks; do", to: "for context in dco typecheck test self-check gitleaks; do" },
  { control: "commit on main with the six contexts passed", plant: "a failed context only warns", in: "producer", from: 'echo "::error::$context has not passed at $GITHUB_SHA"; exit 1; fi', to: 'echo "::warning::$context has not passed at $GITHUB_SHA"; fi' },
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
  { control: "App credential only where the release writes", plant: "App key in the unprivileged preflight", in: "dispatch", from: "      RELEASE_NOTES: ${{ inputs.notes }}\n    steps:\n      - name: Validate dispatch coordinates before checkout\n        run: |\n          [[ \"$PACKAGE\"", to: "      RELEASE_NOTES: ${{ inputs.notes }}\n      KEY: ${{ secrets.OPENLUP_RELEASE_APP_PRIVATE_KEY }}\n    steps:\n      - name: Validate dispatch coordinates before checkout\n        run: |\n          [[ \"$PACKAGE\"" },
  { control: "App credential only where the release writes", plant: "tag written with the default token", in: "dispatch", from: `          ${APP_TOKEN}\n        run: |\n          tag="openlup-$PACKAGE-v$VERSION"\n          message=`, to: "          GH_TOKEN: ${{ github.token }}\n        run: |\n          tag=\"openlup-$PACKAGE-v$VERSION\"\n          message=" },
  { control: "App credential only where the release writes", plant: "write permission on the default token", in: "dispatch", from: "    permissions:\n      contents: read\n      checks: read\n    env:", to: "    permissions:\n      contents: write\n      checks: read\n    env:" },
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
