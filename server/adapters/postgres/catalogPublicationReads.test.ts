import type { CatalogPublicationReadPort } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { expect, it, vi } from "vitest";
import { createPostgresCatalogPublicationReads } from "./catalogPublicationReads.js";

it("reports an unreadable stored manifest as unavailable through the publication read port", async () => {
  const head = { publicationId: "50000000-0000-4000-8000-000000000001", revision: 1, documentDigest: "d".repeat(64) };
  const query = vi.fn<PgQueryExecutor["query"]>()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ admitted: true }] })
    .mockResolvedValueOnce({ rows: [{
      id: head.publicationId, revision: head.revision, document_digest: head.documentDigest, canonical_state: "{}",
    }] });
  const { reads }: { reads: CatalogPublicationReadPort } = createPostgresCatalogPublicationReads({
    transactions: { run: work => work({ query }) },
    authorizeHuman: async () => ({ ok: false }),
  });

  expect(await reads.readback(head)).toEqual({
    outcome: "dependency_unavailable", reason: "publication_authority_unavailable",
    path: "schemaVersion", message: "Recover the sealed publication or re-export it from a verified copy.",
  });
});
