// Governing document: docs/platform/DOCUMENTATION.md, "Reader guide contract".
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertExpectation, candidateNpm, extractTutorial, main, readCandidate, runTutorial } from "./guide-tutorial.ts";

const temporary: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "guide-tutorial-test-"));
  temporary.push(path); return path;
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const page = (command: string, expected = "") => `\`\`\`sh tutorial\n${command}\n\`\`\`\n${expected ? `\`\`\`text tutorial-expect\n${expected}\n\`\`\`\n` : ""}`;
function candidateDirectory(): string {
  const path = directory();
  const packages = ["core", "outbox"].map(name => {
    const bytes = Buffer.from(`fake ${name} tarball`), filename = `${name}.tgz`;
    writeFileSync(join(path, filename), bytes);
    return { name: `@openlup/${name}`, version: "0.99.0", filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  });
  writeFileSync(join(path, "packages-manifest.json"), JSON.stringify({ schemaVersion: 2, commit: "a".repeat(40), packages }));
  return path;
}
function fakeNpm(): NodeJS.ProcessEnv {
  const bin = directory();
  writeFileSync(join(bin, "npm"), `#!/bin/bash
if [ "$1" = view ]; then printf 'published-version\\n'; else printf '%s\\n' "$@" > npm-arguments; fi
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

