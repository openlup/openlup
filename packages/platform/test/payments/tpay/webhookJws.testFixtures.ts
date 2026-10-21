import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Synthetic test-only chain; no provider material or persistent key fixture. */
export function createTpayJwsFixture(rootDays = 1) {
  const directory = mkdtempSync(join(tmpdir(), "tpay-jws-test-"));
  const file = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  try {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", String(rootDays),
      "-subj", "/CN=Synthetic Tpay test root", "-keyout", file("root.key"), "-out", file("root.pem"));
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
      "-subj", "/CN=Synthetic Tpay test signer", "-keyout", file("leaf.key"), "-out", file("leaf.csr"));
    openssl("x509", "-req", "-sha256", "-days", "1", "-in", file("leaf.csr"),
      "-CA", file("root.pem"), "-CAkey", file("root.key"), "-CAcreateserial", "-out", file("leaf.pem"));
    const rootCertificatePem = readFileSync(file("root.pem"), "utf8");
    const signingCertificatePem = readFileSync(file("leaf.pem"), "utf8");
    const signingKey = readFileSync(file("leaf.key"), "utf8");
    return {
      rootCertificatePem,
      signingCertificatePem,
      signature(rawBody: string, x5u = "https://secure.sandbox.tpay.com/x509/test-signing.pem", assertedTime?: number) {
        const header = Buffer.from(JSON.stringify({ alg: "RS256", x5u, ...(assertedTime !== undefined ? { iat: assertedTime } : {}) })).toString("base64url");
        const input = `${header}.${Buffer.from(rawBody).toString("base64url")}`;
        return `${header}..${sign("RSA-SHA256", Buffer.from(input), signingKey).toString("base64url")}`;
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
