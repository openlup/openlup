export interface OperatorSession {
  accessToken: string;
  expiresAt: string;
  user: { id: string; email: string };
}
export interface OperatorChallengeRequest { email: string }
export interface OperatorChallengeVerification { token: string }
export interface OperatorBrowserAuthPort {
  getSession(): Promise<OperatorSession | null>;
  requestChallenge(email: string): Promise<void>;
  verifyChallenge(token: string): Promise<OperatorSession>;
  signOut(): Promise<void>;
  onAuthStateChange(listener: (session: OperatorSession | null) => void): () => void;
}
/** Strict parsers keep the contracts entry independent of the server validator. */
export interface OperatorSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error };
}
function schema<T>(parse: (value: unknown) => T): OperatorSchema<T> {
  return { parse, safeParse(value) {
    try { return { success: true, data: parse(value) }; }
    catch { return { success: false, error: new Error("operator_contract_invalid") }; }
  } };
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error("operator_contract_invalid");
  return value as Record<string, unknown>;
}
function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 320 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value)) throw new Error("operator_email_invalid");
  return value;
}
export const operatorChallengeRequestSchema: OperatorSchema<OperatorChallengeRequest> = schema(value => {
  const row = fields(value, ["email"]);
  if (typeof row.email !== "string") throw new Error("operator_email_invalid");
  return { email: email(row.email.trim().toLowerCase()) };
});
export const operatorChallengeVerificationSchema: OperatorSchema<OperatorChallengeVerification> = schema(value => {
  const row = fields(value, ["token"]);
  if (typeof row.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.token)) throw new Error("operator_token_invalid");
  return { token: row.token };
});
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  return year! >= 1970 && month! >= 1 && month! <= 12 && day! >= 1
    && day! <= new Date(Date.UTC(year!, month!, 0)).getUTCDate()
    && hour! <= 23 && minute! <= 59 && second! <= 59;
}
export const operatorSessionSchema: OperatorSchema<OperatorSession> = schema(value => {
  const row = fields(value, ["accessToken", "expiresAt", "user"]);
  const user = fields(row.user, ["id", "email"]);
  if (typeof row.accessToken !== "string" || !row.accessToken || row.accessToken.length > 8192
    || !timestamp(row.expiresAt)
    || typeof user.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id)) throw new Error("operator_session_invalid");
  return { accessToken: row.accessToken, expiresAt: row.expiresAt, user: { id: user.id, email: email(user.email) } };
});
