import { useState } from "react";
import {
  privacyRefusalCodeSchema,
  privacySubjectSchema,
  type ErasureReceipt,
  type PrivacyExport,
  type PrivacySubjectRef,
} from "@openlup/platform/identity/contracts";
import { exportIdentityPersonalData, eraseIdentityPersonalData } from "@/domains/auth/privacyClient";
import { BffClientError } from "@/lib/bff/client";

const unavailable = "Privacy operation unavailable";
const governedCodes = [
  "PRIVACY_CONTRIBUTOR_MISSING",
  "PRIVACY_ASSESSMENT_UNAVAILABLE",
  "PRIVACY_RECEIPT_COVERAGE_INCOMPLETE",
];
const factLabels = [
  { key: "observed", label: "Observed", limit: 1_020_100 },
  { key: "cause", label: "Cause", limit: 1_024 },
  { key: "fix", label: "Fix", limit: 1_024 },
  { key: "recheck", label: "Recheck", limit: 1_024 },
] as const;
type PanelError = string | { label: string; value: string }[];

function privacyError(reason: unknown): PanelError {
  if (!(reason instanceof BffClientError)) return unavailable;
  const details = reason.details;
  if (!details || typeof details !== "object" || Object.getPrototypeOf(details) !== Object.prototype) return unavailable;

  const keys = Reflect.ownKeys(details);
  if (!keys.includes("privacyCode")) return unavailable;
  const fields = details as Record<string, unknown>;
  const code = privacyRefusalCodeSchema.safeParse(fields.privacyCode);
  if (!code.success || code.data === "PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED") return unavailable;

  if (keys.length === 1) return code.data;
  if (keys.length !== factLabels.length + 1 || reason.status !== 503 || reason.code !== "UPSTREAM_UNAVAILABLE"
    || !governedCodes.includes(code.data)) return unavailable;

  const facts = [];
  for (const { key, label, limit } of factLabels) {
    const value = fields[key];
    if (!keys.includes(key) || typeof value !== "string" || value.length > limit || !value.trim()) {
      return unavailable;
    }
    facts.push({ label, value });
  }
  return facts;
}

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
  const [error, setError] = useState<PanelError | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  async function run(erase: boolean) {
    setBusy(true);
    setError(null);
    if (!erase) setDocument(null);
    try {
      if (erase) {
        setReceipt(await eraseIdentityPersonalData(accessToken, { subject, idempotencyKey: key }));
        setDocument(null);
      } else {
        setDocument(await exportIdentityPersonalData(accessToken, subject));
      }
    } catch (reason) {
      setError(privacyError(reason));
    } finally {
      setBusy(false);
    }
  }
  return <div className="space-y-3">
    <button disabled={busy} onClick={() => void run(false)}>Export identity data</button>
    <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Confirm identity erasure for this subject</label>
    <button disabled={!confirmed || busy} onClick={() => void run(true)}>Erase identity data</button>
    {error && (typeof error === "string" ? <p role="alert">{error}</p> : (
      <div role="alert">
        <dl className="space-y-2 break-words">
          {error.map(({ label, value }) => (
            <div key={label}>
              <dt className="font-medium">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    ))}
    {document && <div><h3>Export coverage and retained obligations</h3><pre>{JSON.stringify(document, null, 2)}</pre></div>}
    {receipt && <div><h3>Committed erasure receipt</h3><pre>{JSON.stringify(receipt, null, 2)}</pre></div>}
  </div>;
}
