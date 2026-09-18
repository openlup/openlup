import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const RUNNER = "scripts/catalog-document-revision-foundation-real-db-proof.ts";

function withoutCatalogProofInfrastructure(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CATALOG_DOCUMENT_FOUNDATION_MANAGED_REPLAY_DATABASE_URL;
  delete environment.CATALOG_DOCUMENT_FOUNDATION_PORTABLE_ADMIN_DATABASE_URL;
  return environment;
}

describe("catalog document revision real-DB proof runner", () => {
  it.each([
    ["managed", "CATALOG_DOCUMENT_FOUNDATION_MANAGED_REPLAY_DATABASE_URL"],
    ["portable", "CATALOG_DOCUMENT_FOUNDATION_PORTABLE_ADMIN_DATABASE_URL"],
  ] as const)("fails closed for missing %s replay infrastructure", (bundle, requiredEnvironment) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", RUNNER, `--bundle=${bundle}`], {
      cwd: process.cwd(),
      env: withoutCatalogProofInfrastructure(),
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${requiredEnvironment} is required; this real-DB proof never skips missing infrastructure`);
  });
});
