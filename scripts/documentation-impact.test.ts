import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDocumentationNavigation, documentationSection, markdownHeadings, normalizeDocumentation,
  readDocumentationState, resolveDocumentationOwner, type DocumentationSurface,
} from "./documentation-routing.ts";
import { checkDocumentationImpact, renderNoImpactComment, resolveDocumentationBase } from "./documentation-impact.ts";
import { readDocumentationIndex, readDocumentationTree } from "./documentation-git.ts";

const fetchMock = vi.hoisted(() => ({ source: "", calls: [] as { args: string[]; options: ExecFileSyncOptions }[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (command: string, args: string[], options: ExecFileSyncOptions) => {
    if (command === "git" && args.includes("fetch") && args.includes("https://github.com/openlup/openlup.git")) {
      fetchMock.calls.push({ args, options });
      if (!fetchMock.source) throw new Error("simulated public base fetch failure");
      // The test transport alone admits the synthetic file repository; production admits HTTPS only.
      return actual.execFileSync(command, ["-c", "protocol.file.allow=always", ...args.map((arg) => arg === "https://github.com/openlup/openlup.git" ? `file://${fetchMock.source}` : arg)], options);
    }
    return actual.execFileSync(command, args, options);
  } };
});

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); fetchMock.source = ""; fetchMock.calls.length = 0; });
function temporary(): string { const path = mkdtempSync(join(tmpdir(), "documentation-guard-")); directories.push(path); return path; }
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(root: string, path: string, text: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
function commit(root: string): string {
  git(root, "add", "."); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "-qm", "fixture"); return git(root, "rev-parse", "HEAD");
}
const OWNER = "docs/owner.md";
const SOURCE = "src/domains/demo/main.ts";
const ownerText = "# Owner\n\n## Canonical\n\nThe contract preserves replay safety.\n\nUpdated: 2026-09-26\n\n## Other\n\nSeparate guidance.\n";
function fixture(): { root: string; base: string; surfaces: DocumentationSurface[] } {
  const root = temporary(); git(root, "init", "-q");
  const surfaces: DocumentationSurface[] = [
    { id: "repository", when: "Repository contracts and configuration", paths: ["*", "config/**", "src/lib/**"], doc: OWNER, anchor: "#canonical" },
    { id: "domain-demo", when: "The demo domain contract", paths: ["src/domains/demo/**"], doc: OWNER, anchor: "#canonical" },
    { id: "documentation", when: "Public documentation authoring", paths: ["docs/**"], doc: OWNER, anchor: "" },
  ];
  write(root, "README.md", `[Owner](${OWNER})\n`); write(root, OWNER, ownerText);
  write(root, "src/lib/coreDomains.ts", 'export const CORE_DOMAINS = Object.freeze(["demo"] as const);\n');
  write(root, SOURCE, "export const value = 1;\n"); write(root, "src/domains/demo/other.ts", "export const other = 1;\n");
  write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
  const base = commit(root); git(root, "update-ref", "refs/remotes/origin/main", base);
  return { root, base, surfaces };
}
function impact(root: string, base: string) { return checkDocumentationImpact(root, readDocumentationState(root), base); }
function sectionUpdate(root: string): void { write(root, OWNER, ownerText.replace("preserves replay safety", "preserves replay safety and refuses reordered events")); }
function review(root: string, base: string): void {
  const obligation = impact(root, base).obligations.find((row) => row.unit === "domain-demo")!;
  const comment = renderNoImpactComment(obligation, "This internal implementation change preserves the documented replay contract.");
  write(root, OWNER, ownerText.replace("## Other", `${comment}\n\n## Other`));
}

