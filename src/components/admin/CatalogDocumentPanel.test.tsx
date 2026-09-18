import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogDocumentPanel } from "@/components/admin/CatalogDocumentPanel";
import {
  CATALOG_DOCUMENT_REFUSALS,
  CatalogDocumentAuthorityError,
} from "@/domains/commerce/adminCatalogDocumentContracts";
import { renderWithProviders } from "@/test/render";

/**
 * `publishCatalogDocumentCandidate` is deliberately NOT mocked: what these tests
 * have to hold is that publication leaves the panel on the operator's own
 * session client and never through a route, so the session client is the mock
 * and the call reaching it is the assertion.
 */
const { readAuthority, submitProposal, sessionRpc } = vi.hoisted(() => ({
  readAuthority: vi.fn(),
  submitProposal: vi.fn(),
  sessionRpc: vi.fn(),
}));

vi.mock("@/domains/commerce/adminCatalogDocumentClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/commerce/adminCatalogDocumentClient")>()),
  readCatalogDocumentAuthority: readAuthority,
  submitCatalogDocumentProposal: submitProposal,
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: sessionRpc } }));

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CANDIDATE_DOCUMENTS = JSON.stringify([{ productSlug: "first-item", document: { title: "next" } }]);

const authority = {
  contractVersion: "commerce.v0",
  scopeSlugs: ["first-item"],
  products: [
    {
      slug: "first-item",
      productId: "11111111-1111-4111-8111-111111111111",
      productStatus: "active",
      primarySkuId: null,
      skuCode: null,
      skuStatus: null,
      netContentGrams: null,
      sellableStandalone: null,
      sellableInSubscription: null,
      primaryTradeItemRef: "0000000000000",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      revisionNo: 3,
      documentSchemaId: "schema-1",
      documentDigest: DIGEST_A,
    },
  ],
};

const dryRunResult = {
  contractVersion: "commerce.v0",
  mode: "dry_run" as const,
  candidateDigest: DIGEST_B,
  deltas: [{ productSlug: "first-item", path: "title", currentValue: "now", targetValue: "next" }],
  submitted: null,
};

const commitResult = {
  ...dryRunResult,
  mode: "commit" as const,
  submitted: {
    proposalId: "proposal-1",
    proposalSha256: DIGEST_A,
    envelopeSha256: DIGEST_B,
    inserted: true,
  },
};

beforeEach(() => {
  readAuthority.mockResolvedValue(authority);
  submitProposal.mockResolvedValue(dryRunResult);
  sessionRpc.mockImplementation((name: string) =>
    Promise.resolve({
      data: name === "catalog_record_publication_decision"
        ? { decisionId: "decision-1", replayed: false }
        : { eventId: "event-1", postDigest: DIGEST_B, replayed: false },
      error: null,
    }));
});

afterEach(() => vi.clearAllMocks());

/**
 * Identity `t`: every rendered string is the key it came from, so inline copy
 * cannot hide, and the assertions double as the panel's key inventory.
 */
async function renderPanel() {
  renderWithProviders(<CatalogDocumentPanel accessToken="admin-token" t={(key) => key} />);
  await screen.findByText("first-item");
}

const dryRunButton = () => screen.getByRole("button", { name: "admin:catalogDocument.candidate.dryRun" });
const publishButton = () => screen.queryByRole("button", { name: "admin:catalogDocument.publish.action" });

function fillCandidate(documentsJson = CANDIDATE_DOCUMENTS) {
  fireEvent.change(screen.getByLabelText("admin:catalogDocument.candidate.canonicalTextLabel"), {
    target: { value: "{\"schemaVersion\":\"x\"}" },
  });
  fireEvent.change(screen.getByLabelText("admin:catalogDocument.candidate.documentsLabel"), {
    target: { value: documentsJson },
  });
}

async function runDryRun() {
  fillCandidate();
  fireEvent.click(dryRunButton());
  await screen.findByText("admin:catalogDocument.diff.title");
}

describe("CatalogDocumentPanel current state", () => {
  it("shows the per-product document authority it read", async () => {
    await renderPanel();

    expect(readAuthority).toHaveBeenCalledWith("admin-token");
    expect(screen.getByText("first-item")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(DIGEST_A)).toBeInTheDocument();
    expect(screen.getByText("0000000000000")).toBeInTheDocument();
  });
});

