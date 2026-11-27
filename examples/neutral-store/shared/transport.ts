import { actionRequestTimeoutMs, type ActionInput, type ActionResult, type Operation } from './api.ts';
import { isRecord } from './offer.ts';

/** The request path of one starter action. Every client and command builds action paths here, and only here. */
export function actionPath(operation: Operation): string {
  return `/api/actions/${operation}`;
}

/**
 * Sends one starter action under `commandKey` and reads its answer. It never throws: a lost or unreadable answer
 * resolves `starter_transport_unavailable` or `starter_response_invalid`. `timeoutMs` bounds the request; a
 * replay passes its own deadline.
 */
export async function act(operation: Operation, input: ActionInput, commandKey: string,
  timeoutMs: number = actionRequestTimeoutMs): Promise<ActionResult> {
  try {
    const response = await fetch(actionPath(operation), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': commandKey },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result: unknown = await response.json();
    if (isRecord(result) && result.ok === false && typeof result.code === 'string') {
      const issues = Array.isArray(result.issues) ? result.issues.flatMap(issue =>
        isRecord(issue) && typeof issue.path === 'string' && typeof issue.code === 'string'
          ? [{ path: issue.path, code: issue.code, ...(typeof issue.message === 'string' ? { message: issue.message } : {}),
            ...(typeof issue.subject === 'string' ? { subject: issue.subject } : {}) }] : []) : [];
      return { ok: false, code: result.code, ...(issues.length ? { issues } : {}),
        ...(response.status === 503 ? { status: 503 as const } : {}),
        ...(typeof result.message === 'string' ? { message: result.message } : {}),
        ...(typeof result.path === 'string' ? { path: result.path } : {}),
        ...(typeof result.subject === 'string' ? { subject: result.subject } : {}) };
    }
    if (response.ok && isRecord(result) && result.ok === true && 'value' in result) {
      return { ok: true, value: result.value, ...(result.replayed === true ? { replayed: true } : {}) };
    }
    return { ok: false, code: 'starter_response_invalid' };
  } catch {
    return { ok: false, code: 'starter_transport_unavailable' };
  }
}

/** The answer does not say whether the host applied the request. */
export function uncertainAction(result: ActionResult): boolean {
  return !result.ok && (result.status === 503 || ['starter_transport_unavailable', 'starter_response_invalid'].includes(result.code));
}
