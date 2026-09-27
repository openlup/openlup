// Control-row prerequisite for the owned disposable subscription reference.
export const subscriptionAlignmentSeedSql = `
INSERT INTO public.subscription_delivery_alignment_control (singleton, mode)
VALUES (true, 'auto_align')
ON CONFLICT (singleton) DO NOTHING;
`;

export function assertSubscriptionAlignmentControl(rows) {
  if (!Array.isArray(rows)) throw new Error("Subscription alignment control readback is invalid");
  if (rows.length === 0) {
    throw new Error("Subscription alignment singleton row is missing; rerun the owned reference setup");
  }
  if (rows.length !== 1 || rows[0]?.singleton !== true) {
    throw new Error("Subscription alignment singleton readback is invalid");
  }
  if (rows[0].mode !== "auto_align") {
    throw new Error("Subscription reference requires alignment mode auto_align; setup preserves existing mode choices");
  }
}

export async function verifySubscriptionAlignmentControl({ origin, serviceRoleKey }, fetchImpl = fetch) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Subscription alignment readback requires a bare loopback HTTP origin");
  }
  if (typeof serviceRoleKey !== "string" || !serviceRoleKey.trim()) {
    throw new Error("Owned subscription alignment readback credential is unavailable");
  }
  let rows;
  try {
    const response = await fetchImpl(`${url.origin}/rest/v1/subscription_delivery_alignment_control?singleton=eq.true&select=singleton,mode`, {
      method: "GET", headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Readback refused");
    rows = await response.json();
  } catch {
    throw new Error("Subscription alignment control readback is unavailable");
  }
  assertSubscriptionAlignmentControl(rows);
}
