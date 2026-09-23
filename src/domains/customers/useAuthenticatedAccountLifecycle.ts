import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

export type AccountLoadState = "idle" | "loading" | "ready" | "unavailable";
export type AccountLifecycleCode = "observed" | "succeeded" | "refresh_failed" | "rejected" | "failed" | "unknown" | "timeout" | "transport_uncertain";

export type AccountLifecycleEvent<TAction extends string> = {
  action: TAction;
  phase: "attempted" | "settled" | "refresh_started" | "refresh_settled";
  code: AccountLifecycleCode;
  clientActionKey: string | null;
  relatedRequestId?: string;
};

export type AccountRefreshResult = {
  /** A resolved invalidation counts as success even if Query holds a read error. */
  ok: boolean;
  read: "succeeded" | "stored_error" | "failed" | "skipped";
};

export type AccountMutationResult = {
  ok: boolean;
  write: "succeeded" | "failed" | "skipped";
  read: AccountRefreshResult["read"] | "not_attempted";
};

export function useAuthenticatedAccountLifecycle<TAccount, TAction extends string>({
  accessToken,
  principalId,
  queryKey,
  readAccount,
  staleTime,
  refetchInterval,
  defaultAction,
  refreshAction,
  createActionKey,
  onEvent,
  classifyWriteError,
  relatedRequestId,
  onWriteError,
  onRefreshError,
  onRefreshResolved,
}: {
  accessToken: string | null;
  principalId: string | null;
  /** The host owns cache identity; never include an access token. */
  queryKey: QueryKey;
  readAccount: (accessToken: string) => Promise<TAccount>;
  staleTime: number;
  refetchInterval?: (account: TAccount | undefined) => number | false;
  defaultAction: TAction;
  refreshAction: TAction;
  createActionKey?: () => string | null;
  /** Observations contain no token or account data. Callback failures are ignored. */
  onEvent?: (event: AccountLifecycleEvent<TAction>) => void;
  classifyWriteError?: (error: unknown) => AccountLifecycleCode;
  relatedRequestId?: (error: unknown) => string | undefined;
  onWriteError?: (error: unknown) => void;
  onRefreshError?: (error: unknown) => void;
  onRefreshResolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const enabled = Boolean(accessToken && principalId);
  const query = useQuery<TAccount>({
    queryKey,
    queryFn: () => readAccount(accessToken as string),
    enabled,
    staleTime,
    refetchInterval: (current) => refetchInterval?.(current.state.data) ?? false,
    refetchOnWindowFocus: "always",
  });
  const account = query.data ?? null;
  const loadState: AccountLoadState = !enabled
    ? "idle"
    : account !== null
      ? "ready"
      : query.isError
        ? "unavailable"
        : "loading";

  function actionKey(): string | null {
    try { return createActionKey?.() ?? null; } catch { return null; }
  }

  function observe(event: AccountLifecycleEvent<TAction>): void {
    try { onEvent?.(event); } catch { /* Diagnostics cannot affect account work. */ }
  }

  function requestId(error: unknown): string | undefined {
    try { return relatedRequestId?.(error); } catch { return undefined; }
  }

  function writeCode(error: unknown): AccountLifecycleCode {
    try { return classifyWriteError?.(error) ?? "unknown"; } catch { return "unknown"; }
  }

  function notify(callback: (() => void) | undefined): void {
    try { callback?.(); } catch { /* Host notification cannot alter a completed operation. */ }
  }

  async function reload(): Promise<void> {
    await query.refetch();
  }

  async function refresh(): Promise<AccountRefreshResult> {
    if (!enabled) return { ok: false, read: "skipped" };
    const clientActionKey = actionKey();
    observe({ action: refreshAction, phase: "refresh_started", code: "observed", clientActionKey });
    try {
      await queryClient.invalidateQueries({ queryKey });
      const readError = queryClient.getQueryState(queryKey)?.error;
      observe({
        action: refreshAction,
        phase: "refresh_settled",
        code: readError ? "refresh_failed" : "succeeded",
        clientActionKey,
        ...(readError ? { relatedRequestId: requestId(readError) } : {}),
      });
      notify(onRefreshResolved);
      return { ok: true, read: readError ? "stored_error" : "succeeded" };
    } catch (error) {
      observe({ action: refreshAction, phase: "refresh_settled", code: "refresh_failed", clientActionKey, relatedRequestId: requestId(error) });
      notify(() => onRefreshError?.(error));
      return { ok: false, read: "failed" };
    }
  }

  async function mutate(work: () => Promise<unknown>, action: TAction = defaultAction): Promise<AccountMutationResult> {
    if (!enabled) return { ok: false, write: "skipped", read: "not_attempted" };
    const clientActionKey = actionKey();
    observe({ action, phase: "attempted", code: "observed", clientActionKey });
    try {
      await work();
      observe({ action, phase: "settled", code: "succeeded", clientActionKey });
    } catch (error) {
      observe({ action, phase: "settled", code: writeCode(error), clientActionKey, relatedRequestId: requestId(error) });
      notify(() => onWriteError?.(error));
      return { ok: false, write: "failed", read: "not_attempted" };
    }
    const refreshed = await refresh();
    return { ok: refreshed.ok, write: "succeeded", read: refreshed.read };
  }

  return { account, loadState, reload, refresh, mutate };
}
