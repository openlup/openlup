import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { consumerNode, assertConsumerIsolation } from "./platform-cold-consumer.ts";
import { REFERENCE_DELEGATION_CONSUMER_PROOF, REFERENCE_DELEGATION_TYPES } from "./reference-delegation-consumer-proof.ts";

const root = resolve(import.meta.dirname, "../..");
let temporary: string | undefined;
afterEach(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); temporary = undefined; });

it("installs actual package tarballs and proves typed invoice behavior in isolation", () => {
  const consumer = mkdtempSync(join(tmpdir(), "reference-market-consumer-"));
  temporary = consumer;
  const packs = join(consumer, "packs"); mkdirSync(packs);
  const pack = (directory: string) => {
    const [info] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packs], {
      cwd: directory, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 30_000,
    }));
    return join(packs, info.filename as string);
  };
  const inputs = ["packages/core", "packages/platform", "node_modules/zod", "node_modules/@types/node", "node_modules/undici-types"];
  const tarballs = inputs.map(path => pack(join(root, path)));
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}');
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps", "--no-audit", "--fund=false", ...tarballs], {
    cwd: consumer, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 30_000,
  });
  assertConsumerIsolation(consumer, root);
  const file = join(consumer, "types.ts"); writeFileSync(file, REFERENCE_DELEGATION_TYPES);
  for (const mode of ["NodeNext", "Bundler"]) {
    const config = join(consumer, "types.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: [file] }));
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", config], { cwd: consumer, env: isolatedConsumerEnv(), timeout: 30_000 });
  }
  expect(consumerNode(consumer, REFERENCE_DELEGATION_CONSUMER_PROOF)).toContain("delegated installed invoice consumer PASS");
  expect(JSON.parse(readFileSync(join(consumer, "node_modules/@openlup/platform/package.json"), "utf8")).name).toBe("@openlup/platform");
}, 60_000);
