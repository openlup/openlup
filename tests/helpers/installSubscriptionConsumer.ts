import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

/** Install the locked runtime closure locally; offline mode refuses new dependencies. */
export async function installSubscriptionConsumer(scratch: string) {
  const exec = promisify(execFile);
  mkdirSync(scratch, { recursive: true });
  // A previous consumer must not hide a missing tarball in a cold-install proof.
  rmSync(resolve(scratch, "node_modules"), { recursive: true, force: true });
  rmSync(resolve(scratch, "package-lock.json"), { force: true });
  const tarballs: string[] = [];
  const dependencies = ["zod", "pg", "pg-connection-string", "pg-int8", "pg-pool", "pg-protocol", "pg-types", "pgpass",
    "postgres-array", "postgres-bytea", "postgres-date", "postgres-interval", "split2", "xtend"];
  for (const directory of ["packages/core", "packages/platform", ...dependencies.map(name => `node_modules/${name}`)]) {
    const { stdout } = await exec("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: resolve(directory), timeout: 120_000 });
    tarballs.push(resolve(scratch, JSON.parse(stdout)[0].filename));
  }
  writeFileSync(resolve(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--omit=optional", "--no-audit", "--no-fund", ...tarballs],
    { cwd: scratch, timeout: 120_000 });
  const installed = createRequire(resolve(scratch, "package.json"));
  if (!realpathSync(installed.resolve("pg")).startsWith(realpathSync(resolve(scratch, "node_modules")) + sep)) {
    throw new Error("Subscription consumer resolved pg outside its installation");
  }
  return installed;
}
