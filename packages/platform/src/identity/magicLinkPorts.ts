export interface MagicLinkAuthClient {
  auth: { signInWithOtp(input: { email: string; options: { shouldCreateUser: false; emailRedirectTo: string } }): Promise<{ error: { name?: string; message?: string } | null }> };
}
export interface MagicLinkRateLimitClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
}
export interface MagicLinkDecision { allowed: boolean; reason?: string }
