import * as jose from "jose";
import { beforeAll, expect, it } from "vitest";
import { createOperatorIdentityVerifier } from "../../src/identity/operatorIdentityVerifier.js";
import { createCustomerIdentityVerifier } from "../../src/identity/customerIdentityVerifier.js";
import { createCustomerSessionIssuer } from "../../src/identity/customerSessionIssuer.js";
const sub = "11111111-1111-4111-8111-111111111111";
let privateKey: CryptoKey; let jwks: string; let privateJwk: string;
beforeAll(async () => {
  const pair = await jose.generateKeyPair("ES256", { extractable: true }); privateKey = pair.privateKey;
  jwks = JSON.stringify({ keys: [{ ...await jose.exportJWK(pair.publicKey), kid: "test.key", alg: "ES256", use: "sig" }] });
  privateJwk = JSON.stringify({ ...await jose.exportJWK(privateKey), alg: "ES256" });
});
const config = () => ({ issuer: "https://identity.example.invalid", audience: "operator", customerAudience: "customer", jwks });
async function token(claims: Record<string, unknown> | ((now: number) => Record<string, unknown>) = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({ sub, iss: config().issuer, aud: "operator", iat: now, exp: now + 900, ...(typeof claims === "function" ? claims(now) : claims) }).setProtectedHeader({ alg: "ES256", kid: "test.key" }).sign(privateKey);
}
it("operator issuer uses a distinct audience and fifteen minute lifetime", async () => {
  const session = await createCustomerSessionIssuer({ ...config(), keyId: "test.key", privateJwk, ttlSeconds: 900 }, async () => jose).issue({ principalId: sub, email: "admin@example.invalid" });
  const payload = jose.decodeJwt(session.accessToken); expect(payload.aud).toBe("operator"); expect(payload.exp! - payload.iat!).toBe(900);
  expect(await createOperatorIdentityVerifier(config(), async () => jose).verifyAccessToken(session.accessToken)).toMatchObject({ principalId: sub });
  expect(() => createOperatorIdentityVerifier({ ...config(), audience: "customer" }, async () => jose)).toThrow("distinct");
});
it("customer and operator tokens are not interchangeable, including dual audiences", async () => {
  const operator = createOperatorIdentityVerifier(config(), async () => jose);
  const customer = createCustomerIdentityVerifier({ ...config(), audience: "customer" }, async () => jose);
  expect(await operator.verifyAccessToken(await token({ aud: "customer" }))).toBeNull();
  expect(await operator.verifyAccessToken(await token({ aud: ["customer", "operator"] }))).toBeNull();
  expect(await customer.verifyAccessToken(await token())).toBeNull();
});
it.each([{ exp: undefined }, { iat: undefined }, (now: number) => ({ exp: now + 901 }), { exp: 0 }, (now: number) => ({ iat: now + 10 }), { iat: 1.5 }])("operator profile requires expiry and bounded lifetime: %j", async claims => {
  expect(await createOperatorIdentityVerifier(config(), async () => jose).verifyAccessToken(await token(claims))).toBeNull();
});
it("rejects a forged signature", async () => {
  const valid = await token(); const parts = valid.split('.'); parts[2] = 'a'.repeat(86);
  expect(await createOperatorIdentityVerifier(config(), async () => jose).verifyAccessToken(parts.join('.'))).toBeNull();
});
