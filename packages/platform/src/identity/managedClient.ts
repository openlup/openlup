import type { SupabaseCreateClient } from "../data/index.js";

export interface ManagedIdentityUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
}
export interface ManagedIdentityRow {
  id: string;
  email?: string | null;
  auth_user_id?: string | null;
  role?: string | null;
  is_machine_actor?: boolean | null;
}
export interface ManagedIdentityQuery extends PromiseLike<{ data: ManagedIdentityRow[] | null; error: unknown }> {
  select(columns: string): ManagedIdentityQuery;
  eq(column: string, value: string): ManagedIdentityQuery;
  filter(column: string, operator: "imatch", value: string): ManagedIdentityQuery;
  is(column: string, value: null): ManagedIdentityQuery;
  order(column: string, options: { ascending: boolean }): ManagedIdentityQuery;
  limit(count: number): ManagedIdentityQuery;
  maybeSingle(): PromiseLike<{ data: ManagedIdentityRow | null; error: unknown }>;
  single(): PromiseLike<{ data: ManagedIdentityRow | null; error: unknown }>;
}
export interface ManagedIdentityTable {
  select(columns: string): ManagedIdentityQuery;
  update(value: Record<string, unknown>): ManagedIdentityQuery;
  insert(value: Record<string, unknown>): ManagedIdentityQuery;
}
/** Only the methods consumed by the identity adapters; the host owns the SDK. */
export interface ManagedIdentityClient {
  from(table: string): ManagedIdentityTable;
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: ManagedIdentityUser | null }; error: unknown }>;
    admin: {
      listUsers(options: { page: number; perPage: number }): PromiseLike<{
        data: { users: ManagedIdentityUser[]; nextPage?: number | null }; error: unknown;
      }>;
      getUserById(id: string): PromiseLike<{ data: { user: ManagedIdentityUser | null }; error: unknown }>;
      createUser(input: { email: string; email_confirm: boolean }): PromiseLike<{ data: { user: ManagedIdentityUser | null }; error: unknown }>;
    };
  };
}

export function createManagedIdentityClients(createClient: SupabaseCreateClient) {
  const actor = (env: { url: string; anonKey: string }, accessToken: string | null): ManagedIdentityClient =>
    createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
    }) as ManagedIdentityClient;
  const service = (env: { url: string; serviceRoleKey: string }): ManagedIdentityClient =>
    createClient(env.url, env.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as ManagedIdentityClient;
  return { actor, service };
}
