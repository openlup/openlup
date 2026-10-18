import { useState } from "react";
import { privacySubjectSchema, type PrivacySubjectRef, type PrivacyExport, type ErasureReceipt } from "@openlup/platform/identity/contracts";
import { exportIdentityPersonalData, eraseIdentityPersonalData } from "@/domains/auth/privacyClient";
import { BffClientError } from "@/lib/bff/client";
export function IdentityPrivacyPanel({ accessToken }: { accessToken: string }) {
  const [kind, setKind] = useState<"contact" | "principal">("contact");
  const [id, setId] = useState("");
  const subject = privacySubjectSchema.safeParse(kind === "contact" ? { kind, contactId: id } : { kind, principalId: id });
  return <section aria-label="Identity privacy" className="space-y-3 rounded border p-4">
    <h2>Identity personal data</h2>
    <p>This operation covers identity only. Other owners retain their data and remote obligations. Issued tokens can remain valid until expiry.</p>
    <label>Subject type <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="contact">Contact</option><option value="principal">Principal</option></select></label>
    <label>Subject ID <input value={id} onChange={e => setId(e.target.value)} /></label>
    {subject.success && <SubjectActions key={`${kind}:${id}:${accessToken}`} accessToken={accessToken} subject={subject.data} />}
  </section>;
}
function SubjectActions({ accessToken, subject }: { accessToken: string; subject: PrivacySubjectRef }) {
  const [document, setDocument] = useState<PrivacyExport | null>(null);
  const [receipt, setReceipt] = useState<ErasureReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  async function run(erase: boolean) {
    setBusy(true); setError("");
    try {
      if (erase) { setReceipt(await eraseIdentityPersonalData(accessToken, { subject, idempotencyKey: key })); setDocument(null); }
      else setDocument(await exportIdentityPersonalData(accessToken, subject));
    } catch (reason) {
      const details = reason instanceof BffClientError ? reason.details as { privacyCode?: string } | undefined : undefined;
      setError(details?.privacyCode ?? "Privacy operation unavailable");
    } finally { setBusy(false); }
  }
  return <div className="space-y-3">
    <button disabled={busy} onClick={() => void run(false)}>Export identity data</button>
    <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Confirm identity erasure for this subject</label>
    <button disabled={!confirmed || busy} onClick={() => void run(true)}>Erase identity data</button>
    {error && <p role="alert">{error}</p>}
    {document && <div><h3>Export coverage and retained obligations</h3><pre>{JSON.stringify(document, null, 2)}</pre></div>}
    {receipt && <div><h3>Committed erasure receipt</h3><pre>{JSON.stringify(receipt, null, 2)}</pre></div>}
  </div>;
}
