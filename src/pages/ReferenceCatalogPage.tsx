import type { ReferenceCatalogSnapshot } from "@/domains/catalog/referenceCatalogUi";
import { formatOfferPrice } from "@/checkout/entry/subscribeEntryModel";
import { CatalogLifecycleObservation } from "@/components/admin/CatalogLifecycleObservation";

export default function ReferenceCatalogPage({ snapshot }: { snapshot: ReferenceCatalogSnapshot }) {
  return <main lang={snapshot.profile.locale}>
    <h1>{snapshot.copy.catalog}</h1>
    <a href={snapshot.builderPath}>{snapshot.copy.builder}</a>
    <ul>{snapshot.products.map(product => <li key={product.item.sku}>
      <a href={product.path}>{product.item.title}</a>{" "}
      <span>{formatOfferPrice(snapshot.profile, product.item)}</span>
    </li>)}</ul>
    {snapshot.lifecycle && <CatalogLifecycleObservation result={snapshot.lifecycle} />}
  </main>;
}
