/** Host admission must complete before any accounting lease or module factory. */
export async function readInvoicingReferenceReadiness(input: {
  enabled?: boolean;
  readiness(): Promise<{ readonly kind: string; readonly code?: string }>;
}) {
  if (input.enabled !== true) return { kind: "refused", code: "disabled" } as const;
  return input.readiness();
}
