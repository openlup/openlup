import { describe, expect, it } from "vitest";
import {
  HOSTED_CLIENT_ADDRESS_HEADER,
  HOSTED_CRON_SCHEDULE_HEADER,
  HOSTED_DEPLOYMENT_URL_ENV_KEY,
  HOSTED_MANUAL_TRIGGER_SOURCE,
  HOSTED_RELEASE_SHA_ENV_KEY,
  HOSTED_REQUEST_ID_HEADER,
  HOSTED_RUNTIME_MARKER_KEY,
  HOSTED_SCHEDULED_TRIGGER_SOURCE,
  isHostedRequestId,
  readHostedClientAddress,
  readHostedCronProvenance,
  readHostedRequestId,
  readHostedRuntimeCompatibility,
} from "./runtimeProvenance.js";
import { readRuntimeProvenance } from "../../_lib/observability/runtimeProvenance.js";

describe("host runtime provenance adapter", () => {
  it("preserves valid release metadata as compatibility output", () => {
    const compatibility = readHostedRuntimeCompatibility({
      [HOSTED_RELEASE_SHA_ENV_KEY]: "hosted-release",
      [HOSTED_DEPLOYMENT_URL_ENV_KEY]: "preview.example.test/path",
    });
    expect(compatibility).toEqual({
      releaseSha: "hosted-release",
      deploymentUrl: "https://preview.example.test",
    });
    expect(readRuntimeProvenance({ SSG_BUILD_SHA: "ssg-release", GITHUB_SHA: "github-release" }, compatibility)).toEqual({
      releaseSha: "hosted-release",
      deploymentUrl: "https://preview.example.test",
    });
  });

  it("gives neutral inputs authority and fails invalid explicit values null", () => {
    expect(readRuntimeProvenance({
      APP_RELEASE_SHA: "node-release",
      APP_DEPLOYMENT_URL: "https://node.example.test/candidate",
    }, readHostedRuntimeCompatibility({
      [HOSTED_RELEASE_SHA_ENV_KEY]: "hosted-release",
      [HOSTED_DEPLOYMENT_URL_ENV_KEY]: "preview.example.test",
    }))).toEqual({ releaseSha: "node-release", deploymentUrl: "https://node.example.test" });
    expect(readRuntimeProvenance({
      APP_RELEASE_SHA: "not safe",
      APP_DEPLOYMENT_URL: "https://user:password@node.example.test",
    }, readHostedRuntimeCompatibility({
      [HOSTED_RELEASE_SHA_ENV_KEY]: "hosted-release",
      [HOSTED_DEPLOYMENT_URL_ENV_KEY]: "preview.example.test",
    }))).toEqual({ releaseSha: null, deploymentUrl: null });
  });

  it("extracts request provenance only for this host runtime", () => {
    const headers = { [HOSTED_REQUEST_ID_HEADER]: "iad1::sfo1::edge-request" };
    expect(readHostedRequestId(headers, { [HOSTED_RUNTIME_MARKER_KEY]: "1" }))
      .toBe("iad1::sfo1::edge-request");
    expect(readHostedRequestId(headers, {})).toBeNull();
    expect(readHostedRequestId({ [HOSTED_REQUEST_ID_HEADER]: "buyer@example.com token=secret" }, {
      [HOSTED_RUNTIME_MARKER_KEY]: "1",
    })).toBeNull();
  });

  it("reads the platform client address only inside this host runtime", () => {
    const headers = { [HOSTED_CLIENT_ADDRESS_HEADER]: " 198.51.100.77 " };
    expect(readHostedClientAddress(headers, { [HOSTED_RUNTIME_MARKER_KEY]: "1" })).toBe("198.51.100.77");
    expect(readHostedClientAddress(headers, {})).toBeNull();
    expect(readHostedClientAddress({}, { [HOSTED_RUNTIME_MARKER_KEY]: "1" })).toBeNull();
  });

  it("recognises its own request carrier as a reference only inside this host runtime", () => {
    expect(isHostedRequestId("iad1::sfo1::edge-request", { [HOSTED_RUNTIME_MARKER_KEY]: "1" })).toBe(true);
    expect(isHostedRequestId("iad1::sfo1::edge-request", {})).toBe(false);
    for (const value of ["buyer@example.com token=secret", "", 42, null]) {
      expect(isHostedRequestId(value, { [HOSTED_RUNTIME_MARKER_KEY]: "1" })).toBe(false);
    }
  });

  it("maps the host schedule carrier to neutral cron metadata", () => {
    expect(readHostedCronProvenance({ [HOSTED_CRON_SCHEDULE_HEADER]: "*/30 6-20 * * *" }))
      .toEqual({ triggerSource: HOSTED_SCHEDULED_TRIGGER_SOURCE, cronSchedule: "*/30 6-20 * * *" });
    expect(readHostedCronProvenance({}))
      .toEqual({ triggerSource: HOSTED_MANUAL_TRIGGER_SOURCE, cronSchedule: null });
  });
});
