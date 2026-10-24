/**
 * Late delivery extends the next cycle, never stacks deliveries or moves it earlier.
 * A replacement may settle alignment as aligned only after reaching the customer.
 * Its superseded predecessor is no longer outstanding; an in-flight or undelivered
 * replacement still is. Never call subscription_delivery_alignment_confirm_replacement
 * for a replacement that did not arrive: it records "Parcel delivered" and shifts
 * the cycle later. That note-only operator attestation remains outside this port;
 * no automatic caller or new guard is introduced.
 */
export interface DeliveryAlignmentPort {
  recordArrival(input: { requestKey: string; parcelRef: string; deliveredAt: string; evidenceRef: `evidence:${string}` }): Promise<{ disposition: "aligned" | "outstanding" | "manual_review"; nextCycleAt: string | null; replayed: boolean }>;
  read(fulfillmentRef: string): Promise<{ disposition: "aligned" | "outstanding" | "manual_review"; nextCycleAt: string | null }>;
}
