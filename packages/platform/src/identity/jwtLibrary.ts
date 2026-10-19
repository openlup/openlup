export interface IdentityJwk {
  [key: string]: unknown;
  kty?: string; alg?: string; crv?: string; kid?: string; use?: string; x?: string; y?: string; d?: string;
}
type Key = CryptoKey | Uint8Array;
interface Signer {
  setProtectedHeader(header: { alg: string; kid: string; typ: string }): Signer;
  setSubject(value: string): Signer; setIssuer(value: string): Signer;
  setAudience(value: string): Signer; setIssuedAt(value: number): Signer;
  setExpirationTime(value: number): Signer; sign(key: Key): Promise<string>;
}
/** The host loads its selected JWT implementation only for the selected adapter. */
export interface IdentityJwtLibrary {
  importJWK(jwk: IdentityJwk, alg: string): Promise<Key>;
  jwtVerify(token: string, key: (header: { alg?: string; kid?: string }) => Promise<Key>, options: { algorithms: string[]; audience: string; issuer: string; currentDate?: Date; clockTolerance?: number }): Promise<{ payload: IdentityJwtClaims }>;
  SignJWT: new (payload: Record<string, unknown>) => Signer;
}
export type IdentityJwtLibraryLoader = () => Promise<IdentityJwtLibrary>;

/** Claims returned only after signature verification by the host library. */
export interface IdentityJwtClaims {
  [claim: string]: unknown;
  sub?: string; iss?: string; aud?: string | string[]; exp?: number; iat?: number; nbf?: number;
}
