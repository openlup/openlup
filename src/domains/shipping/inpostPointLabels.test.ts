import { describe, expect, it } from "vitest";
import {
  INPOST_APP_ASSISTED_NOTICE,
  formatDistance,
  inpostAppAssistedNotice,
  inpostBrandLabel,
} from "./inpostPointLabels";

describe("InPost display obligations", () => {
  it("labels a locker as Paczkomat, with the registered trademark symbol", () => {
    // The ® is part of the mandated string; it looks like lint noise and will
    // be "tidied away" sooner or later. This test is why that fails.
    expect(inpostBrandLabel({ pointKind: "locker" })).toBe("Paczkomat®");
  });

  it("labels a service point as PaczkoPunkt", () => {
    expect(inpostBrandLabel({ pointKind: "service_point" })).toBe("PaczkoPunkt");
  });

  it("leaves an unrecognized point unlabelled rather than guessing a brand", () => {
    // Omitting the label is permitted; showing the wrong brand is a breach.
    expect(inpostBrandLabel({ pointKind: null })).toBeNull();
  });

  it("discloses that an Appkomat needs the InPost app, verbatim", () => {
    expect(inpostAppAssistedNotice({ appAssisted: true })).toBe(INPOST_APP_ASSISTED_NOTICE);
    expect(INPOST_APP_ASSISTED_NOTICE).toBe(
      "Ważne! Swoją paczkę odbierzesz wygodniej z aplikacją InPost",
    );
  });

  it("shows no notice for an ordinary locker", () => {
    expect(inpostAppAssistedNotice({ appAssisted: false })).toBeNull();
  });
});

describe("formatDistance", () => {
  it("keeps a walking distance in metres", () => {
    // These used to read "0.1 km", "0.3 km" and — for a locker across the
    // street — "0.0 km", which looks like a null rather than the best hit.
    expect(formatDistance(57)).toBe("57 m");
    expect(formatDistance(20)).toBe("20 m");
    expect(formatDistance(263)).toBe("260 m");
    expect(formatDistance(312.4)).toBe("310 m");
    expect(formatDistance(999)).toBe("1000 m");
  });

  it("switches to kilometres past a kilometre", () => {
    expect(formatDistance(1000)).toBe("1,0 km");
    expect(formatDistance(18_400)).toBe("18,4 km");
  });

  it("uses the reader's decimal separator, which toFixed cannot", () => {
    // toFixed always emits a dot, so Polish customers read "18.4 km".
    expect(formatDistance(18_400, "pl")).toBe("18,4 km");
    expect(formatDistance(18_400, "en")).toBe("18.4 km");
  });

  it("renders nothing when the search had no relative point", () => {
    // A city search returns no `distance`; the badge must disappear, not read NaN.
    expect(formatDistance(null)).toBeNull();
    expect(formatDistance(Number.NaN)).toBeNull();
  });
});
