import type { ActionInput, ActionResult, AppConfigurationResponse, Operation } from '../shared/api.ts';
import { isRecord } from '../shared/offer.ts';

export async function configuration(): Promise<AppConfigurationResponse> {
  const response = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('starter_configuration_unavailable');
  return response.json() as Promise<AppConfigurationResponse>;
}

export async function act(operation: Operation, input: ActionInput, commandKey: string): Promise<ActionResult> {
  try {
    const response = await fetch(`/api/actions/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': commandKey },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20000),
    });
    const result: unknown = await response.json();
    if (isRecord(result) && result.ok === false && typeof result.code === 'string') {
      const issues = Array.isArray(result.issues) ? result.issues.flatMap(issue =>
        isRecord(issue) && typeof issue.path === 'string' && typeof issue.code === 'string'
          ? [{ path: issue.path, code: issue.code, ...(typeof issue.message === 'string' ? { message: issue.message } : {}),
            ...(typeof issue.subject === 'string' ? { subject: issue.subject } : {}) }] : []) : [];
      return { ok: false, code: result.code, ...(issues.length ? { issues } : {}),
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