describe("CatalogDocumentPanel dry run", () => {
  it("sends the declared base digests it just read, and writes nothing", async () => {
    await renderPanel();
    await runDryRun();

    const [token, request] = submitProposal.mock.calls[0] as [string, Record<string, unknown>];
    expect(token).toBe("admin-token");
    expect(request.mode).toBe("dry_run");
    expect(request.baseDocumentDigests).toEqual([
      { productSlug: "first-item", documentDigest: DIGEST_A },
    ]);
    // The envelope digest is computed over the pasted bytes, not declared by the operator.
    const candidate = request.candidate as { envelopeSha256: string };
    expect(candidate.envelopeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it("renders the semantic diff the seam returned", async () => {
    await renderPanel();
    await runDryRun();

    expect(screen.getByText("admin:catalogDocument.diff.delta")).toBeInTheDocument();
    expect(screen.getByText("admin:catalogDocument.diff.candidateDigest")).toBeInTheDocument();
  });

  it("withholds the dry run until the candidate is at least well formed", async () => {
    await renderPanel();
    expect(dryRunButton()).toBeDisabled();

    fillCandidate("not json");
    expect(dryRunButton()).toBeDisabled();

    fillCandidate();
    expect(dryRunButton()).toBeEnabled();
  });

  it("names the seam's own scope refusal for a product the authority does not carry", async () => {
    await renderPanel();
    fillCandidate(JSON.stringify([{ productSlug: "absent-item", document: {} }]));
    fireEvent.click(dryRunButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "admin:catalogDocument.refusal.catalog_document_scope_unknown",
    );
    expect(submitProposal).not.toHaveBeenCalled();
  });
});

describe("CatalogDocumentPanel publication gate", () => {
  it("withholds publish until a diff has been produced", async () => {
    await renderPanel();

    expect(publishButton()).toBeNull();
    expect(screen.getByText("admin:catalogDocument.publish.diffRequired")).toBeInTheDocument();

    await runDryRun();

    expect(publishButton()).toBeInTheDocument();
  });

  it("withdraws publish again when the candidate is edited after the diff", async () => {
    await renderPanel();
    await runDryRun();

    fireEvent.change(screen.getByLabelText("admin:catalogDocument.candidate.documentsLabel"), {
      target: { value: "[]" },
    });

    expect(publishButton()).toBeNull();
    expect(screen.getByText("admin:catalogDocument.publish.diffRequired")).toBeInTheDocument();
  });

  it("shows the identifier the submission answered with after a commit", async () => {
    await renderPanel();
    await runDryRun();
    expect(screen.queryByText("admin:catalogDocument.proposal.submitted")).toBeNull();

    submitProposal.mockResolvedValueOnce(commitResult);
    fireEvent.click(screen.getByRole("button", { name: "admin:catalogDocument.candidate.commit" }));

    expect(await screen.findByText("admin:catalogDocument.proposal.submitted")).toBeInTheDocument();
    const [, request] = submitProposal.mock.calls[1] as [string, Record<string, unknown>];
    expect(request.mode).toBe("commit");
  });

  it("repeats the stored identifier on a replay rather than a fresh-looking one", async () => {
    await renderPanel();
    await runDryRun();

    submitProposal.mockResolvedValueOnce({ ...commitResult, submitted: { ...commitResult.submitted, inserted: false } });
    fireEvent.click(screen.getByRole("button", { name: "admin:catalogDocument.candidate.commit" }));

    expect(await screen.findByText("admin:catalogDocument.proposal.submitted")).toBeInTheDocument();
  });

  it("renders no receipt when the submission answered without an identifier", async () => {
    await renderPanel();
    await runDryRun();

    submitProposal.mockResolvedValueOnce({ ...commitResult, submitted: { ...commitResult.submitted, proposalId: "" } });
    fireEvent.click(screen.getByRole("button", { name: "admin:catalogDocument.candidate.commit" }));

    await waitFor(() => expect(submitProposal).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("admin:catalogDocument.proposal.submitted")).toBeNull();
  });

  it("keeps the commit mode behind the same seen-diff rule", async () => {
    await renderPanel();
    fillCandidate();

    expect(screen.getByRole("button", { name: "admin:catalogDocument.candidate.commit" })).toBeDisabled();
    await runDryRun();
    expect(screen.getByRole("button", { name: "admin:catalogDocument.candidate.commit" })).toBeEnabled();
  });
});

describe("CatalogDocumentPanel publication", () => {
  function fillPublicationFields() {
    fireEvent.change(screen.getByLabelText("admin:catalogDocument.publish.candidateIdLabel"), {
      target: { value: "candidate-1" },
    });
    fireEvent.change(screen.getByLabelText("admin:catalogDocument.publish.candidateDigestLabel"), {
      target: { value: DIGEST_A },
    });
    fireEvent.change(screen.getByLabelText("admin:catalogDocument.publish.expectedCurrentDigestLabel"), {
      target: { value: DIGEST_B },
    });
  }

  async function publish() {
    await renderPanel();
    await runDryRun();
    fillPublicationFields();
    fireEvent.click(publishButton()!);
  }

  it("approves and publishes through the operator's own session client", async () => {
    await publish();

    await waitFor(() => expect(sessionRpc).toHaveBeenCalledTimes(2));
    expect(sessionRpc.mock.calls.map((call) => call[0])).toEqual([
      "catalog_record_publication_decision",
      "catalog_publish_candidate",
    ]);
    expect(await screen.findByText("admin:catalogDocument.publish.receipt")).toBeInTheDocument();
  });

  it("renders a publication refusal under its own raised token", async () => {
    sessionRpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "catalog_publication_human_admin_required" },
    });
    await publish();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "admin:catalogDocument.publishRefusal.catalog_publication_human_admin_required",
    );
  });

  it("withholds publish until the three publication fields are filled", async () => {
    await renderPanel();
    await runDryRun();

    expect(publishButton()).toBeDisabled();
    fillPublicationFields();
    expect(publishButton()).toBeEnabled();
    expect(sessionRpc).not.toHaveBeenCalled();
  });
});

describe("CatalogDocumentPanel refusals", () => {
  it.each(CATALOG_DOCUMENT_REFUSALS)("renders %s as itself", async (refusal) => {
    submitProposal.mockRejectedValueOnce(new CatalogDocumentAuthorityError(refusal));
    await renderPanel();
    fillCandidate();
    fireEvent.click(dryRunButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(`admin:catalogDocument.refusal.${refusal}`);
    expect(publishButton()).toBeNull();
  });

  it("reports a read failure without pretending the authority is empty", async () => {
    readAuthority.mockRejectedValueOnce(
      new CatalogDocumentAuthorityError("catalog_document_authority_unavailable"),
    );
    renderWithProviders(<CatalogDocumentPanel accessToken="admin-token" t={(key) => key} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "admin:catalogDocument.refusal.catalog_document_authority_unavailable",
    );
  });
});
