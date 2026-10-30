import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("projects managed Storage API objects into qualified PG16 and local S3", async () => {
  const result = await run(process.execPath, ["--import", "tsx", "tests/postgres/managedStorageTransfer.proof.ts"],
    { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.stdout).toContain("managed-storage-proof PASS");
}, 610_000);
