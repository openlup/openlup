/** Packed proof; only an explicit disposable loopback database is accepted. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, join, basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parsePackagesConfig } from "./package-manifest-policy.ts";
import { readPackManifest, isolatedConsumerEnv, assertInstalledPackages } from "./pack-manifest-input.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [database, scratchArgument, ...options] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < options.length; index += 2) {
  const name = options[index], value = options[index + 1];
  if (!["--manifest", "--expected-commit"].includes(name!) || !value || value.startsWith("--") || flags.has(name!)) throw new Error("Use --manifest <path> and --expected-commit <full-sha> together");
  flags.set(name!, value);
}
if (flags.has("--manifest") !== flags.has("--expected-commit")) throw new Error("Manifest and expected commit must be supplied together");
const target = new URL(database ?? "invalid:");
if (target.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.password || target.search || target.hash || target.pathname !== "/openlup_outbox_proof") throw new Error("Use the explicit disposable loopback database openlup_outbox_proof, with no password or query options");
const scratch = resolve(scratchArgument ?? ".context/scratch/outbox-packed-proof");
if (!scratch.startsWith(join(root, ".context", "scratch") + "/")) throw new Error("Proof output must stay in this task's ignored scratch directory");
const expected = parsePackagesConfig(readFileSync(join(root, "config/openlup-packages.json"), "utf8")).packages.filter(p => p.publish).map(p => {
  const manifest = JSON.parse(readFileSync(join(root, p.directory, "package.json"), "utf8"));
  if (manifest.name !== p.name || typeof manifest.version !== "string") throw new Error("Invalid actual package inventory");
  return { name: p.name, version: manifest.version, directory: p.directory };
});
const supplied = flags.has("--manifest") ? readPackManifest(resolve(flags.get("--manifest")!), flags.get("--expected-commit")!, expected) : undefined;
// Validate the complete set above, but this reference imports only its own
// composition. Unrelated future modules belong to their own package consumers.
const referencePackages = expected.filter(p => ["@openlup/core", "@openlup/outbox"].includes(p.name));
if (referencePackages.length !== 2) throw new Error("Outbox reference needs Core and Outbox artifacts");
mkdirSync(scratch, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "openlup-outbox-consumer-"));
const env = isolatedConsumerEnv();
const command = (name: string, args: string[], cwd: string) => execFileSync(name, args, { cwd, env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
try {
  const checkout = realpathSync(root), owned = realpathSync(temporary);
  if (owned === checkout || owned.startsWith(checkout + sep) || checkout.startsWith(owned + sep)) throw new Error("Consumer must be outside checkout ancestors");
  const packs = join(temporary, "packs"), consumer = join(temporary, "consumer"), cache = join(temporary, "npm-cache");
  mkdirSync(packs); mkdirSync(consumer);
  const pack = (directory: string): string => {
    const [info] = JSON.parse(command("npm", ["pack", "--json", "--ignore-scripts", "--cache", cache, "--pack-destination", packs], directory));
    return join(packs, info.filename);
  };
  const packageInputs = referencePackages.map(p => {
    if (!supplied) return pack(join(root, p.directory));
    const entry = supplied.get(p.name)!, bytes = readFileSync(entry.path);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== entry.integrity) throw new Error(`Verified artifact changed before use: ${p.name}`);
    const input = join(packs, basename(entry.path));
    writeFileSync(input, bytes);
    return input;
  });
  // Locked Zod and the injected pg module are named host inputs, never OpenLup workspace fallbacks.
  const zodDirectory = join(root, "node_modules/zod");
  if (!lstatSync(zodDirectory).isDirectory() || lstatSync(zodDirectory).isSymbolicLink()) throw new Error("Zod runtime input must be an ordinary installed directory");
  const zod = pack(zodDirectory);
  writeFileSync(join(scratch, "consumed-artifacts.json"), JSON.stringify({ expectedCommit: flags.get("--expected-commit") ?? null, packages: supplied ? referencePackages.map((p, index) => ({ ...supplied.get(p.name), usedPath: packageInputs[index] })) : packageInputs }, null, 2) + "\n");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "outbox-disposable-consumer", private: true, type: "module" }));
  command("npm", ["install", "--offline", "--ignore-scripts", "--cache", cache, "--no-audit", "--fund=false", ...packageInputs, zod], consumer);
  assertInstalledPackages(consumer, [...referencePackages.map(p => p.name), "zod"]);
  const installed = referencePackages.map(p => {
    const path = realpathSync(join(consumer, "node_modules", p.name)), bytes = readFileSync(join(path, "package.json"));
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.name !== p.name || manifest.version !== p.version) throw new Error(`Installed identity mismatch for ${p.name}`);
    return { name: p.name, version: manifest.version, path, manifestSha256: createHash("sha256").update(bytes).digest("hex"), artifactSha256: supplied?.get(p.name)?.sha256 ?? null };
  });
  writeFileSync(join(scratch, "installed-packages.json"), JSON.stringify(installed, null, 2) + "\n");
  for (const name of ["referenceContribution", "candidateAdmission"]) {
    const source = readFileSync(join(root, "server/runtime/outbox", `${name}.ts`), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    writeFileSync(join(consumer, `${name}.js`), compiled);
  }
  for (const name of ["wiring", "schemaProof"]) writeFileSync(join(consumer, `${name}.mjs`), readFileSync(join(root, "packages/outbox/smoke", `${name}.ts`)));
  writeFileSync(join(consumer, "schema-budget-proof.mjs"), readFileSync(join(root, "scripts/packages/schema-budget-proof.mjs")));
  const require = createRequire(import.meta.url);
  writeFileSync(join(consumer, "run.mjs"), `import pg from ${JSON.stringify(pathToFileURL(require.resolve("pg")).href)};\nimport { prove } from "./wiring.mjs";\nconst pool = new pg.Pool({ connectionString: process.argv[2], max: 4 });\nconst observer = new pg.Pool({ connectionString: process.argv[2], max: 2 });\ntry { await prove(pool, observer); } finally { await Promise.all([pool.end(), observer.end()]); }\n`);
  process.stdout.write(command(process.execPath, [join(consumer, "run.mjs"), target.href], consumer));
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log("Packed outbox/reference proof PASS; disposable database only, no provider or deployment proof");