describe("tutorial fences", () => {
  it("extracts commands and expectations in order, ignoring other fences", () => {
    const source = "```ts\nconst a = 1;\n```\n" + page("echo first", "first\n\nsecond") + "~~~~sh tutorial\necho third\n~~~\n~~~~\n";
    expect(extractTutorial(source)).toEqual([
      { command: "echo first", expected: ["first", "second"] },
      { command: "echo third\n~~~", expected: [] },
    ]);
  });
  it.each([
    ["hello", "no sh tutorial step"],
    ["```text tutorial-expect\na\n```", "no preceding step"],
    ["```sh tutorial\necho yes", "unclosed fence"],
    [page("true") + "```text\nnot closed", "unclosed fence"],
  ])("refuses malformed page %s", (source, message) => { expect(() => extractTutorial(source)).toThrow(message); });
  it("matches every nonempty expectation in order", () => {
    expect(() => assertExpectation("prefix first\nextra\nsecond suffix", ["first", "second"])).not.toThrow();
    expect(() => assertExpectation("second\nfirst", ["first", "second"])).toThrow("out of order");
    expect(() => assertExpectation("first", ["absent"])).toThrow("absent");
    expect(() => assertExpectation("once", ["once", "once"])).toThrow();
  });
  it("the real page has steps, an expectation, and no checkout paths", () => {
    const steps = extractTutorial(readFileSync(new URL("../../packages/core/docs/guide/start/tutorial.md", import.meta.url), "utf8"));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some(step => step.expected.length)).toBe(true);
    for (const step of steps) expect(step.command).not.toMatch(/(?:^|[\s"'`])(?:\.\.\/|(?:\.\/)?(?:scripts|packages|server|src|tests|docs|\.context)\/)|\/Users\/|\/home\//mu);
  });
});

describe("the only candidate substitution", () => {
  it("substitutes the exact view and install specs, retaining every other argument", () => {
    const path = candidateDirectory(), candidate = readCandidate(path);
    expect(candidateNpm(["view", "@openlup/core", "version"], candidate)).toEqual({ stdout: "0.99.0\n" });
    expect(candidateNpm(["install", "--save-exact", "@openlup/core@0.99.0", "@openlup/outbox@0.99.0", "pg"], candidate)).toEqual({ args: ["install", "--save-exact", join(path, "core.tgz"), join(path, "outbox.tgz"), "pg"] });
    expect(candidateNpm(["view", "pg", "version"], candidate)).toEqual({ args: ["view", "pg", "version"] });
    expect(candidateNpm(["init", "-y"], candidate)).toEqual({ args: ["init", "-y"] });
    for (const spec of ["@openlup/core", "@openlup/core@latest", "@openlup/absent@0.99.0"]) expect(() => candidateNpm(["install", spec], candidate)).toThrow("no exact candidate");
  });
  it("refuses changed tarballs", () => {
    const path = candidateDirectory(); writeFileSync(join(path, "core.tgz"), "changed");
    expect(() => readCandidate(path)).toThrow("digest mismatch");
  });
  it("uses the shim without rewriting the page or supplying application files", async () => {
    const packages = candidateDirectory(), work = join(directory(), "app");
    const source = page('v="$(npm view @openlup/core version)"\nnpm install --save-exact "@openlup/core@$v" "@openlup/outbox@$v" pg\ncat > application.mjs <<\'APP\'\nconsole.log("literal @openlup/core@unchanged");\nAPP');
    await runTutorial({ steps: extractTutorial(source), databaseUrl: "unused", packages, work, env: fakeNpm() });
    expect(readFileSync(join(work, "npm-arguments"), "utf8")).toBe(`install\n--save-exact\n${join(packages, "core.tgz")}\n${join(packages, "outbox.tgz")}\npg\n`);
    expect(readFileSync(join(work, "application.mjs"), "utf8")).toBe('console.log("literal @openlup/core@unchanged");\n');
  });
  it("registry mode leaves npm view and install untouched", async () => {
    const work = directory();
    await runTutorial({ steps: extractTutorial(page('v="$(npm view @openlup/core version)"\nnpm install --save-exact "@openlup/core@$v"')), databaseUrl: "unused", work, env: fakeNpm() });
    expect(readFileSync(join(work, "npm-arguments"), "utf8")).toBe("install\n--save-exact\n@openlup/core@published-version\n");
  });
});

describe("reader shell semantics and diagnostics", () => {
  it("retains cwd, shell variables, files, functions and the connection variable", async () => {
    const steps = extractTutorial(page('mkdir app\ncd app\nvalue=retained\nshow() { cat result; }\nprintf "%s" "$OPENLUP_TUTORIAL_DATABASE_URL" > result') + page('printf "%s\\n" "$value"\nshow', "retained\nunused"));
    const output = await runTutorial({ steps, databaseUrl: "unused" });
    expect(output[1]?.stdout).toBe("retained\n[database URL]");
  });
  it("reports the failed step, command and output tail, and does not run later steps", async () => {
    const work = directory();
    const steps = extractTutorial(page("echo first") + page('echo before-failure\nprintf "%s\\n" "$OPENLUP_TUTORIAL_DATABASE_URL" >&2\nfalse\necho unreachable') + page("touch should-not-exist"));
    await expect(runTutorial({ steps, databaseUrl: "postgresql://secret@host/db", work })).rejects.toThrow(/step 2 failed[\s\S]*Command:[\s\S]*false[\s\S]*Output tail:\nbefore-failure\n\[database URL\]/u);
    expect(() => readFileSync(join(work, "should-not-exist"))).toThrow();
  });
  it("fails pipelines and unset variables", async () => {
    for (const command of ["false | cat", 'echo "$UNDEFINED_TUTORIAL_TEST_VARIABLE"']) await expect(runTutorial({ steps: extractTutorial(page(command)), databaseUrl: "unused" })).rejects.toThrow("step 1 failed");
  });
  it("stops before the next step on a missing or stderr-only expectation", async () => {
    const work = directory();
    await expect(runTutorial({ steps: extractTutorial(page("echo only-stderr >&2", "only-stderr") + page("touch later")), databaseUrl: "unused", work })).rejects.toThrow("expected output missing");
    expect(() => readFileSync(join(work, "later"))).toThrow();
  });
  it.each(["step", "total"])("bounds the %s runtime", async kind => {
    await expect(runTutorial({ steps: extractTutorial(page("sleep 5")), databaseUrl: "unused", stepTimeoutMs: kind === "step" ? 30 : 5000, totalTimeoutMs: kind === "total" ? 30 : 5000 })).rejects.toThrow(`${kind} time limit exceeded`);
  });
  it("requires a fresh work directory", async () => {
    const work = directory(); writeFileSync(join(work, "existing"), "keep");
    await expect(runTutorial({ steps: extractTutorial(page("true")), databaseUrl: "unused", work })).rejects.toThrow("empty directory");
    expect(readFileSync(join(work, "existing"), "utf8")).toBe("keep");
  });
  it("writes a short summary for success and failure and returns nonzero on failure", async () => {
    const path = directory(), file = join(path, "page.md"), summary = join(path, "summary.md");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(file, page("true"));
    expect(await main(["--page", file, "--registry", "--database-url", "unused"])).toBe(0);
    writeFileSync(file, page("false"));
    expect(await main(["--page", file, "--registry", "--database-url", "unused"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("step 1 failed"));
    expect(readFileSync(summary, "utf8")).toMatch(/PASS[\s\S]*registry[\s\S]*FAIL/u);
    expect(await main(["--page", file, "--registry", "--packages", path, "--database-url", "unused"])).toBe(1);
  });
});
