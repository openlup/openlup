/**
 * The per-item FAQ contract. The questions and answers are a deployment's copy
 * and stay with it (`src/data/productFaqs.ts`); the entry shape is the same for
 * every adopter and is rendered by publishable surfaces (the FAQ section and the
 * `FAQPage` JSON-LD builder), so it lives here.
 */
export interface ProductFaq {
  q: string;
  a: string;
}
