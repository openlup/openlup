import { Route, Routes } from "react-router-dom";
import type { ReferenceCatalogUi } from "@/domains/catalog/referenceCatalogUi";
import ReferenceCatalogPage from "@/pages/ReferenceCatalogPage";
import ReferenceProductPage from "@/pages/ReferenceProductPage";
import ReferenceBuilderPage from "@/pages/ReferenceBuilderPage";

/** Explicit opt-in routes. The shipped public profile does not mount these. */
export function ReferenceCatalogRoutes({ input }: { input: ReferenceCatalogUi }) {
  return <Routes>{input.snapshots.flatMap(snapshot => [
    <Route key={snapshot.catalogPath} path={snapshot.catalogPath} element={<ReferenceCatalogPage snapshot={snapshot} />} />,
    <Route key={snapshot.builderPath} path={snapshot.builderPath} element={<ReferenceBuilderPage key={snapshot.builderPath} snapshot={snapshot} bindings={input.builder} />} />,
    ...snapshot.products.map(product => <Route key={product.path} path={product.path} element={<ReferenceProductPage snapshot={snapshot} product={product} />} />),
  ])}</Routes>;
}
