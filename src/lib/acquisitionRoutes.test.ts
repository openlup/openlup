import { describe, expect, it } from "vitest";

import { publicAcquisitionPath, publicAcquisitionRouteKey } from "@/lib/acquisitionRoutes";

describe("acquisition routes", () => {
  it("routes public acquisition CTAs to the waitlist while hidden surfaces are off", () => {
    expect(publicAcquisitionRouteKey({})).toBe("waitlist");
    expect(publicAcquisitionPath("pl", {})).toBe("/waitlist");
    expect(publicAcquisitionPath("en", {})).toBe("/waitlist-en");
  });

  it("routes acquisition CTAs to the configurator only inside hidden preview", () => {
    const env = { VITE_PUBLIC_HIDDEN_SURFACES_ENABLED: "true" };

    expect(publicAcquisitionRouteKey(env)).toBe("configurator");
    expect(publicAcquisitionPath("pl", env)).toBe("/skomponuj-pakiet");
    expect(publicAcquisitionPath("en", env)).toBe("/build-your-box");
  });
});
