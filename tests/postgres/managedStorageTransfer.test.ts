import { execFile } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("projects managed Storage rows through local S3 into the private filesystem store and qualified PG16", async () => {
  const environment = { ...processEnvironment };
  delete environment.OPENLUP_M14_STORAGE_INPUT;
  const result = await run(process.execPath, ["--import", "tsx", "tests/postgres/managedStorageTransfer.proof.ts"],
    { env: environment, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.stdout).toContain("managed-storage-proof PASS");
}, 610_000);