describe("public documentation routing", () => {
  it("resolves specific workflow sections and treats reachability as a separate gate", () => {
    const { root, surfaces } = fixture();
    surfaces.push({ id: "workflow", when: "The specific workflow", paths: [SOURCE], doc: OWNER, anchor: "#other" });
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const state = readDocumentationState(root);
    expect(resolveDocumentationOwner(state, SOURCE).unit).toBe("workflow");
    expect(state.ownersByPath.get(SOURCE)?.anchor).toBe("#other");
    expect(() => assertDocumentationNavigation(state)).not.toThrow();
    write(root, "README.md", "# No owner link\n");
    expect(() => assertDocumentationNavigation(readDocumentationState(root))).toThrow(/unreachable owner/);
  });
  it.each(["new/unowned.ts", ".hidden/unowned.ts"])("refuses untracked unknown path %s", (path) => {
    const { root } = fixture(); write(root, path, "export const unowned = true;\n");
    expect(() => readDocumentationState(root)).toThrow(/unknown path/);
  });
  it("refuses unregistered domains, dead selectors, owner anchors and conflicting owners", () => {
    const { root, surfaces } = fixture();
    write(root, "src/domains/unregistered/value.ts", "export {};\n");
    expect(() => readDocumentationState(root)).toThrow(/unregistered domain/);
    rmSync(join(root, "src/domains/unregistered"), { recursive: true });
    for (const change of [
      { ...surfaces[1]!, paths: ["src/absent/**"] },
      { ...surfaces[1]!, anchor: "#absent" },
      { ...surfaces[1]!, id: "duplicate-owner", anchor: "#other" },
    ]) {
      write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces: [...surfaces, change] }));
      expect(() => readDocumentationState(root)).toThrow(/malformed or duplicate|dead selector|missing owner anchor|conflicting equally/);
    }
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces: surfaces.map((row) => ({ ...row, doc: "docs/missing.md" })) }));
    expect(() => readDocumentationState(root)).toThrow(/missing owner/);
  });
  it("refuses materialized and dangling symlink objects", () => {
    const { root } = fixture();
    for (const target of [join(root, SOURCE), join(root, "absent.ts")]) {
      symlinkSync(target, join(root, "src/domains/demo/link.ts"));
      expect(() => readDocumentationState(root)).toThrow(/symlink objects/);
      rmSync(join(root, "src/domains/demo/link.ts"));
    }
  });
  it("finds headings outside fenced examples and bounds each canonical section", () => {
    const text = "# Page\n```md\n## Example\n```\n## Real\nbody\n### Child\nchild\n## Real\nsecond\n";
    expect(markdownHeadings(text).map(({ anchor }) => anchor)).toEqual(["#page", "#real", "#child", "#real-1"]);
    expect(documentationSection(text, "#real")).toContain("child");
    expect(documentationSection(text, "#real")).not.toContain("second");
    const withUnicodeComment = text.replace("## Real", "<!-- 🙂🙂🙂🙂 -->\n\n## Real");
    expect(documentationSection(withUnicodeComment, "#real")).toBe(documentationSection(text, "#real"));
  });
});

