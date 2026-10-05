/** Local packed proof. Requires an explicit disposable loopback PostgreSQL URL; no ambient database variable. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import ts from "typescript";
const target = new URL(process.argv[2] ?? "invalid:");
if (target.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.password || target.search || target.pathname !== "/openlup_outbox_proof") throw new Error("Use the explicit disposable loopback database openlup_outbox_proof, with no password or query options");
const root = process.cwd(), scratch = resolve(process.argv[3] ?? ".context/scratch/outbox-packed-proof");
if (!scratch.startsWith(join(root, ".context", "scratch") + "/")) throw new Error("Proof output must stay in this task's ignored scratch directory");
mkdirSync(scratch, { recursive: true });
const packs = join(scratch, "packs"), consumer = join(scratch, "consumer");
mkdirSync(packs, { recursive: true }); mkdirSync(consumer, { recursive: true });
const env = { ...process.env, npm_config_cache: join(scratch, "npm-cache") };
const pack = (directory: string): string => {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packs], { cwd: join(root, directory), env, encoding: "utf8" });
  const [info] = JSON.parse(output); return join(packs, info.filename);
};
const core = pack("packages/core"), outbox = pack("packages/outbox"), zod = pack("node_modules/zod");
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "outbox-disposable-consumer", private: true, type: "module" }));
execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--fund=false", core, outbox, zod], { cwd: consumer, env, stdio: "inherit" });
// Compile the actual reference composition and admission, with imports resolving only to installed tarballs.
for (const name of ["referenceContribution", "candidateAdmission"]) {
  const source = readFileSync(join(root, "server/runtime/outbox", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  writeFileSync(join(consumer, `${name}.js`), compiled);
}
writeFileSync(join(consumer, "proof.mjs"), readFileSync(join(root, "packages/outbox/smoke/wiring.ts"), "utf8"));
const pool = new pg.Pool({ connectionString: target.href, max: 4 }), observer = new pg.Pool({ connectionString: target.href, max: 2 });
try {
  const proof = await import(pathToFileURL(join(consumer, "proof.mjs")).href);
  await proof.prove(pool, observer);
} finally { await Promise.all([pool.end(), observer.end()]); }
console.log("Packed outbox/reference proof PASS; disposable database only, no provider or deployment proof");
