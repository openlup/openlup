import { describe, expect, it } from "vitest";

import { classifyCoreCiScope, classifyMergeGroupCoreCiScope } from "./core-ci-scope.ts";

describe("private core portability CI scope", () => {
  it.each([
    "packages/core/README.md",
    "packages/core/docs/architecture.md",
  ])("routes %s to docs/static checks", (file) => {
    expect(classifyCoreCiScope([file])).toMatchObject({
      core_ci_scope: "docs_static",
      core_docs_static: true,
      core_package_relevant: true,
    });
  });

  it.each([
    "packages/core/src/subscription/index.ts",
    "packages/core/smoke/subscription.test.ts",
    "packages/core/tests/pricing.test.ts",
    "packages/core/vitest.config.ts",
    "packages/core/tsconfig.smoke.json",
  ])("routes %s to package-fast proof", (file) => {
    expect(classifyCoreCiScope([file])).toMatchObject({
      core_ci_scope: "package_fast",
      core_package_fast: true,
      core_package_relevant: true,
    });
  });

  it.each([
    "packages/core/package.json",
    "packages/core/package-lock.json",
    "packages/core/LICENSE",
    "packages/ui/package.json",
    "packages/core/release-gates.json",
    "packages/core/tsconfig.build.json",
    "packages/core/api/subscription.api.md",
    "packages/core/scripts/release-check.ts",
    "packages/core/.github/workflows/ci.yml",
    "scripts/core-package-consumer-smoke.ts",
    "scripts/core-release-candidate-proof.sh",
    "scripts/core-release-identity.test.ts",
    ".github/workflows/pr-ci.yml",
    ".npmrc",
    "config/oss-core-readiness-blockers.json",
    "scripts/control-plane-proof-paths.ts",
    "scripts/control-plane-proof-v2.test.ts",
    "scripts/oss-readiness-axes.ts",
    "scripts/oss-readiness-domain-boundary.ts",
    "src/lib/architectureGuardrails.test.ts",
    "src/lib/coreDomains.ts",
    "package.json",
    "package-lock.json",
    "Dockerfile",
    "LICENSE",
    "tsconfig.app.json",
    "vite.config.ts",
    "vite.public-reference.config.ts",
    "vitest.config.ts",
  ])("routes %s to the full private-portability proof", (file) => {
    expect(classifyCoreCiScope([file])).toMatchObject({
      core_ci_scope: "private_portability_full",
      core_private_portability_full: true,
      core_package_relevant: true,
    });
  });

  it("escalates mixed core scopes to the highest required proof", () => {
    expect(
      classifyCoreCiScope([
        "packages/core/README.md",
        "packages/core/src/pricing/index.ts",
        "packages/core/package.json",
      ]),
    ).toMatchObject({ core_ci_scope: "private_portability_full" });
  });

  it("fails closed for an unknown package path, a deletion, or unavailable diff", () => {
    expect(classifyCoreCiScope(["packages/core/new-control.txt"])).toMatchObject({
      core_ci_scope: "private_portability_full",
    });
    expect(
      classifyCoreCiScope([], { deletedFiles: ["packages/core/README.md"] }),
    ).toMatchObject({ core_ci_scope: "private_portability_full" });
    expect(classifyCoreCiScope([], { unknownFull: true })).toMatchObject({
      core_ci_scope: "private_portability_full",
    });
  });

  it("floors merge groups at package-fast without weakening escalations", () => {
    expect(classifyMergeGroupCoreCiScope(["src/App.tsx", "docs/TESTING.md"])).toMatchObject({
      core_ci_scope: "package_fast",
      core_package_fast: true,
      core_package_relevant: true,
      core_private_portability_full: false,
    });
    expect(classifyMergeGroupCoreCiScope(["packages/core/README.md"])).toMatchObject({
      core_ci_scope: "package_fast",
    });
    expect(classifyMergeGroupCoreCiScope(["package-lock.json"])).toMatchObject({
      core_ci_scope: "private_portability_full",
    });
  });

  it("ignores unrelated product and documentation files", () => {
    expect(classifyCoreCiScope(["src/App.tsx", "docs/TESTING.md"])).toEqual({
      core_ci_scope: "none",
      core_docs_static: false,
      core_package_fast: false,
      core_private_portability_full: false,
      core_package_relevant: false,
    });
  });
});
