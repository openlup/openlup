import type { CatalogPublicationReadResult } from "@openlup/platform/catalog/contracts";

/** Observation only: an active row alone is never evidence of publication. */
export function CatalogLifecycleObservation({ result }: { result: CatalogPublicationReadResult }) {
  if (result.outcome !== "found") {
    return <output data-catalog-outcome={result.outcome}>{result.outcome}{"reason" in result ? `: ${result.reason}` : ""}</output>;
  }
  return <section aria-label="Catalog lifecycle" data-catalog-outcome="found">
    <p>{result.head.publicationId} · {result.head.revision}</p>
    <ul>{result.observations.map(observation => <li key={observation.variantId}>
      <span>{observation.sku}: {observation.state}</span>{" "}
      <span>{observation.publicationHead === null ? "unpublished" : `${observation.publicationHead.publicationId} · ${observation.publicationHead.revision}`}</span>
    </li>)}</ul>
  </section>;
}
