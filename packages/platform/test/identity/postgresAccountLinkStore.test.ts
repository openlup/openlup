import { expect, it, vi } from "vitest";
const { query, close, run, guard } = vi.hoisted(() => {
  const query = vi.fn(); const guard = vi.fn(async (_sql: string, _params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] })); const close = vi.fn();
  return { query, close, guard, run: vi.fn(async (work: (db: unknown) => Promise<unknown>) => work({ query: (sql: string, params?: unknown[]) => sql.startsWith("LOCK TABLE") || sql.startsWith("SELECT 1 FROM public.identity_privacy_erasures") ? guard(sql, params) : query(sql, params) })) };
});
vi.mock("../../src/data/index.js", () => ({ createPostgresRoleFreeTransactionLane: () => ({ run, close }) }));
import { createPostgresAccountLinkStore } from "../../src/identity/postgresAccountLinkStore.js";
const id = "11111111-1111-4111-8111-111111111111", principal = "22222222-2222-4222-8222-222222222222";
const fixture = () => { query.mockReset(); guard.mockReset().mockResolvedValue({ rows: [] }); run.mockClear(); return createPostgresAccountLinkStore({ connectionString: "postgresql://example.invalid/test" }); };
it("normalized_email_lookup_is_bounded_and_ambiguous_matches_refuse", async () => {
  const store = fixture(); query.mockResolvedValueOnce({ rows: [{ id, email: "customer@example.com", principal_id: null }] });
  expect(await store.findAccountByEmail(" Customer@Example.com ")).toEqual({ id, email: "customer@example.com", principalId: null });
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("lower(btrim(email)) = $1 LIMIT 2"), ["customer@example.com"]);
  query.mockResolvedValueOnce({ rows: [{ id }, { id: principal }] });
  await expect(store.findAccountByEmail("customer@example.com")).rejects.toThrow("account_normalized_email_ambiguous");
});
it("concurrent_conditional_link_never_overwrites_an_existing_principal", async () => {
  const store = fixture(); query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ principal_id: id }] });
  expect(await store.linkPrincipalToAccount(id, principal)).toEqual({ ok: false, existingPrincipalId: id });
  expect(query.mock.calls[0]).toEqual([expect.stringContaining("AND principal_id IS NULL"), [id, principal]]);
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ principal_id: principal }] });
  expect(await store.linkPrincipalToAccount(id, principal)).toEqual({ ok: true, alreadyLinked: true });
  query.mockResolvedValueOnce({ rows: [{ id }] });
  expect(await store.linkPrincipalToAccount(id, principal)).toEqual({ ok: true, alreadyLinked: false });
});
it("principal_and_machine_lookups_use_existing_authority", async () => {
  const store = fixture(); query.mockResolvedValueOnce({ rows: [{ id, email: "customer@example.com", principal_id: principal }] });
  expect((await store.findAccountByPrincipalId(principal))?.principalId).toBe(principal);
  query.mockResolvedValueOnce({ rows: [{ present: 1 }] }); expect(await store.isReservedPrincipal(principal)).toBe(true);
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("public.platform_control_operators"), [principal]);
});
it("create_conflict_and_failed_writes_preserve_error_without_compensation", async () => {
  const store = fixture(); const error = Object.assign(new Error("synthetic conflict"), { code: "23505" }); query.mockRejectedValueOnce(error);
  await expect(store.createAccount({ email: "customer@example.com", principalId: principal, acquisitionSource: "example", lifecycleStage: "lead" })).rejects.toBe(error);
  expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toContain("INSERT INTO public.clients");
  query.mockRejectedValueOnce(error); await expect(store.linkPrincipalToAccount(id, principal)).rejects.toBe(error);
  expect(query).toHaveBeenCalledTimes(2); await store.close(); expect(close).toHaveBeenCalled();
});

it("erased_principals_cannot_be_recreated_or_relinked", async () => {
  const store = fixture();
  guard.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ present: 1 }] });
  await expect(store.createAccount({ email: "customer@example.com", principalId: principal, acquisitionSource: "example", lifecycleStage: "lead" })).rejects.toThrow("account_erased_refused");
  expect(query).not.toHaveBeenCalled();
  expect(guard.mock.calls[0][0]).toBe("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
});
