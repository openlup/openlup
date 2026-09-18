import { describe, expect, it } from "vitest";
import {
  APPLICATION_DEPLOYMENT_URL_KEY,
  APPLICATION_RELEASE_SHA_KEY,
  readRuntimeProvenance,
  resolveRuntimeProvenance,
} from "./runtimeProvenance.js";

describe("resolveRuntimeProvenance", () => {
  it("owns the canonical external application provenance key names", () => {
    expect(APPLICATION_RELEASE_SHA_KEY).toBe("APP_RELEASE_SHA");
    expect(APPLICATION_DEPLOYMENT_URL_KEY).toBe("APP_DEPLOYMENT_URL");
    expect(readRuntimeProvenance({
      [APPLICATION_RELEASE_SHA_KEY]: "release-1",
      [APPLICATION_DEPLOYMENT_URL_KEY]: "https://node.example.test/path",
    })).toEqual({ releaseSha: "release-1", deploymentUrl: "https://node.example.test" });
  });

  it("normalizes provider-neutral primary values before compatibility values", () => {
    expect(resolveRuntimeProvenance({
      appReleaseSha: " release:2026.08.20 ",
      appDeploymentUrl: "https://node.example.test/path?trace=1#fragment",
      compatibilityReleaseSha: "hosted-release",
      compatibilityDeploymentUrl: "https://compat.example.test",
    })).toEqual({
      releaseSha: "release:2026.08.20",
      deploymentUrl: "https://node.example.test",
    });
  });

  it.each([
    ["release identifier", { appReleaseSha: "release sha", compatibilityReleaseSha: "hosted-release" }],
    ["oversized release identifier", { appReleaseSha: `a${"b".repeat(128)}`, compatibilityReleaseSha: "hosted-release" }],
    ["credential-bearing URL", { appDeploymentUrl: "https://user:password@node.example.test", compatibilityDeploymentUrl: "https://compat.example.test" }],
    ["non-HTTP URL", { appDeploymentUrl: "ftp://node.example.test", compatibilityDeploymentUrl: "https://compat.example.test" }],
  ])("refuses invalid explicit %s without compatibility fallback", (_label, input) => {
    const provenance = resolveRuntimeProvenance(input);
    if ("appReleaseSha" in input) expect(provenance.releaseSha).toBeNull();
    if ("appDeploymentUrl" in input) expect(provenance.deploymentUrl).toBeNull();
  });

  it("uses compatibility, SSG, and GitHub only when primaries are missing or blank", () => {
    expect(resolveRuntimeProvenance({
      appReleaseSha: " ",
      appDeploymentUrl: "",
      compatibilityReleaseSha: "hosted-release",
      compatibilityDeploymentUrl: "https://preview.example.test/path",
      ssgBuildSha: "ssg-release",
      githubSha: "github-release",
    })).toEqual({
      releaseSha: "hosted-release",
      deploymentUrl: "https://preview.example.test",
    });
    expect(resolveRuntimeProvenance({ ssgBuildSha: "ssg-release", githubSha: "github-release" })).toEqual({
      releaseSha: "ssg-release",
      deploymentUrl: null,
    });
    expect(resolveRuntimeProvenance({ githubSha: "github-release" })).toEqual({
      releaseSha: "github-release",
      deploymentUrl: null,
    });
  });
});
