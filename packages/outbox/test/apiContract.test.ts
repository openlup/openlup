import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
it.each(["core", "outbox"])("%s api:update accepts a fragment alone and refuses missing change notes", (name) => {
  const base = join(root, ".context/scratch/api-update"); mkdirSync(base, { recursive: true });
  const fixture = mkdtempSync(join(base, `${name}-`));
  const write = (path: string, contents: string) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), contents); };
  try {
    const source = join(root, "packages", name);
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const gates = JSON.parse(readFileSync(join(source, "release-gates.json"), "utf8"));
    const [subpath, contract] = Object.entries(gates.packageSurface)[0] as [string, { entrypoint: string; snapshot: string; packageSmokeEvidence: string[] }];
    manifest.exports = { "./package.json": "./package.json", [subpath]: manifest.exports[subpath] };
    gates.packageSurface = { [subpath]: contract };
    write("package.json", JSON.stringify(manifest)); write("release-gates.json", JSON.stringify(gates));
    write(contract.entrypoint, "export declare const fixture: string;\n");
    for (const path of contract.packageSmokeEvidence) write(path, "// Fixture evidence.\n");
    for (const file of ["api-contract.ts", ...(name === "core" ? ["public-api-config.ts"] : [])]) {
      const target = join(fixture, "scripts", file); mkdirSync(dirname(target), { recursive: true }); cpSync(join(source, "scripts", file), target);
    }
    const git = (args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
    git(["init", "--quiet"]); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", join(fixture, "scripts/api-contract.ts"), "--update"], { encoding: "utf8", timeout: 10_000 });
    const refusal = run(); expect(refusal.status).not.toBe(0); expect(refusal.stderr).toContain("add or modify changes/*.md");
    rmSync(join(fixture, contract.snapshot));
    write("changes/api-update.md", "- Review the changed API snapshot.\n");
    const accepted = run(); expect(accepted.stderr).toBe(""); expect(accepted.status).toBe(0);
    git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "snapshot and fragment"]);
    write(contract.entrypoint, "export declare const fixture: number;\n");
    const unchanged = run(); expect(unchanged.status).not.toBe(0); expect(unchanged.stderr).toContain("add or modify changes/*.md");
    rmSync(join(fixture, contract.snapshot));
    write("changes/api-update.md", "- Review another changed API snapshot.\n");
    expect(run().status).toBe(0);
    rmSync(join(fixture, contract.snapshot)); git(["restore", "changes/api-update.md"]);
    write("CHANGELOG.md", "- Legacy change notes.\n");
    expect(run().status).toBe(0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
