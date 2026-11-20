export function categoryDocument() {
  return {
    schemaVersion: "example.product-document.v2" as const,
    id: "example:measurements",
    revisionNo: 1,
    productSlug: "article",
    name: "Synthetic article",
    analysis: { density: 100, ratioA: 80, ratioB: 50, scoreA: 10, scoreB: 20 },
    additions: [{ quantity: { unscaled: 1, scale: 4, unit: "POINTS" as const } }],
  };
}
