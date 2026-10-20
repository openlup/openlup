import { z } from "../../lib/validation/zod.js";
/** Current installation diagnostics; never merge these into the managed historical send list. */
export const nativeEvidenceSchema = z.object({
  binding: z.string(), candidate: z.string(), schema: z.string(),
  sends: z.array(z.object({ id:z.string(), sourceKey:z.string(), messageId:z.string(), observedState:z.enum(["sent","delayed","delivered","bounced","complained","failed"]).nullable(), abandonedAt:z.string().nullable() })),
  sync: z.array(z.object({id:z.string(),status:z.string()})),
  decisions: z.array(z.object({id:z.string(),allowed:z.boolean(),reason:z.string()})),
});
export type NativeEvidence = z.infer<typeof nativeEvidenceSchema>;
