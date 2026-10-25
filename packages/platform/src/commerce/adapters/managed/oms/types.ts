export type { CommerceOmsRpcClient,CommerceOmsStore,ManagedQueryBuilder,ManagedQueryResult,RpcError } from "../../../contracts/omsTypes.js";

// Every read in this directory fans out to a follow-up query keyed on ids it just
// collected, so all three needed the same two steps: drop the rows that carry no
// id, and ask for each id once. `compact` was the wrong name for that - it also
// de-duplicates, which the trim-only helpers elsewhere deliberately do not.
export function distinctIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
