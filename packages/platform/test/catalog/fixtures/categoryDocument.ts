import { z } from "../../../src/catalog/validation.js";

export const analysisKeys = ["density", "ratioA", "ratioB", "scoreA", "scoreB"] as const;
const analysisValue = z.number().int().min(0).max(10_000);
export const categoryDocumentSchema = z.object({
  schemaVersion: z.literal("example.product-document.v2"),
  id: z.string().min(1),
  revisionNo: z.number().int().positive(),
  productSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
  name: z.string().min(1),
  analysis: z.object({ density: analysisValue, ratioA: analysisValue, ratioB: analysisValue,
    scoreA: analysisValue, scoreB: analysisValue }).strict(),
  additions: z.array(z.object({ quantity: z.object({
    unscaled: z.number().int().positive(), scale: z.number().int().min(0).max(4), unit: z.literal("POINTS"),
  }).strict() }).strict()).max(100),
}).strict();