describe("attributable source and owner impact", () => {
  it("compares actual commit and blob objects despite local replacement refs", () => {
    const { root, base } = fixture(); const originalBlob = git(root, "rev-parse", `${base}:${SOURCE}`);
    write(root, SOURCE, "export const value = 2;\n"); const head = commit(root); const changedBlob = git(root, "rev-parse", `HEAD:${SOURCE}`);
    git(root, "replace", base, head);
    expect(impact(root, base).failures).toHaveLength(1);
    expect(readDocumentationTree(root, base).get(SOURCE)?.contents.toString()).toContain("value = 1");
    git(root, "replace", "-d", base); git(root, "replace", originalBlob, changedBlob);
    expect(readDocumentationTree(root, base).get(SOURCE)?.contents.toString()).toContain("value = 1");
    expect(impact(root, base).failures).toHaveLength(1);
  });
  it("binds inventory, index and ancestry to the selected checkout despite ambient redirects", () => {
    const { root, base } = fixture(); const decoy = fixture().root;
    write(decoy, SOURCE, "export const value = 7;\n"); commit(decoy);
    write(root, "src/domains/demo/new.ts", "export const added = true;\n");
    vi.stubEnv("GIT_DIR", join(decoy, ".git")); vi.stubEnv("GIT_WORK_TREE", decoy); vi.stubEnv("GIT_INDEX_FILE", join(decoy, ".git/index"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare"); vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    expect(readDocumentationState(root).paths).toContain("src/domains/demo/new.ts");
    expect(readDocumentationIndex(root).get(SOURCE)?.contents.toString()).toContain("value = 1");
    expect(resolveDocumentationBase(root, { env: {} }).head).toBe(base);
    expect(impact(root, base).failures).toHaveLength(1);
  });
  it("accepts a clean base and detects staged, unstaged, untracked, deleted and moved sources", () => {
    const { root, base } = fixture(); expect(impact(root, base).obligations).toHaveLength(0);
    write(root, SOURCE, "export const value = 2;\n"); expect(impact(root, base).failures).toHaveLength(1);
    git(root, "add", SOURCE); expect(impact(root, base).failures).toHaveLength(1);
    write(root, "src/domains/demo/new.ts", "export const added = true;\n");
    expect(impact(root, base).obligations[0]?.changedPaths).toContain("src/domains/demo/new.ts");
    rmSync(join(root, SOURCE));
    git(root, "add", "-u", SOURCE);
    expect(impact(root, base).obligations[0]?.changedPaths).toContain(SOURCE);
    renameSync(join(root, "src/domains/demo/other.ts"), join(root, "src/domains/demo/renamed.ts"));
    expect(impact(root, base).obligations[0]?.changedPaths).toContain("src/domains/demo/other.ts");
    sectionUpdate(root); expect(impact(root, base).failures).toEqual([]);
  });
  it.each([
    (text: string) => text.replace("replay safety.", "replay   safety.\n\n"),
    (text: string) => text.replace("2026-09-26", "2026-09-27"),
    (text: string) => text.replace("Separate guidance.", "An unrelated section changed."),
    (text: string) => text.replace("## Other", "<!-- arbitrary acknowledgement -->\n## Other"),
    (text: string) => text.replace("## Other", "<!-- openlup-generated:start -->\nGenerated new source map.\n<!-- openlup-generated:end -->\n## Other"),
    (text: string) => text.replace("## Other", "Source commit: a new generated revision\nProvenance: regenerated today\n## Other"),
    (text: string) => text.replace("The contract preserves replay safety.", "<!-- openlup-generated:start -->\nThe contract preserves replay safety.\n<!-- openlup-generated:end -->"),
    (text: string) => text.replace("Updated: 2026-09-26", "Audit date: 2026-09-27"),
    (text: string) => text.replace("## Canonical", "<!-- 🙂🙂🙂🙂 -->\n\n## Canonical"),
  ])("does not accept cosmetic, unrelated or generated owner changes", (change) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); write(root, OWNER, change(ownerText));
    expect(impact(root, base).failures).toHaveLength(1);
  });
  it("refuses a staged source proposal concealed by restoring worktree bytes", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); git(root, "add", SOURCE);
    write(root, SOURCE, "export const value = 1;\n");
    expect(() => impact(root, base)).toThrow(/staged source differs/);
    git(root, "add", SOURCE); expect(impact(root, base).obligations).toEqual([]);
  });
  it("allows ordinary branch iteration while refusing a concealed staged revert to its base", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); sectionUpdate(root); commit(root);
    write(root, SOURCE, "export const value = 3;\n");
    expect(impact(root, base).failures).toEqual([]); // Index equals HEAD, not an unseen staged proposal.
    write(root, SOURCE, "export const value = 1;\n"); git(root, "add", SOURCE);
    write(root, SOURCE, "export const value = 2;\n");
    expect(() => impact(root, base)).toThrow(/staged source differs/);
  });
  it.each(["docs/platform/plans/runtime.ts", "docs/history/runtime.js", "docs/archive/forward.sql"])("keeps executable history path %s subject to impact and index checks", (path) => {
    const { root } = fixture(); const contents = (value: number) => path.endsWith(".sql") ? `select ${value};\n` : `export const value = ${value};\n`;
    write(root, path, contents(1));
    if (!path.endsWith(".sql")) write(root, SOURCE, `import {value} from '../../../${path}'; export {value};\n`);
    const base = commit(root); write(root, path, contents(2));
    expect(impact(root, base).failures).toHaveLength(1);
    git(root, "add", path); write(root, path, contents(1));
    expect(() => impact(root, base)).toThrow(/staged source differs/);
  });
  it("accepts one fresh scoped receipt and refuses stale, moved or malformed comments", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); review(root, base);
    expect(impact(root, base).obligations[0]?.status).toBe("no-impact");
    const valid = readFileSync(join(root, OWNER), "utf8");
    write(root, SOURCE, "export const value = 3;\n"); expect(impact(root, base).failures).toHaveLength(1);
    write(root, SOURCE, "export const value = 2;\n");
    const marker = /<!-- openlup-doc-impact.*?-->/u.exec(valid)![0];
    write(root, OWNER, valid.replace(marker, "").replace("Separate guidance.", `Separate guidance.\n${marker}`));
    expect(impact(root, base).failures).toHaveLength(1);
    for (const bad of ['<!-- openlup-doc-impact {"unit":"domain-demo"} -->', "<!-- openlup-doc-impact bad JSON -->", "<!-- openlup-doc-impact unterminated"])
      { write(root, OWNER, ownerText.replace("## Other", `${bad}\n## Other`)); expect(impact(root, base).failures.join("\n")).toMatch(/comment|JSON/); }
  });
  it("binds source modes, the exact base, and unchanged section content", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); review(root, base);
    chmodSync(join(root, SOURCE), 0o755); expect(impact(root, base).failures).toHaveLength(1); chmodSync(join(root, SOURCE), 0o644);
    const oldDigest = impact(root, base).obligations[0]!.digest;
    write(root, OWNER, readFileSync(join(root, OWNER), "utf8").replace("preserves replay safety", "preserves a new contract"));
    expect(impact(root, base).obligations[0]!.digest).not.toBe(oldDigest);
    expect(impact(root, base).obligations[0]?.status).toBe("updated");
    git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "new base");
    const nextBase = git(root, "rev-parse", "HEAD"); write(root, OWNER, ownerText); review(root, base);
    expect(impact(root, nextBase).failures).toHaveLength(1);
  });
  it("does not read a receipt inside fenced, indented or inline code as a review", () => {
    for (const example of ["```text\n```json\nRECEIPT\n```", "    RECEIPT", "`RECEIPT`", "`first line\nRECEIPT\nlast line`"]) {
      const { root } = fixture();
      write(root, OWNER, ownerText.replace("## Other", `${example.replace("RECEIPT", "")}\n## Other`));
      const exampleBase = commit(root);
      write(root, SOURCE, "export const value = 2;\n");
      const comment = renderNoImpactComment(impact(root, exampleBase).obligations[0]!, "The documented replay boundary remains unchanged.");
      write(root, OWNER, ownerText.replace("## Other", `${example.replace("RECEIPT", comment)}\n## Other`));
      expect(impact(root, exampleBase).obligations[0]?.status).toBe("unanswered");
    }
  });
  it("preserves both owners' obligations across a remap without changing source bytes", () => {
    const { root, base, surfaces } = fixture();
    surfaces[1] = { ...surfaces[1]!, anchor: "#other" }; write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const result = impact(root, base);
    expect(result.obligations.filter(({ unit }) => unit === "domain-demo").map(({ anchor }) => anchor).sort()).toEqual(["#canonical", "#other"]);
    write(root, OWNER, ownerText.replace("Separate guidance.", "The demo contract now lives in this section."));
    expect(impact(root, base).failures.join("\n")).toContain("#canonical");
    write(root, OWNER, readFileSync(join(root, OWNER), "utf8").replace("preserves replay safety", "moves its canonical explanation to Other"));
    expect(impact(root, base).failures).toEqual([]);
  });
  it("allows the dormant v1 bootstrap and refuses a v2 downgrade", () => {
    const { root, surfaces } = fixture(); write(root, "config/doc-routing.json", JSON.stringify({ version: 1, surfaces: [{ doc: "docs/absent.md" }] }));
    const base = commit(root); write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces })); sectionUpdate(root);
    expect(impact(root, base).failures).toEqual([]);
    write(root, "config/doc-routing.json", JSON.stringify({ version: 1, surfaces }));
    expect(() => readDocumentationState(root)).toThrow(/version 2/);
  });
  it("does not exempt functional guidance merely because a line starts Updated", () => {
    expect(normalizeDocumentation("Updated: replay must refuse duplicate events")).toContain("replay");
  });
});

