import { useCallback, useEffect, useState, type ChangeEvent } from "react";

import {
  catalogDocumentRefusalOf,
  CatalogPublicationRpcError,
  publishCatalogDocumentCandidate,
  readCatalogDocumentAuthority,
  submitCatalogDocumentProposal,
  type CatalogDocumentAuthorityResponse,
  type CatalogDocumentProposalResponse,
  type CatalogDocumentPublicationResult,
  type CatalogPublicationRpcClient,
} from "@/domains/commerce/adminCatalogDocumentClient";
import {
  CatalogDocumentAuthorityError,
  digestUtf8,
  type CatalogDocumentJsonValue,
} from "@/domains/commerce/adminCatalogDocumentContracts";
import { supabase } from "@/integrations/supabase/client";

import { BTN_PRIMARY, BTN_SECONDARY, CARD, CARD_TITLE, ERR, FIELD, LABEL } from "./bundleAdminUi";

/**
 * The document-authority panel: read what is current, diff a candidate against
 * it without writing, then publish as a human.
 *
 * EVERY WORD COMES FROM `t`, AND EVERY KEY IS WRITTEN AT THE CALL SITE as a
 * fully qualified `admin:` literal. Both halves are load-bearing. The first is
 * measured: this directory sits in a surface family whose `country` counter has
 * no slack, so a sentence costs the ceiling here and costs nothing in a locale
 * pack. The second is what keeps `guard:unused-i18n-keys` able to see this
 * panel's copy at all - a key stored in a variable and resolved later is
 * invisible to it, and an unqualified key is invisible twice over, so orphaned
 * copy under this namespace would never be reported again.
 *
 * THE TWO OPEN-ENDED FAMILIES ARE ANCHORED TEMPLATES, `admin:...refusal.${code}`
 * passed straight to `t`. That compiles to a pattern bounded to one segment
 * under an exact prefix, so the guard still checks every static key beside them.
 * A declared-owner entry would have been broader AND dead: the guard only reads
 * those for a template with no static prefix, which this file does not have.
 *
 * A REFUSAL IS RENDERED AS ITSELF, with the raised name as the fallback value,
 * so an operator whose base revision moved reads that rather than "failed".
 *
 * PUBLISH RUNS ON THE OPERATOR'S OWN SESSION, through the app's browser client,
 * and is the one action here that does not go through the BFF. The publication
 * functions are defended by a gate that reads `auth.uid()`: a route would arrive
 * as the service role with no user id, and one built to satisfy the gate anyway
 * would hand the same capability to a machine actor.
 *
 * AN ACTION WHOSE ONLY OUTCOME IS A REFUSAL IS NOT OFFERED. Dry run is withheld
 * until the candidate is at least well formed, publish until a diff has been
 * seen and the three publication fields are filled, and any edit to the
 * candidate withdraws the diff again - a diff computed for text since changed is
 * not a diff anyone saw.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface CandidateDocument { productSlug: string; document: CatalogDocumentJsonValue }

export interface CatalogDocumentPanelProps {
  accessToken: string;
  t: Translate;
}

/** Candidate payloads for the diff; `null` when the text is not the shape the seam takes. */
function parseCandidateDocuments(text: string): CandidateDocument[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries = parsed.map((value) => {
    const entry = (value ?? {}) as { productSlug?: unknown; document?: unknown };
    return typeof entry.productSlug === "string" && entry.productSlug.length > 0 && entry.document !== undefined
      ? { productSlug: entry.productSlug, document: entry.document as CatalogDocumentJsonValue }
      : null;
  });
  return entries.every((entry): entry is CandidateDocument => entry !== null) ? entries : null;
}

/**
 * Copy is resolved here rather than stored as a key, so every literal is visible
 * at a `t` call. The two dynamic families keep their static prefix.
 */
function describeError(t: Translate, error: unknown): string {
  const refusal = catalogDocumentRefusalOf(error);
  if (refusal !== null) return t(`admin:catalogDocument.refusal.${refusal}`, { defaultValue: refusal });
  if (error instanceof CatalogPublicationRpcError) {
    return t(`admin:catalogDocument.publishRefusal.${error.reason}`, { defaultValue: error.reason });
  }
  const message = error instanceof Error ? error.message : String(error);
  return t("admin:catalogDocument.error.unexpected", { message, defaultValue: message });
}

