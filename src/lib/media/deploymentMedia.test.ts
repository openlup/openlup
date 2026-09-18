import { describe, expect, it } from "vitest";

import * as platformOwner from "./exampleDeploymentMedia.js";
import { DEPLOYMENT_MEDIA_ROLES } from "./deploymentMedia.js";

// Named exports give the bundler per-role tree-shaking, but they also mean the
// compiler only notices a MISSING role at the one page that imports it. These
// cases hold an owner to the whole contract instead, so a role added to
// `DEPLOYMENT_MEDIA_ROLES` cannot reach a page as `undefined` - which renders as
// a broken image rather than as anything a test would catch.
describe("platform deployment media owner", () => {
  it("answers every declared role and nothing else", () => {
    expect(Object.keys(platformOwner).sort()).toEqual([...DEPLOYMENT_MEDIA_ROLES].sort());
  });

  it("resolves every role to a non-empty asset URL", () => {
    for (const role of DEPLOYMENT_MEDIA_ROLES) {
      const url: unknown = (platformOwner as Record<string, unknown>)[role];
      expect(typeof url, `${role} must resolve to a URL`).toBe("string");
      expect(url as string, `${role} must not resolve to an empty URL`).not.toBe("");
    }
  });

  it("serves the platform's own media, never a deployment overlay", () => {
    for (const role of DEPLOYMENT_MEDIA_ROLES) {
      expect((platformOwner as Record<string, string>)[role], `${role} must not come from an overlay`)
        .not.toMatch(/overlays|assets\/(?!.*platform)/);
    }
  });
});
