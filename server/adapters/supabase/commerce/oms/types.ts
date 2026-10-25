import type { CommerceOmsRpcClient,CommerceOmsStore,ManagedQueryBuilder } from "@openlup/platform/commerce/contracts";
export { distinctIds } from "@openlup/platform/commerce/server";
export type { RpcError,ManagedQueryBuilder as SupabaseQueryBuilder,ManagedQueryResult as SupabaseQueryResult } from "@openlup/platform/commerce/contracts";
export interface CommerceOmsClient extends CommerceOmsRpcClient { from(table: string): ManagedQueryBuilder }
export type CommerceOmsSupabaseClient = CommerceOmsClient;
export function omsManagedStore(client: CommerceOmsClient): CommerceOmsStore { return { query: table => client.from(table), rpc: (name, args) => client.rpc(name, args) }; }
