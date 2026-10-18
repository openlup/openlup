import type {
  AuthActionResult,
  AuthSession,
  AuthStateListener,
  OAuthProviderKind,
  Unsubscribe,
} from "./types.js";


export interface CustomerAuthPort {
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(listener: AuthStateListener): Unsubscribe;
  signInWithOtp(input: { email: string; locale: string }): Promise<AuthActionResult>;
  
  verifyOtpCode(input: { email: string; token: string }): Promise<AuthActionResult>;
  signInWithOAuth(input: {
    provider: OAuthProviderKind;
    redirectTo: string;
  }): Promise<AuthActionResult>;
  linkIdentity(input: {
    provider: OAuthProviderKind;
    redirectTo: string;
  }): Promise<AuthActionResult>;
  signOut(): Promise<void>;
}
