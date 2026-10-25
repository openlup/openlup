/** Applied business transitions, rather than webhook hints, identify the failure. */
export async function resolveDunningEventAttempt(client: unknown, eventId: string, intentId: string): Promise<string> {
  type Query = PromiseLike<{ data: unknown; error: unknown }> & {
    eq(column: string, value: string): Query;
  };
  const source = client as { from?: (table: string) => { select(columns: string): Query } };
  if (typeof source.from !== "function") throw new Error("subscription_webhook_dunning_attempt_unattributed");
  const { data, error } = await source.from("commerce_payment_state_transitions")
    .select("payment_attempt_id,to_status")
    .eq("provider_event_id", eventId)
    .eq("payment_intent_id", intentId)
    .eq("transition_kind", "business_result");
  if (error) throw new Error("subscription_webhook_dunning_attempt_lookup_failed");
  if (!Array.isArray(data) || data.length === 0) throw new Error("subscription_webhook_dunning_attempt_unattributed");
  const attempts = new Set<string>();
  for (const row of data) {
    if (!row || typeof row.payment_attempt_id !== "string" ||
      !["failed", "expired"].includes(row.to_status)) {
      throw new Error("subscription_webhook_dunning_attempt_unattributed");
    }
    attempts.add(row.payment_attempt_id);
  }
  if (attempts.size !== 1) throw new Error("subscription_webhook_dunning_attempt_ambiguous");
  return [...attempts][0]!;
}
