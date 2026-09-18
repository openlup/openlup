/**
 * Replays one local idempotent finalize after its response is lost. The caller
 * closes over one immutable payload, so this cannot issue another PSP request.
 */
export async function finalizePreparedProviderAttempt<T>(
  finalize: () => Promise<T>,
): Promise<T> {
  try {
    return await finalize();
  } catch {
    return finalize();
  }
}
