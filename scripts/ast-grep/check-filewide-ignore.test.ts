import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const checker = join(dirname(fileURLToPath(import.meta.url)), "check-filewide-ignore.mjs");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scanner = join(repository, "node_modules/.bin/ast-grep");

function scan(root: string) {
  return spawnSync(scanner, [
    "scan", "--config", join(root, "sgconfig.yml"), "--json=compact",
    "--error=no-suppress-all", "--error=unused-suppression", "server/bff",
  ], { cwd: root, encoding: "utf8" });
}

function check(root: string) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
}

function createProbe(extension: string) {
  const root = mkdtempSync(join(tmpdir(), "openlup-ignore-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "server/bff"), { recursive: true });
  writeFileSync(join(root, "sgconfig.yml"), `ruleDirs:\n  - ${JSON.stringify(join(repository, "scripts/ast-grep/rules"))}\n`);
  return { root, file: `server/bff/probe.${extension}` };
}

it.each(["ts", "tsx"])("rejects actual scanner file-wide suppression forms in %s", (extension) => {
  const { root, file } = createProbe(extension);
  try {
    const code = "const db = createClient(url, key);";
    writeFileSync(join(root, file), `${code}\n`);
    const baseline = scan(root);
    expect(baseline.status, baseline.stderr).toBe(1);
    expect(baseline.stdout).toContain("bff-database-through-ports");

    const directives = [
      "// ast-grep-ignore: bff-database-through-ports, bff-database-through-ports-tsx",
      "\uFEFF// ast-grep-ignore: bff-database-through-ports, bff-database-through-ports-tsx",
      "/// ast-grep-ignore: bff-database-through-ports, bff-database-through-ports-tsx",
      "\uFEFF\t///\tast-grep-ignore: bff-database-through-ports, bff-database-through-ports-tsx",
      "\t/* ast-grep-ignore: bff-database-through-ports, bff-database-through-ports-tsx */",
    ];
    for (const directive of directives) {
      for (const ending of ["\n", "\r\n"]) {
        writeFileSync(join(root, file), `${directive}${ending}\t ${ending}${code}${ending}`);
        const suppressed = scan(root);
        expect(suppressed.status, suppressed.stderr).toBe(0);
        expect(JSON.parse(suppressed.stdout)).toEqual([]);
        const refused = check(root);
        expect(refused.status, refused.stderr).toBe(1);
        expect(refused.stderr).toContain(`${file}:1`);
      }
      // Exercise both untracked and tracked source without changing its bytes.
      execFileSync("git", ["add", "--", file], { cwd: root });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["ts", "tsx"])("keeps named line exceptions and scanner hygiene effective in %s", (extension) => {
  const { root, file } = createProbe(extension);
  const rule = extension === "tsx" ? "bff-database-through-ports-tsx" : "bff-database-through-ports";
  try {
    for (const code of ["const sender = message.from;", "const { from: sender } = neutralDto;"]) {
      for (const prefix of ["", "// A non-database sender uses the generic from property.\n"]) {
        writeFileSync(join(root, file), `${prefix}// ast-grep-ignore: ${rule}\n${code}\n`);
        const allowed = scan(root);
        expect(allowed.status, allowed.stderr).toBe(0);
        expect(check(root).status).toBe(0);
      }
    }

    writeFileSync(join(root, file), "// ast-grep-ignore\nconst sender = message.from;\n");
    const bare = scan(root);
    expect(bare.status, bare.stderr).toBe(1);
    expect(bare.stdout).toContain("no-suppress-all");
    expect(check(root).status).toBe(0);

    writeFileSync(join(root, file), `// ast-grep-ignore: ${rule}\nconst sender = message;\n`);
    const unused = scan(root);
    expect(unused.status, unused.stderr).toBe(1);
    expect(unused.stdout).toContain("unused-suppression");
    expect(check(root).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["ts", "tsx"])("does not classify other comment placements as file-wide in %s", (extension) => {
  const { root, file } = createProbe(extension);
  const rule = extension === "tsx" ? "bff-database-through-ports-tsx" : "bff-database-through-ports";
  try {
    for (const directive of [
      `/* ast-grep-ignore: ${rule}\n */`,
      `/* A comment before the directive. */ // ast-grep-ignore: ${rule}`,
    ]) {
      // An intervening harmless node distinguishes node suppression from file suppression.
      writeFileSync(join(root, file), `${directive}\n\nconst ordinary = rows;\nconst db = createClient(url, key);\n`);
      const result = scan(root);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("createClient");
      expect(check(root).status).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a named file-wide ignore even when it names the guard itself", () => {
  const root = mkdtempSync(join(tmpdir(), "openlup-ignore-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"));
    const tsx = join(root, "src/probe.tsx");
    writeFileSync(tsx, "// ast-grep-ignore: no-filewide-ast-grep-ignore, bff-database-through-ports\n\nconst db = createClient(url, key);\n");
    const blocked = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("src/probe.tsx:1");

    writeFileSync(tsx, "// ast-grep-ignore: bff-database-through-ports\nconst db = createClient(url, key);\n");
    expect(spawnSync(process.execPath, [checker], { cwd: root }).status).toBe(0);

    execFileSync("git", ["add", "--", "src/probe.tsx"], { cwd: root });
    writeFileSync(join(root, "src/probe.ts"), "/* ast-grep-ignore: domain-no-environment-reads */\n\nconst env = " + ["process", ".env"].join("") + ";\n");
    const blockedTs = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    expect(blockedTs.status).toBe(1);
    expect(blockedTs.stderr).toContain("src/probe.ts:1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
