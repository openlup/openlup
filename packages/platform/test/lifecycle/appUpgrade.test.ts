import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppUpgradeConflictError,
  applyAppUpgrade,
  planAppUpgrade,
  type AppUpgradeInput,
  type AppVersionSnapshot,
} from "../../src/lifecycle/appUpgrade.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function scratch() {
  const root = await fs.mkdtemp(join(tmpdir(), "openlup-app-upgrade-"));
  temporary.push(root);
  return fs.realpath(root);
}
async function put(root: string, path: string, content: string | Buffer) {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content);
}
async function tree(root: string) {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix = "") {
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(root, path), stat = await fs.lstat(absolute);
      result[path] = stat.isSymbolicLink() ? `link:${await fs.readlink(absolute)}` : stat.isDirectory() ? "directory" : (await fs.readFile(absolute)).toString("hex");
      if (stat.isDirectory()) await visit(absolute, path);
    }
  }
  await visit(root);
  return result;
}
function versions(): { from: AppVersionSnapshot; to: AppVersionSnapshot } {
  return {
    from: { version: "0.1.0", schema: { min: 1, max: 2 }, files: { "generated/entry.ts": "export const revision = 1;\n", "generated/remove.ts": "obsolete\n", "theme.css": "original theme\n" } },
    to: { version: "0.2.0", schema: { min: 1, max: 2 }, files: { "generated/entry.ts": "export const revision = 2;\n", "generated/new.ts": "new file\n", "theme.css": "original theme\n" } },
  };
}
async function fixture(): Promise<AppUpgradeInput> {
  const root = await scratch(), snapshots = versions();
  for (const [path, content] of Object.entries(snapshots.from.files)) await put(root, path, content);
  await put(root, "theme.css", "adopter theme\n");
  await put(root, "src/local-policy.ts", "export const localPolicy = true;\n");
  return { root, ...snapshots, schemaVersion: 1 };
}

