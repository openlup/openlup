import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = join(root, "packages/outbox");
it("the actual API checker rejects declaration drift and accepts its reviewed matching snapshot", () => {
  const base = join(root, ".context/scratch/outbox-api-falsifier"); mkdirSync(base, { recursive: true });
  const fixture = mkdtempSync(join(base, "case-"));
  try {
    for (const file of ["package.json", "release-gates.json", "dist", "api", "scripts/api-contract.ts"]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true }); cpSync(join(directory, file), join(fixture, file), { recursive: true });
    }
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", join(fixture, "scripts/api-contract.ts")], { encoding: "utf8", timeout: 10_000 });
    expect(run().status).toBe(0);
    const contract = JSON.parse(readFileSync(join(fixture, "release-gates.json"), "utf8")).packageSurface["."];
    const entrypoint = join(fixture, contract.entrypoint), previous = readFileSync(entrypoint, "utf8").trimEnd();
    const changed = `${previous}\nexport declare const syntheticAddedExport: string;`;
    writeFileSync(entrypoint, changed + "\n");
    const refusal = run(); expect(refusal.status).not.toBe(0); expect(refusal.stderr).toContain("package surface drift");
    const snapshot = join(fixture, contract.snapshot), before = readFileSync(snapshot, "utf8");
    expect(before).toContain(previous);
    writeFileSync(snapshot, before.replace(previous, changed));
    expect(run().status).toBe(0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
it("packs within declared budgets, binds public SQL, imports exact exports and compiles the shipped agent example", () => {
  const base = join(root, ".context/scratch/outbox-contract"); mkdirSync(base, { recursive: true });
  const scratch = mkdtempSync(join(base, "pack-"));
  const cache = join(base, "npm-cache");
  try {
    const [info] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--cache", cache, "--pack-destination", scratch], { cwd: directory, encoding: "utf8" }));
    const files = info.files.map((f: { path: string }) => f.path);
    expect(files.every((f: string) => /^(dist\/|src\/|sql\/|AGENTS.md$|README.md$|CHANGELOG.md$|LICENSE$|release-gates.json$|package.json$)/.test(f))).toBe(true);
    const extracted=join(scratch,"extracted");mkdirSync(extracted);
    execFileSync("tar",["-xzf",join(scratch,info.filename),"-C",extracted]);
    const budget=JSON.parse(readFileSync(join(directory,"release-gates.json"),"utf8")).pack;
    expect(info.entryCount).toBeLessThanOrEqual(budget.maxFiles);
    expect(info.size).toBeLessThanOrEqual(budget.maxPackedBytes);
    expect(info.unpackedSize).toBeLessThanOrEqual(budget.maxUnpackedBytes);
    for(const kind of ["code","docs"] as const){
      const members=files.filter((file:string)=>kind==="code"?/^dist\/.+\.(?:js|d\.ts)$/.test(file)||/^src\/.+\.ts$/.test(file):!file.includes("/")).sort();
      expect(members.length).toBeLessThanOrEqual(budget[kind].maxFiles);
      expect(gzipSync(Buffer.concat(members.map((file:string)=>readFileSync(join(extracted,"package",file))))).length).toBeLessThanOrEqual(budget[kind].maxPackedBytes);
    }
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    for (const target of Object.values(manifest.exports) as { types: string; import: string }[]) {
      expect(files).toContain(target.types.slice(2)); expect(files).toContain(target.import.slice(2));
    }
    const sqlManifest = JSON.parse(readFileSync(join(directory, "sql/manifest.json"), "utf8"));
    const entry = sqlManifest.migrations[0];
    expect(createHash("sha256").update(readFileSync(join(directory, "sql", entry.file))).digest("hex")).toBe(entry.sha256);
    expect(readFileSync(join(directory, "sql", entry.file))).toEqual(readFileSync(join(root, entry.source)));
    const guide = readFileSync(join(directory, "AGENTS.md"), "utf8");
    const example = /```ts\n([\s\S]*?)\n```/.exec(guide)![1];
    const file = join(scratch, "agent-example.mts"); writeFileSync(file, example);
    execFileSync(join(root, "node_modules/.bin/tsc"), [file, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022"], { cwd: root });
    const refusal = spawnSync("npm", ["run", "prepublishOnly", "--cache", cache], { cwd: directory, encoding: "utf8" });
    expect(refusal.status).not.toBe(0); expect(refusal.stderr).toContain("OUTBOX_DIRECTORY_PUBLISH_REFUSED");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30000);
