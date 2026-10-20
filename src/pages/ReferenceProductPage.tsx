import type { ReferenceCatalogProduct, ReferenceCatalogSnapshot } from "@/domains/catalog/referenceCatalogUi";
import { formatOfferPrice } from "@/checkout/entry/subscribeEntryModel";

export default function ReferenceProductPage({ snapshot, product }: { snapshot: ReferenceCatalogSnapshot; product: ReferenceCatalogProduct }) {
  return <main lang={snapshot.profile.locale}>
    <a href={snapshot.catalogPath}>{snapshot.copy.catalog}</a>
    <h1>{product.item.title}</h1>
    <p>{product.description}</p>
    {product.media?.map(media => <img key={media.src} src={media.src} alt={media.alt} width={media.width} height={media.height} />)}
    <p>{formatOfferPrice(snapshot.profile, product.item)}</p>
    {product.details?.map(detail => <section key={detail.heading}><h2>{detail.heading}</h2><p>{detail.body}</p></section>)}
    <a href={snapshot.builderPath}>{snapshot.copy.builder}</a>
  </main>;
}
