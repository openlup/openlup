export const stubBrand = {
  name: "Example Core",
  siteOrigin: "https://example.test",
  currency: "USD",
  regionCode: "US",
  timezone: "UTC",
} as const;

export type StubBrand = typeof stubBrand;
