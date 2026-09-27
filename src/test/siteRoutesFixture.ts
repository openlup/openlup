// Synthetic adopter routes for route-manifest contracts; the public reference
// deliberately does not install an adopter's storefront or legacy redirects.
export const siteRoutes = ["/", "/contact", "/privacy", "/psy/jagniecina", "/rasy/maltanczyk", "/dogs/lamb", "/dogs/venison/nutrition"].map((path, index) => ({
  id: `fixture-${index}`, path, locale: "pl", delivery: "ssg",
  htmlLang: "pl", ogLocale: "pl_PL", seoPath: ["fixture"], ogImageSlug: "fixture",
}));

export const siteRedirects = [
  { source: "/en/how-it-works", destination: "/how-it-works" },
  { source: "/en/terms", destination: "/terms" },
  ...["/darmowe-probki", "/darmowe-probki/dziekujemy"].map((source) => ({ source, destination: "/waitlist" })),
  ...["/free-samples", "/free-samples/thank-you", "/en/free-samples", "/en/free-samples/thank-you"].map((source) => ({ source, destination: "/waitlist-en" })),
  { source: "/en/dogs/:path*", destination: "/dogs/:path*", clientPrefix: { from: "/en/dogs/", to: "/dogs/" } },
].map((redirect) => ({ ...redirect, permanent: true }));
