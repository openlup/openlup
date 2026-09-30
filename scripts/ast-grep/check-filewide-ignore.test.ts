import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const checker = join(dirname(fileURLToPath(import.meta.url)), "check-filewide-ignore.mjs");

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
