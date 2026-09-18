import type { VercelRequest } from "../../_lib/types/vercel.js";

const PREVIEW_MATRIX_RUN_ID_HEADER = "x-outbox-preview-matrix-run-id";

type ProofScopeResult =
  | { ok: true; runId: string | null }
  | { ok: false; status: number; body: { ok: false; error: string } };

export function readPreviewMatrixProofScope(
  req: VercelRequest,
  env: { HIDDEN_SANDBOX_PREVIEW_ENABLED?: string },
): ProofScopeResult {
  const raw = req.headers[PREVIEW_MATRIX_RUN_ID_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const runId = header?.trim() || null;
  if (!runId) return { ok: true, runId: null };
  if (env.HIDDEN_SANDBOX_PREVIEW_ENABLED !== "true") {
    return { ok: false, status: 403, body: { ok: false, error: "proof_scope_forbidden" } };
  }
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(runId)) {
    return { ok: false, status: 400, body: { ok: false, error: "invalid_proof_run_id" } };
  }
  return { ok: true, runId };
}
