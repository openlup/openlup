/** @type {import('@openlup/platform/catalog').CatalogPublicationRulesModule} */
module.exports = {
  validateContent(content) {
    const publication = content?.schemaVersion === 1 && content?.presentation !== undefined;
    const title = publication ? content.presentation?.title : content?.title;
    return typeof title === 'string' && title.trim()
      ? [] : [{ path: publication ? 'presentation.title' : 'title', code: 'title_required' }];
  },
  validateProduct: () => [],
  identifyDocument(value) {
    if (!value || typeof value.schemaId !== 'string' || typeof value.documentRef !== 'string'
      || typeof value.productSlug !== 'string' || !Number.isSafeInteger(value.revisionNo)) return null;
    const { schemaId, documentRef, productSlug, revisionNo, name } = value;
    return { schemaId, documentRef, productSlug, revisionNo, ...(typeof name === 'string' ? { name } : {}) };
  },
  inspectDocument(text) {
    let value;
    try { value = JSON.parse(text); } catch { return null; }
    const identity = this.identifyDocument(value);
    return identity && { ...identity, canonicallyEncoded: canonical(value) === text };
  },
  matchesDocument: (value, text) => canonical(value) === text,
  deriveSkuFacts: () => ({}),
  classifySkuChange: () => 'inconclusive',
};

function canonical(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
    : entry);
}
