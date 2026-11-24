export async function runCatalogueSchema(emit) {
  // eslint-disable-next-line no-restricted-syntax -- the installed CLI reads its private report module
  const { describeCatalogueSchema } = await import("#catalog/schema");
  const report = describeCatalogueSchema();
  const table = ["Name          Describes",
    "productType   Product type definition",
    "productInput  Product input for the release draft builder",
    "draftV3       Schema version 3 draft payload"].join("\n");
  emit(report, `${table}\n\nUse --json for the full grammar`);
}
