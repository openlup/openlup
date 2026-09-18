import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(resolve(packageRoot, "repository-policy.json"), "utf8"));
const workflow = readFileSync(resolve(packageRoot, ".github/workflows/ci.yml"), "utf8");
const dependabot = readFileSync(resolve(packageRoot, ".github/dependabot.yml"), "utf8");
const codeowners = readFileSync(resolve(packageRoot, ".github/CODEOWNERS"), "utf8").trim();

describe("private package policy", () => {
  it("keeps core a private portability proof rather than an activatable separate repository", () => {
    expect(policy).toMatchObject({
      schemaVersion: 5,
      repository: {
        packageName: "@openlup/core",
        currentPhase: "private-portability-proof",
        packageVisibility: "private",
        activation: {
          target: "platform-monorepo-phase-5",
          separateRepositoryActivation: "forbidden",
          publicSourceOpening: "phase-5-only",
        },
      },
      localGovernance: {
        pullRequestsRequired: true,
        requiredStatusChecks: ["Core CI / verify", "Core CI / gitleaks"],
        mergeMethods: { squash: true, mergeCommit: false, rebase: false },
        allowForcePushes: false,
        allowDeletions: false,
        bypassActors: [],
      },
      ownership: {
        codeOwners: ["@broszkowski"],
        codeOwnerReviewRequired: false,
        rationale: "sole-maintainer",
      },
      security: {
        scanning: {
          required: true,
          workflowCheck: "Core CI / gitleaks",
          tool: "gitleaks",
          pinnedVersion: "8.30.1",
          checksumVerified: true,
        },
        dependabot: { required: true, ecosystems: ["npm", "github-actions"] },
      },
      localProofToolchain: { node: "24.20.0", npm: "11.19.0" },
    });
    expect(JSON.stringify(policy)).not.toContain("releasePolicyReadCredential");
    expect(JSON.stringify(policy)).not.toContain("immutableReleases");
    expect(JSON.stringify(policy)).not.toContain("fresh-history");
  });

  it("keeps package-local security automation aligned with the policy", () => {
    expect(codeowners).toBe(`* ${policy.ownership.codeOwners.join(" ")}`);
    expect(workflow).toContain("name: Core CI");
    expect(workflow).toContain("gitleaks:");
    expect(workflow).toContain('EXPECTED_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"');
    expect(workflow).toContain('gitleaks" git . --redact --no-banner');
    for (const ecosystem of policy.security.dependabot.ecosystems) {
      expect(dependabot).toContain(`package-ecosystem: ${ecosystem}`);
    }
  });

  it("runs the private package policy check", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "./scripts/release-check.ts", "repository-policy"],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("private package policy and local security automation ok");
  });
});
