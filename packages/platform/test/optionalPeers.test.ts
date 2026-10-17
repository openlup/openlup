import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createS3ClientFromEnv } from "../src/blob/s3Client.js";

const paths = [
  { module: "blob/s3Client", capability: "the S3 blob capability", peer: "@aws-sdk/client-s3" },
  { module: "data/postgresGateway", capability: "the Postgres data gateway", peer: "pg" },
  { module: "migrations/postgresRunner", capability: "the Postgres migration runner", peer: "pg" },
  { module: "scheduler/advisoryLock", capability: "the Postgres scheduler advisory lock", peer: "pg" },
];

async function run(module: string, failure: Error, expected?: string): Promise<void> {
  if (module === "blob/s3Client") {
    const operation = createS3ClientFromEnv({}, () => { throw failure; }).putObject({ Bucket: "synthetic", Key: "probe", Body: Buffer.from("probe") });
    if (expected) await expect(operation).rejects.toMatchObject({ message: expected, cause: failure });
    else await expect(operation).rejects.toBe(failure);
    return;
  }
  // Vitest wraps errors thrown by mock factories. Native resolution hooks inject
  // the original failing import, so these assertions exercise Node's real import().
  const sourceRoot = new URL("../src/", import.meta.url).href;
  execFileSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "--eval", `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const failure = Object.assign(new Error(${JSON.stringify(failure.message)}), { code: ${JSON.stringify((failure as Error & { code?: string }).code)} });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "pg") throw failure;
  if (context.parentURL?.startsWith(${JSON.stringify(sourceRoot)}) && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
  return next(specifier, context);
} });
const adapter = await import(${JSON.stringify(new URL(`${module}.ts`, sourceRoot).href)});
let operation;
if (${JSON.stringify(module)} === "data/postgresGateway") operation = () => adapter.createPostgresDataGateway({ connectionString: "postgresql://unused.invalid/consumer" }).asService(async () => undefined);
else if (${JSON.stringify(module)} === "scheduler/advisoryLock") operation = () => adapter.createEnvAdvisoryLock({ DATABASE_URL: "postgresql://unused.invalid/consumer" }).tryAcquire("probe");
else operation = () => adapter.createPostgresMigrationRunner({ connectionString: "postgresql://unused.invalid/consumer" }, {
  root: "/synthetic", lockName: "consumer", catalogProjectionPayload: async () => "",
  source: {
    readMigrations: () => ({ migrations: [{ file: "baseline.sql", content: "SELECT 1;" }], errors: [] }),
    readManifest: () => ({ schemaVersion: 1, baseline: { file: "baseline.sql", sha256: "0".repeat(64) }, forward: [], objectInventorySha256: "0".repeat(64) }),
    evaluate: () => [],
  },
}).status();
await assert.rejects(operation, error => ${expected ? `error.message === ${JSON.stringify(expected)} && error.cause === failure` : "error === failure"});
`], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: {}, stdio: "pipe", timeout: 10_000 });
}

describe.each(paths)("optional peer refusal: $capability", ({ module, capability, peer }) => {
  it.each(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"])("names the peer and preserves the cause for %s", async code => {
    const failure = Object.assign(new Error(`Cannot find ${code === "MODULE_NOT_FOUND" ? "module" : "package"} '${peer}' imported from /synthetic/adapter.js`), { code });
    await run(module, failure, `OPENLUP_E_PEER_MISSING: ${peer} is required by ${capability}; install it alongside @openlup/platform`);
  });

  it.each([
    { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package 'transitive-sdk' imported from /node_modules/pg/index.js" },
    { code: "MODULE_NOT_FOUND", message: "Cannot find module 'pg-protocol' required by pg" },
    { code: "EACCES", message: `Cannot find module '${peer}'` },
    { code: "ERR_MODULE_NOT_FOUND", message: `Cannot find module '${peer}/internal.js'` },
    { code: undefined, message: "SDK initialization failed" },
  ])("passes other errors through unchanged: $message ($code)", async ({ code, message }) => {
    await run(module, Object.assign(new Error(message), { code }));
  });
});
