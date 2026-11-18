/** An installed historical binding supplies authority; current metadata cannot replace it.
 * @experimental
 */
export interface HistoricalSuccessorProtocolBinding {
  sourceIdentity: string;
  candidateKind: string;
  baseProtocol: string;
  eventKind: string;
  authorityRef: string;
}
export class Lc10ProtocolBindingError extends Error {
  readonly code = "lc10_protocol_binding_unavailable";
  constructor() { super("lc10_protocol_binding_unavailable"); this.name = "Lc10ProtocolBindingError"; }
}
export function requireHistoricalProtocolBinding(
  input: Omit<HistoricalSuccessorProtocolBinding, "authorityRef">,
  installedBindings: readonly HistoricalSuccessorProtocolBinding[],
): HistoricalSuccessorProtocolBinding {
  if (Object.values(input).length !== 4 || Object.values(input).some(value => typeof value !== "string" || value.trim().length === 0)) throw new Lc10ProtocolBindingError();
  const matches = installedBindings.filter(binding => binding.sourceIdentity === input.sourceIdentity
    && binding.candidateKind === input.candidateKind && binding.baseProtocol === input.baseProtocol && binding.eventKind === input.eventKind
    && typeof binding.authorityRef === "string" && binding.authorityRef.trim().length > 0);
  if (matches.length !== 1) throw new Lc10ProtocolBindingError();
  return matches[0]!;
}
