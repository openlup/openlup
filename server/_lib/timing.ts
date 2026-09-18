/**
 * Pads a response so it takes at least `minMs` from `startedAt`.
 * Used to flatten timing-based enumeration on auth endpoints — every
 * code path (success, quota denial, RPC error) returns after the same
 * floor, so response latency does not reveal whether an email exists.
 */
export async function padResponseTime(
  startedAt: number,
  minMs: number,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const elapsed = now() - startedAt;
  const remaining = Math.max(0, minMs - elapsed);
  if (remaining > 0) await sleep(remaining);
}
