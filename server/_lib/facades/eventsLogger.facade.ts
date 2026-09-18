// Fire-and-forget event logger writing to Supabase pet_personalizer_events.
// Uses raw fetch — no @supabase/supabase-js dependency in the function bundle.
// Failures fall back to structured console.error so Vercel logs still capture
// the data even if Supabase is unreachable.

const TIMEOUT_MS = 1500;

export interface GenerationEvent {
  eventType: 'generation' | 'cleanup_run';
  outcome: 'success' | 'client_error' | 'server_error';
  errorCode?: string | null;
  flavor?: string | null;
  durationMs?: number;
  retryUsed?: boolean;
  slug?: string | null;
  ipHash?: string | null;
  uaClass?: 'mobile' | 'desktop' | 'bot' | null;
  sizeBytes?: number | null;
  metadata?: Record<string, unknown> | null;
}

function endpoint(): string | null {
  const base = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/rest/v1/pet_personalizer_events`;
}

function authToken(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
}

export const eventsLogger = {
  /** Best-effort write. Awaited with a tight timeout so we don't extend the
   *  client's wait when Supabase is slow; falls through to console.error. */
  async record(event: GenerationEvent): Promise<void> {
    const url = endpoint();
    const token = authToken();
    if (!url || !token) {
      console.warn('[events] supabase not configured, falling back to log', summarize(event));
      return;
    }
    const body = JSON.stringify({
      event_type: event.eventType,
      outcome: event.outcome,
      error_code: event.errorCode ?? null,
      flavor: event.flavor ?? null,
      duration_ms: event.durationMs ?? null,
      retry_used: event.retryUsed ?? false,
      slug: event.slug ?? null,
      ip_hash: event.ipHash ?? null,
      ua_class: event.uaClass ?? null,
      size_bytes: event.sizeBytes ?? null,
      metadata: event.metadata ?? null,
    });
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: token,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          prefer: 'return=minimal',
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.error('[events] supabase insert failed', { status: res.status, ...summarize(event) });
      }
    } catch (e) {
      console.error('[events] supabase insert errored', { msg: String(e), ...summarize(event) });
    } finally {
      clearTimeout(timeout);
    }
  },
};

function summarize(e: GenerationEvent): Record<string, unknown> {
  return {
    type: e.eventType,
    outcome: e.outcome,
    code: e.errorCode,
    flavor: e.flavor,
    ms: e.durationMs,
    retry: e.retryUsed,
  };
}