describe("application scaffold upgrade", () => {
  it("plans without writes, upgrades only changed managed files and preserves customizations", async () => {
    const input = await fixture(), original = await tree(input.root);
    const plan = await planAppUpgrade(input);
    expect(await tree(input.root)).toEqual(original);
    expect(plan).toEqual({ fromVersion: "0.1.0", toVersion: "0.2.0", schemaVersion: 1, conflicts: [], files: [
      { path: "generated/entry.ts", action: "replace" },
      { path: "generated/new.ts", action: "create" },
      { path: "generated/remove.ts", action: "remove" },
      { path: "theme.css", action: "preserved" },
    ] });
    expect((await applyAppUpgrade(input)).applied).toEqual(["generated/entry.ts", "generated/new.ts", "generated/remove.ts"]);
    expect(await fs.readFile(join(input.root, "generated/entry.ts"), "utf8")).toBe(input.to.files["generated/entry.ts"]);
    expect(await fs.readFile(join(input.root, "generated/new.ts"), "utf8")).toBe(input.to.files["generated/new.ts"]);
    expect(await fs.readFile(join(input.root, "theme.css"), "utf8")).toBe("adopter theme\n");
    expect(await fs.readFile(join(input.root, "src/local-policy.ts"), "utf8")).toBe("export const localPolicy = true;\n");
    await expect(fs.stat(join(input.root, "generated/remove.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    const completed = await tree(input.root);
    expect((await applyAppUpgrade(input)).applied).toEqual([]);
    expect(await tree(input.root)).toEqual(completed);
  });

  it("refuses every divergent touched path before any file or directory mutation", async () => {
    const input = await fixture();
    await put(input.root, "generated/entry.ts", "customized changed file\n");
    await put(input.root, "generated/remove.ts", "customized obsolete file\n");
    await put(input.root, "generated/new.ts", "adopter owns this collision\n");
    input.to.files = { ...input.to.files, "new-parent/new.ts": "must not be created\n" };
    const before = await tree(input.root), plan = await planAppUpgrade(input);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["generated/entry.ts", "generated/new.ts", "generated/remove.ts"]);
    await expect(applyAppUpgrade(input)).rejects.toBeInstanceOf(AppUpgradeConflictError);
    expect(await tree(input.root)).toEqual(before);
  });

  it("preserves unlisted directory-entry spellings when the filesystem resolves managed aliases", async () => {
    const root = await scratch();
    await put(root, "MANAGED.txt", "local preserved bytes");
    await put(root, "PARENT/entry.txt", "nested preserved bytes");
    const input: AppUpgradeInput = {
      root, schemaVersion: 0,
      from: { version: "1", schema: { min: 0, max: 0 }, files: {
        "managed.txt": "local preserved bytes", "parent/entry.txt": "nested preserved bytes",
      } },
      to: { version: "2", schema: { min: 0, max: 0 }, files: {} },
    };
    const conflicts = [];
    // Observe this real filesystem rather than assuming its case semantics.
    for (const [component, path] of [["managed.txt", "managed.txt"], ["parent", "parent/entry.txt"]]) {
      try {
        await fs.lstat(join(root, component));
        conflicts.push({ path, reason: "managed path spelling differs from directory entry" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const before = await tree(root);
    expect((await planAppUpgrade(input)).conflicts).toEqual(conflicts);
    if (conflicts.length) await expect(applyAppUpgrade(input)).rejects.toMatchObject({ name: "AppUpgradeConflictError", conflicts });
    else expect((await applyAppUpgrade(input)).applied).toEqual([]);
    expect(await tree(root)).toEqual(before);

    await put(root, "exact.txt", "exact managed bytes");
    const exact = { ...input, from: { ...input.from, files: { "exact.txt": "exact managed bytes" } } };
    expect((await applyAppUpgrade(exact)).applied).toEqual(["exact.txt"]);
    expect(await tree(root)).toEqual(before);
  });

  it("rejects initially absent directory-prefix aliases before any write", async () => {
    for (const files of [
      { "A/one.txt": "one", "a/two.txt": "two" },
      { "shared/caf\u00e9/one.txt": "one", "shared/cafe\u0301/two.txt": "two" },
      { "\u03c3/one.txt": "one", "\u03c2/two.txt": "two" },
    ] as Record<string, string>[]) {
      const root = await scratch();
      const input: AppUpgradeInput = {
        root, schemaVersion: 0,
        from: { version: "1", schema: { min: 0, max: 0 }, files: {} },
        to: { version: "2", schema: { min: 0, max: 0 }, files },
      };
      await expect(planAppUpgrade(input)).rejects.toThrow("path alias");
      await expect(applyAppUpgrade(input)).rejects.toThrow("path alias");
      expect(await tree(root)).toEqual({});
    }
  });

  it("resumes and replays creation under one exact directory-prefix spelling", async () => {
    const root = await scratch();
    const input: AppUpgradeInput = {
      root, schemaVersion: 0,
      from: { version: "1", schema: { min: 0, max: 0 }, files: {} },
      to: { version: "2", schema: { min: 0, max: 0 }, files: { "A/one.txt": "one", "A/two.txt": "two" } },
    };
    const nativeRename = fs.rename.bind(fs);
    let renames = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (++renames === 2) throw new Error("interrupted same-prefix creation");
      await nativeRename(source, destination);
    });
    await expect(applyAppUpgrade(input)).rejects.toThrow("interrupted same-prefix creation");
    expect(await tree(root)).toEqual({ A: "directory", "A/one.txt": Buffer.from("one").toString("hex") });
    vi.restoreAllMocks();
    expect((await planAppUpgrade(input)).files).toEqual([
      { path: "A/one.txt", action: "already-applied" }, { path: "A/two.txt", action: "create" },
    ]);
    expect((await applyAppUpgrade(input)).applied).toEqual(["A/two.txt"]);
    expect((await applyAppUpgrade(input)).applied).toEqual([]);
    expect(await tree(root)).toEqual({ A: "directory", "A/one.txt": Buffer.from("one").toString("hex"), "A/two.txt": Buffer.from("two").toString("hex") });
  });

  it("resumes exact completed renames after an I/O interruption without a journal", async () => {
    const input = await fixture(), nativeRename = fs.rename.bind(fs);
    let renames = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (++renames === 2) throw Object.assign(new Error("interrupted rename"), { code: "EIO" });
      await nativeRename(source, destination);
    });
    await expect(applyAppUpgrade(input)).rejects.toThrow("interrupted rename");
    expect(await fs.readFile(join(input.root, "generated/entry.ts"), "utf8")).toBe(input.to.files["generated/entry.ts"]);
    expect(await fs.readFile(join(input.root, "generated/remove.ts"), "utf8")).toBe(input.from.files["generated/remove.ts"]);
    expect((await fs.readdir(join(input.root, "generated"))).some(path => path.endsWith(".tmp"))).toBe(false);
    vi.restoreAllMocks();
    expect((await planAppUpgrade(input)).files[0]).toEqual({ path: "generated/entry.ts", action: "already-applied" });
    expect((await applyAppUpgrade(input)).applied).toEqual(["generated/new.ts", "generated/remove.ts"]);
    expect((await applyAppUpgrade(input)).applied).toEqual([]);
  });

  it("resumes after an actual process dies immediately after its first file replacement", async () => {
    const input = await fixture();
    // Use the built module as a separate Node application would. The root
    // pretest prerequisite builds it before this suite; no production hook is needed.
    const moduleUrl = new URL("../../dist/lifecycle/appUpgrade.js", import.meta.url).href;
    const script = `
      import { promises as fs } from 'node:fs';
      import { applyAppUpgrade } from ${JSON.stringify(moduleUrl)};
      const rename = fs.rename.bind(fs);
      fs.rename = async (...args) => {
        await rename(...args);
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      };
      await applyAppUpgrade(JSON.parse(process.argv[1]));
    `;
    await expect(promisify(execFile)(process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(input)], { timeout: 5000 }))
      .rejects.toMatchObject({ signal: "SIGKILL" });
    expect(await fs.readFile(join(input.root, "generated/entry.ts"), "utf8")).toBe(input.to.files["generated/entry.ts"]);
    expect((await planAppUpgrade(input)).files[0].action).toBe("already-applied");
    expect((await applyAppUpgrade(input)).applied).toEqual(["generated/new.ts", "generated/remove.ts"]);
    expect(await fs.readFile(join(input.root, "theme.css"), "utf8")).toBe("adopter theme\n");
    expect((await applyAppUpgrade(input)).applied).toEqual([]);
  });

  it("rechecks a previously clean plan and refuses a stale changed-file observation", async () => {
    const input = await fixture();
    expect((await planAppUpgrade(input)).conflicts).toEqual([]);
    await put(input.root, "generated/entry.ts", "changed since planning\n");
    const current = await tree(input.root);
    await expect(applyAppUpgrade(input)).rejects.toBeInstanceOf(AppUpgradeConflictError);
    expect(await tree(input.root)).toEqual(current);
  });

  it("preserves existing file permissions and leaves another hardlink's bytes untouched", async () => {
    const input = await fixture(), destination = join(input.root, "generated/entry.ts");
    await fs.chmod(destination, 0o754);
    await fs.link(destination, join(input.root, "adopter-hardlink.ts"));
    await applyAppUpgrade(input);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o754);
    expect(await fs.readFile(join(input.root, "adopter-hardlink.ts"), "utf8")).toBe(input.from.files["generated/entry.ts"]);
  });

  it("preserves an adopter deletion when upstream leaves that file unchanged", async () => {
    const input = await fixture();
    await fs.unlink(join(input.root, "theme.css"));
    expect((await planAppUpgrade(input)).files.at(-1)).toEqual({ path: "theme.css", action: "preserved" });
    await applyAppUpgrade(input);
    await expect(fs.stat(join(input.root, "theme.css"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("compares bytes without accepting invalid UTF-8 through replacement decoding", async () => {
    const input = await fixture();
    input.from.files = { ...input.from.files, "generated/entry.ts": "\ufffd" };
    await put(input.root, "generated/entry.ts", Buffer.from([0xff]));
    expect((await planAppUpgrade(input)).conflicts).toContainEqual({ path: "generated/entry.ts", reason: "current bytes match neither predecessor nor candidate" });
  });

  it("admits the N and N+1 expand window independently of app file reconciliation", async () => {
    const input = await fixture();
    for (const schemaVersion of [1, 2]) expect((await planAppUpgrade({ ...input, schemaVersion })).conflicts).toEqual([]);
    input.to.schema = { min: 2, max: 3 };
    const before = await tree(input.root);
    await expect(applyAppUpgrade(input)).rejects.toThrow("outside 0.2.0 range");
    expect(await tree(input.root)).toEqual(before);
    input.schemaVersion = 2;
    expect((await planAppUpgrade(input)).conflicts).toEqual([]);
    input.schemaVersion = 3;
    await expect(applyAppUpgrade(input)).rejects.toThrow("outside 0.1.0 range");
  });

  it.each(["../escape", "/absolute", "a//b", "a/./b", "a/../b", "a\\b", "C:drive", "a\u0000b", ".git/config", "node_modules/library/index.js"])("rejects unsafe path %j before writes", async path => {
    const input = await fixture(), before = await tree(input.root);
    input.to.files = { [path]: "unsafe" };
    await expect(applyAppUpgrade(input)).rejects.toThrow("Unsafe application upgrade path");
    expect(await tree(input.root)).toEqual(before);
  });

  it.each([{ "a": "x", "a/b": "y" }, { "A": "x", "a": "y" }, { "caf\u00e9.ts": "x", "cafe\u0301.ts": "y" }] as Record<string, string>[])("rejects file-parent and portable case/normalization aliases", async files => {
    const input = await fixture(), before = await tree(input.root);
    input.to.files = files;
    await expect(applyAppUpgrade(input)).rejects.toThrow(/collision|alias/u);
    expect(await tree(input.root)).toEqual(before);
  });

  it("rejects malformed UTF-16 paths that encode to an existing candidate filename", async () => {
    const input = await fixture(), before = await tree(input.root);
    input.to.files = { "\ud800.ts": "first", "\ufffd.ts": "second" };
    await expect(planAppUpgrade(input)).rejects.toThrow("Unsafe application upgrade path");
    await expect(applyAppUpgrade(input)).rejects.toThrow("Unsafe application upgrade path");
    expect(await tree(input.root)).toEqual(before);
  });

  it("refuses symlink roots, managed leaves and managed parents without modifying their destinations", async () => {
    const input = await fixture(), outside = await scratch(), linkedRoot = join(outside, "root-link");
    await fs.symlink(input.root, linkedRoot, "dir");
    await expect(applyAppUpgrade({ ...input, root: linkedRoot })).rejects.toThrow("ordinary directory");
    const aliasAncestor = join(outside, "alias");
    await fs.symlink(dirname(input.root), aliasAncestor, "dir");
    await expect(applyAppUpgrade({ ...input, root: join(aliasAncestor, input.root.split("/").at(-1)!) })).rejects.toThrow("absolute canonical path");
    await put(outside, "entry.ts", "outside bytes\n");
    await fs.unlink(join(input.root, "generated/entry.ts"));
    await fs.symlink(join(outside, "entry.ts"), join(input.root, "generated/entry.ts"));
    let before = await tree(input.root);
    await expect(applyAppUpgrade(input)).rejects.toThrow("symlink in managed path");
    expect(await tree(input.root)).toEqual(before);
    expect(await fs.readFile(join(outside, "entry.ts"), "utf8")).toBe("outside bytes\n");
    await fs.rm(join(input.root, "generated"), { recursive: true });
    await fs.symlink(outside, join(input.root, "generated"), "dir");
    before = await tree(input.root);
    await expect(applyAppUpgrade(input)).rejects.toThrow("symlink in managed path");
    expect(await tree(input.root)).toEqual(before);
  });

  it("refuses existing file parents and directory leaves before writing a different path", async () => {
    const input = await fixture();
    await fs.rm(join(input.root, "generated"), { recursive: true });
    await put(input.root, "generated", "regular parent\n");
    let before = await tree(input.root);
    await expect(applyAppUpgrade(input)).rejects.toThrow("managed parent is not a directory");
    expect(await tree(input.root)).toEqual(before);
    await fs.unlink(join(input.root, "generated"));
    await fs.mkdir(join(input.root, "generated/entry.ts"), { recursive: true });
    before = await tree(input.root);
    await expect(applyAppUpgrade(input)).rejects.toThrow("managed path is not a regular file");
    expect(await tree(input.root)).toEqual(before);
  });

  it.each([
    { version: "", schema: { min: 1, max: 2 } },
    { version: "candidate", schema: { min: 2, max: 1 } },
    { version: "candidate", schema: { min: -1, max: 2 } },
    { version: "candidate", schema: { min: 1, max: Infinity } },
    { version: "candidate", schema: { min: 1.5, max: 2 } },
  ])("rejects invalid snapshot identity or range", async snapshot => {
    const input = await fixture();
    input.to = { ...snapshot, files: {} };
    await expect(planAppUpgrade(input)).rejects.toThrow(/snapshot/u);
  });

  it.each([-1, 1.5, Infinity, NaN])("refuses invalid observed schema ordinal %j", async schemaVersion => {
    const input = await fixture();
    await expect(planAppUpgrade({ ...input, schemaVersion })).rejects.toThrow("nonnegative safe integer");
  });

  it("refuses snapshot strings that cannot represent exact UTF-8", async () => {
    const input = await fixture();
    input.to.files = { "invalid.ts": "\ud800" };
    await expect(planAppUpgrade(input)).rejects.toThrow("valid UTF-8");
  });
});
