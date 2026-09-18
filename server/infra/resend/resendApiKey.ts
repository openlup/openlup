// The key resolver. It was the Node half of a pair with a Deno twin that could
// not import from src/; the twin went with the Edge tree on 2026-09-04.
// The hidden-preview environment forbids RESEND_API_KEY (see
// api/_lib/hiddenSandboxPreviewGuard.ts findLiveProviderEnv) and instead uses
// RESEND_PROVIDER_MODE=sandbox + RESEND_SANDBOX_API_KEY. The outbox dispatcher
// (a Node cron) must resolve the right key per mode so it can deliver on
// preview while production keeps using the live key. Non-throwing: callers gate
// a missing key into a 503, matching the cron's other provider checks.

export type ResendKeyMode = "sandbox" | "live";

export interface ResolvedResendKey {
  apiKey: string | undefined;
  mode: ResendKeyMode;
}

export function resolveResendApiKey(
  env: Record<string, string | undefined>,
): ResolvedResendKey {
  const providerMode = (env.RESEND_PROVIDER_MODE ?? "").trim().toLowerCase();
  if (providerMode === "sandbox") {
    const sandboxKey = env.RESEND_SANDBOX_API_KEY?.trim();
    return { apiKey: sandboxKey && sandboxKey.length > 0 ? sandboxKey : undefined, mode: "sandbox" };
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  return { apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined, mode: "live" };
}