/** One labelled control; `rows` chooses the textarea, so the two shapes share one layout. */
function LabelledField(props: { id: string; label: string; value: string; rows?: number; onChange: (value: string) => void }): JSX.Element {
  const shared = {
    id: props.id,
    className: FIELD,
    value: props.value,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.onChange(event.target.value),
  };
  return (
    <>
      <label className={LABEL} htmlFor={props.id}>{props.label}</label>
      {props.rows === undefined ? <input {...shared} /> : <textarea {...shared} rows={props.rows} />}
    </>
  );
}

export function CatalogDocumentPanel({ accessToken, t }: CatalogDocumentPanelProps): JSX.Element {
  const [authority, setAuthority] = useState<CatalogDocumentAuthorityResponse | null>(null);
  const [canonicalText, setCanonicalText] = useState("");
  const [documentsText, setDocumentsText] = useState("");
  const [diff, setDiff] = useState<CatalogDocumentProposalResponse | null>(null);
  const [candidateId, setCandidateId] = useState("");
  const [candidateDigest, setCandidateDigest] = useState("");
  const [expectedCurrentDigest, setExpectedCurrentDigest] = useState("");
  const [publication, setPublication] = useState<CatalogDocumentPublicationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAuthority = useCallback(async (): Promise<void> => {
    try {
      setAuthority(await readCatalogDocumentAuthority(accessToken));
    } catch (error) {
      setAuthority(null);
      setMessage(describeError(t, error));
    }
  }, [accessToken, t]);

  useEffect(() => { void loadAuthority(); }, [loadAuthority]);

  const documents = parseCandidateDocuments(documentsText);
  const candidateReady = canonicalText.trim().length > 0 && documents !== null && authority !== null;
  const publishReady = Boolean(candidateId.trim() && candidateDigest.trim() && expectedCurrentDigest.trim());

  /** Any edit to the candidate withdraws the diff, and with it the publish form. */
  function editCandidate(apply: () => void): void {
    apply();
    setDiff(null);
    setPublication(null);
  }

  async function runProposal(mode: "commit" | "dry_run"): Promise<void> {
    if (authority === null || documents === null) return;
    setBusy(true);
    setMessage(null);
    try {
      // Freshness is anchored on what the panel just read, so a refused base digest
      // means the authority moved under the operator - never a value they mistyped.
      // A candidate naming a product this read does not carry cannot even form a
      // request, and it is the seam's own `scope_unknown` condition, so it is
      // raised under the seam's name rather than a second local vocabulary.
      const baseDocumentDigests = documents.map((entry) => {
        const documentDigest = authority.products.find((item) => item.slug === entry.productSlug)?.documentDigest;
        if (!documentDigest) throw new CatalogDocumentAuthorityError("catalog_document_scope_unknown");
        return { productSlug: entry.productSlug, documentDigest };
      });
      setDiff(await submitCatalogDocumentProposal(accessToken, {
        mode,
        baseDocumentDigests,
        candidate: { canonicalText, envelopeSha256: await digestUtf8(canonicalText), documents },
      }));
    } catch (error) {
      setDiff(null);
      setMessage(describeError(t, error));
    } finally {
      setBusy(false);
    }
  }

  async function runPublish(): Promise<void> {
    if (diff === null || !publishReady) return;
    setBusy(true);
    setMessage(null);
    try {
      // The generated database types do not carry the two publication functions;
      // what this call needs from the client is the session and its `auth.uid()`.
      const result = await publishCatalogDocumentCandidate(supabase as unknown as CatalogPublicationRpcClient, {
        candidateId: candidateId.trim(),
        candidateDigest: candidateDigest.trim(),
        expectedCurrentDigest: expectedCurrentDigest.trim(),
      });
      setPublication(result);
      await loadAuthority();
    } catch (error) {
      setMessage(describeError(t, error));
    } finally {
      setBusy(false);
    }
  }

  const none = t("admin:catalogDocument.authority.none");

  return (
    <section className={CARD}>
      <h2 className={CARD_TITLE}>{t("admin:catalogDocument.title")}</h2>
      <p className="mt-1 text-xs text-text-muted">{t("admin:catalogDocument.description")}</p>

      {message !== null && <p role="alert" className={ERR}>{message}</p>}

      <h3 className="mt-4 text-sm font-semibold text-teal-dark">{t("admin:catalogDocument.authority.title")}</h3>
      {authority === null ? (
        <p className="text-xs text-text-muted">{t("admin:catalogDocument.authority.loading")}</p>
      ) : authority.products.length === 0 ? (
        <p className="text-xs text-text-muted">{t("admin:catalogDocument.authority.empty")}</p>
      ) : (
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr>
              <th scope="col">{t("admin:catalogDocument.authority.slug")}</th>
              <th scope="col">{t("admin:catalogDocument.authority.status")}</th>
              <th scope="col">{t("admin:catalogDocument.authority.revision")}</th>
              <th scope="col">{t("admin:catalogDocument.authority.digest")}</th>
              <th scope="col">{t("admin:catalogDocument.authority.tradeItem")}</th>
            </tr>
          </thead>
          <tbody>
            {authority.products.map((product) => (
              <tr key={product.slug}>
                <td>{product.slug}</td>
                <td>{product.productStatus}</td>
                <td>{product.revisionNo ?? none}</td>
                <td className="font-mono">{product.documentDigest ?? none}</td>
                <td>{product.primaryTradeItemRef ?? none}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => void loadAuthority()}>
        {t("admin:catalogDocument.authority.reload")}
      </button>

      <h3 className="mt-6 text-sm font-semibold text-teal-dark">{t("admin:catalogDocument.candidate.title")}</h3>
      <LabelledField id="catalog-document-canonical-text" rows={4} label={t("admin:catalogDocument.candidate.canonicalTextLabel")} value={canonicalText} onChange={(value) => editCandidate(() => setCanonicalText(value))} />
      <LabelledField id="catalog-document-documents" rows={4} label={t("admin:catalogDocument.candidate.documentsLabel")} value={documentsText} onChange={(value) => editCandidate(() => setDocumentsText(value))} />
      <p className="mt-1 text-[11px] text-text-muted">{t("admin:catalogDocument.candidate.documentsHint")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={busy || !candidateReady} onClick={() => void runProposal("dry_run")}>
          {t("admin:catalogDocument.candidate.dryRun")}
        </button>
        <button type="button" className={BTN_SECONDARY} disabled={busy || !candidateReady || diff === null} onClick={() => void runProposal("commit")}>
          {t("admin:catalogDocument.candidate.commit")}
        </button>
      </div>

      {diff !== null && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-teal-dark">{t("admin:catalogDocument.diff.title")}</h3>
          <p className="text-xs text-text-muted">{t("admin:catalogDocument.diff.candidateDigest", { digest: diff.candidateDigest })}</p>
          {diff.submitted !== null && diff.submitted.proposalId.length > 0 && (
            // The id the submission ANSWERED with: a replay of identical bytes returns
            // `inserted: false` and the STORED row's id, so a repeated identifier is the
            // truth. An answer carrying no id renders nothing rather than a made-up one.
            <p className="text-xs text-text-muted">{t("admin:catalogDocument.proposal.submitted", { proposalId: diff.submitted.proposalId })}</p>
          )}
          {diff.deltas.length === 0 ? (
            <p className="text-xs text-text-muted">{t("admin:catalogDocument.diff.empty")}</p>
          ) : (
            <ul className="mt-1 grid gap-1 text-xs">
              {diff.deltas.map((delta) => (
                <li key={`${delta.productSlug}:${delta.path}`}>
                  {t("admin:catalogDocument.diff.delta", {
                    slug: delta.productSlug,
                    path: delta.path,
                    current: JSON.stringify(delta.currentValue),
                    target: JSON.stringify(delta.targetValue),
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-teal-dark">{t("admin:catalogDocument.publish.title")}</h3>
      <p className="text-xs text-text-muted">{t("admin:catalogDocument.publish.sessionNote")}</p>
      {diff === null ? (
        <p className="text-xs text-text-muted">{t("admin:catalogDocument.publish.diffRequired")}</p>
      ) : (
        <div className="grid gap-2">
          <LabelledField id="catalog-document-candidate-id" label={t("admin:catalogDocument.publish.candidateIdLabel")} value={candidateId} onChange={setCandidateId} />
          <LabelledField id="catalog-document-candidate-digest" label={t("admin:catalogDocument.publish.candidateDigestLabel")} value={candidateDigest} onChange={setCandidateDigest} />
          <LabelledField id="catalog-document-expected-digest" label={t("admin:catalogDocument.publish.expectedCurrentDigestLabel")} value={expectedCurrentDigest} onChange={setExpectedCurrentDigest} />
          <button type="button" className={BTN_PRIMARY} disabled={busy || !publishReady} onClick={() => void runPublish()}>
            {t("admin:catalogDocument.publish.action")}
          </button>
        </div>
      )}
      {publication && (
        <p className="mt-2 text-xs text-text-muted">
          {t("admin:catalogDocument.publish.receipt", { eventId: publication.eventId, postDigest: publication.postDigest })}
        </p>
      )}
    </section>
  );
}
