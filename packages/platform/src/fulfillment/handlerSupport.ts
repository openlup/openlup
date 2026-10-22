import type { FulfillmentNativeUnsupported } from './contracts/nativeUnsupported.js';
export interface FulfillmentHandlerRequest { method?: string; query: Record<string, string | string[] | undefined>; body?: unknown }
export interface FulfillmentHandlerResponder<Response> {
  sendMethodNotAllowed(res: Response, methods: readonly string[]): void;
  sendBffSuccess(res: Response, data: unknown): void;
  sendBffError(res: Response, code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'INVALID_RESPONSE' | 'NOT_FOUND' | 'CONFLICT' | 'UPSTREAM_UNAVAILABLE', message: string, options?: { details: unknown }): void;
}
export type AdminAuthResult = { ok: false; code: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string } | { ok: true; userId: string };
export interface BaseDeps<Response> {
  authorizeAdmin(req: FulfillmentHandlerRequest): Promise<AdminAuthResult>;
  respond: FulfillmentHandlerResponder<Response>;
}
export function isNativeUnsupported(value: unknown): value is FulfillmentNativeUnsupported {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'native_unsupported';
}
export class CommerceFulfillmentConflictError extends Error {
  constructor(message = 'Commerce fulfillment conflict', readonly details: Record<string, unknown> = {}) { super(message); this.name = 'CommerceFulfillmentConflictError'; }
}
export async function authorize<Response>(req: FulfillmentHandlerRequest, res: Response, authorizeAdmin: BaseDeps<Response>['authorizeAdmin'], respond: FulfillmentHandlerResponder<Response>) {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) { respond.sendBffError(res, authorization.code, authorization.message); return null; }
    return { userId: authorization.userId };
  } catch { respond.sendBffError(res, 'UPSTREAM_UNAVAILABLE', 'Admin authorization failed'); return null; }
}
