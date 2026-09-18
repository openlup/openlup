import { z } from "../validation/zod.js";

export const bffDomainSchema = z.enum([
  "clients",
  "tester-program",
  "marketing",
  "communications",
  "fulfillment",
  "feedback",
  "catalog",
  "commerce",
  "partners",
  "platform",
]);

const SAFE_RELEASE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const bffHealthDataSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("openlup-bff"),
  contractVersion: z.literal("2026-05-29.wave-2"),
  domains: z.array(bffDomainSchema),
  releaseSha: z.string().regex(SAFE_RELEASE_IDENTIFIER).nullable(),
  deploymentUrl: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username && !url.password && value === url.origin;
    } catch {
      return false;
    }
  }).nullable(),
  emailPresentationId: z.string().min(1),
}).strict();

export type BffHealthData = z.infer<typeof bffHealthDataSchema>;

export const BFF_DOMAINS: BffHealthData["domains"] = [
  "clients",
  "tester-program",
  "marketing",
  "communications",
  "fulfillment",
  "feedback",
  "catalog",
  "commerce",
  "partners",
  "platform",
];
