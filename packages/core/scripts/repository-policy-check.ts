import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Manifest, type RepositoryPolicy } from "./repository-policy-contract.ts";

export function verifyRepositoryPolicy(input: {
  packageRoot: string;
  manifest: Manifest;
}): void {
  const { packageRoot, manifest } = input;
  const policy = readJson<RepositoryPolicy>(packageRoot, "repository-policy.json");
  const expectedChecks = ["Core CI / verify", "Core CI / gitleaks"];
  const expectedCodeowners = `* ${policy.ownership?.codeOwners?.join(" ")}`;
  const workflow = readText(packageRoot, ".github/workflows/ci.yml");
  const dependabot = readText(packageRoot, ".github/dependabot.yml");

  assert(policy.schemaVersion === 5, "unsupported repository-policy.json schema");
  assert(
    policy.repository?.packageName === "@openlup/core" &&
      policy.repository.currentPhase === "private-portability-proof" &&
      policy.repository.packageVisibility === "private" &&
      manifest.private === true,
    "core must remain a private portability proof",
  );
  assert(
    policy.repository.activation?.target === "platform-monorepo-phase-5" &&
      policy.repository.activation.separateRepositoryActivation === "forbidden" &&
      policy.repository.activation.publicSourceOpening === "phase-5-only",
    "core activation must remain deferred to the phase-5 platform monorepo",
  );
  assert(
    policy.localGovernance?.pullRequestsRequired === true &&
      isDeepStrictEqual(policy.localGovernance.requiredStatusChecks, expectedChecks) &&
      policy.localGovernance.mergeMethods?.squash === true &&
      policy.localGovernance.mergeMethods.mergeCommit === false &&
      policy.localGovernance.mergeMethods.rebase === false &&
      policy.localGovernance.allowForcePushes === false &&
      policy.localGovernance.allowDeletions === false &&
      Array.isArray(policy.localGovernance.bypassActors) &&
      policy.localGovernance.bypassActors.length === 0,
    "local package governance drifted",
  );
  assert(
    policy.ownership?.codeOwnerReviewRequired === false &&
      policy.ownership.rationale === "sole-maintainer" &&
      isDeepStrictEqual(policy.ownership.codeOwners, ["@broszkowski"]),
    "package ownership policy drifted",
  );
  assert(
    readText(packageRoot, ".github/CODEOWNERS").trim() === expectedCodeowners,
    "CODEOWNERS differs from repository policy",
  );
  assert(
    policy.security?.scanning?.required === true &&
      policy.security.scanning.workflowCheck === "Core CI / gitleaks" &&
      policy.security.scanning.tool === "gitleaks" &&
      policy.security.scanning.pinnedVersion === "8.30.1" &&
      policy.security.scanning.checksumVerified === true,
    "repository policy must require pinned checksum-verified gitleaks scanning",
  );
  assert(workflow.includes("name: Core CI"), "Core CI workflow name drifted");
  assert(workflow.includes("gitleaks:"), "Core CI must include a gitleaks job");
  assert(
    workflow.includes(
      'EXPECTED_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"',
    ),
    "gitleaks checksum drifted",
  );
  assert(
    workflow.includes('gitleaks" git . --redact --no-banner'),
    "Core CI must scan repository history with gitleaks",
  );
  assert(
    policy.security?.dependabot?.required === true &&
      isDeepStrictEqual(policy.security.dependabot.ecosystems, ["npm", "github-actions"]),
    "repository policy must require npm and GitHub Actions Dependabot updates",
  );
  for (const ecosystem of policy.security.dependabot.ecosystems) {
    assert(
      dependabot.includes(`package-ecosystem: ${ecosystem}`),
      `Dependabot config is missing ${ecosystem}`,
    );
  }
  assert(
    policy.localProofToolchain?.node === "24.20.0" &&
      policy.localProofToolchain.npm === "11.19.0",
    "local package proof toolchain drifted",
  );
  console.log("private package policy and local security automation ok");
}

function readJson<Parsed>(packageRoot: string, path: string): Parsed {
  return JSON.parse(readFileSync(resolveInsidePackage(packageRoot, path), "utf8")) as Parsed;
}

function readText(packageRoot: string, path: string): string {
  return readFileSync(resolveInsidePackage(packageRoot, path), "utf8");
}

function resolveInsidePackage(packageRoot: string, path: string): string {
  const absolute = resolve(packageRoot, path);
  assert(
    absolute === packageRoot || absolute.startsWith(`${packageRoot}${sep}`),
    `path escapes package root: ${path}`,
  );
  return absolute;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