function hostedEvent(root: string, base: string, eventName = "push", extra: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const head = git(root, "rev-parse", "HEAD"); const eventPath = join(temporary(), "event.json");
  writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, before: base, after: head, ...extra }));
  return { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: head, PATH: process.env.PATH };
}

describe("strict documentation base attribution", () => {
  it.each(["rewrite", "header", "included-header", "remote-alias"])("refuses effective %s configuration before public fallback transport", (setting) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=1", `file://${root}`, shallow);
    if (setting === "rewrite") git(shallow, "config", `url.file://${root}.insteadOf`, "https://github.com/openlup/openlup.git");
    else if (setting === "header") git(shallow, "config", "http.https://github.com/openlup/.extraHeader", "Authorization: SyntheticDocumentationFixture");
    else if (setting === "remote-alias") git(shallow, "config", "remote.https://github.com/openlup/openlup.git.url", `file://${root}`);
    else {
      const included = join(temporary(), "transport.gitconfig");
      writeFileSync(included, '[http "https://github.com/openlup/"]\n extraHeader = Authorization: SyntheticDocumentationFixture\n');
      git(shallow, "config", "include.path", included);
    }
    fetchMock.source = root;
    expect(() => resolveDocumentationBase(shallow, { env: hostedEvent(shallow, base) })).toThrow(/transport or credential configuration/);
    expect(fetchMock.calls).toHaveLength(0);
  });
  it("uses a local merge base, refuses unknown/nonancestor bases and never silently skips", () => {
    const { root, base } = fixture(); expect(resolveDocumentationBase(root, { env: {} }).base).toBe(base);
    expect(() => resolveDocumentationBase(root, { base: "HEAD", env: {} })).toThrow(/full commit SHA/);
    expect(() => resolveDocumentationBase(root, { base: "f".repeat(40), env: {} })).toThrow();
    git(root, "checkout", "--orphan", "unrelated"); git(root, "rm", "-rf", "."); write(root, "unrelated.txt", "unrelated\n"); const other = commit(root);
    git(root, "checkout", "-q", "--detach", base);
    expect(() => resolveDocumentationBase(root, { base: other, env: {} })).toThrow(/not an ancestor/);
    git(root, "update-ref", "-d", "refs/remotes/origin/main"); expect(() => resolveDocumentationBase(root, { env: {} })).toThrow();
  });
  it("prioritizes valid public hosted events over a caller override and rejects identity drift", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const env = hostedEvent(root, base);
    expect(resolveDocumentationBase(root, { base: "f".repeat(40), env }).provenance).toBe("push");
    for (const patch of [{ GITHUB_REPOSITORY: "foreign/repository" }, { GITHUB_SHA: base }, { GITHUB_EVENT_NAME: "workflow_dispatch" }])
      expect(() => resolveDocumentationBase(root, { env: { ...env, ...patch } })).toThrow(/identity|event/);
    const privateEnv = hostedEvent(root, base, "push", { repository: { full_name: "openlup/openlup", private: true } });
    expect(() => resolveDocumentationBase(root, { env: privateEnv })).toThrow(/public OpenLup/);
  });
  it("validates the actual PR merge parents", () => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); const source = commit(root);
    git(root, "checkout", "-qb", "merge", base); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "-qm", "merge fixture", "topic");
    const env = hostedEvent(root, base, "pull_request", { pull_request: { base: { sha: base }, head: { sha: source }, merge_commit_sha: git(root, "rev-parse", "HEAD") } });
    expect(resolveDocumentationBase(root, { env }).provenance).toBe("pull-request");
    git(root, "checkout", "-q", "--detach", source); env.GITHUB_SHA = source;
    expect(() => resolveDocumentationBase(root, { env })).toThrow(/base\/head merge/);
  });
  it("fetches a missing shallow CI base with no credentials, refs or FETCH_HEAD; failure refuses", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=1", `file://${root}`, shallow);
    expect(() => resolveDocumentationBase(shallow, { base, env: {} })).toThrow();
    const env = hostedEvent(shallow, base); env.DEMONSTRATION_TOKEN = "synthetic";
    expect(() => resolveDocumentationBase(shallow, { env })).toThrow(/simulated public base fetch failure/);
    fetchMock.source = root; expect(resolveDocumentationBase(shallow, { env }).base).toBe(base);
    const call = fetchMock.calls.at(-1)!;
    expect(call.args).toContain("--no-write-fetch-head"); expect(call.args).toContain("credential.helper="); expect(call.args).toContain("core.askPass=");
    for (const flag of ["--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=", "--no-auto-maintenance", "--no-write-commit-graph"])
      expect(call.args).toContain(flag);
    expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe("0"); expect(call.options.env?.DEMONSTRATION_TOKEN).toBeUndefined();
    expect(existsSync(join(shallow, ".git/FETCH_HEAD"))).toBe(false);
  });
});
