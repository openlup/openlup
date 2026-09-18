import {
  productAccentColor,
  productDisplayLabel,
  resolveLaunchProductSlug,
} from "../../../src/lib/catalogProductDisplay.js";

type Row = Record<string, unknown>;

export function customerLineDisplayFields(productSlug: string | null) {
  return {
    productSlug,
    flavourSlug: productSlug,
    displayLabel: productDisplayLabel(productSlug, "pl"),
    accentColor: productAccentColor(productSlug),
  };
}

export function resolveSubscriptionLineProductSlug({
  skuProductSlug,
  metadata,
  title,
  recipeName,
}: {
  skuProductSlug: string | null;
  metadata: Row;
  title: string | null;
  recipeName: string | null;
}): string | null {
  return (
    resolveLaunchProductSlug(skuProductSlug) ??
    resolveLaunchProductSlug(nullableText(metadata.productSlug)) ??
    resolveLaunchProductSlug(nullableText(metadata.product_slug)) ??
    resolveLaunchProductSlug(nullableText(metadata.flavourSlug)) ??
    resolveLaunchProductSlug(nullableText(metadata.flavorSlug)) ??
    resolveLaunchProductSlug(recipeName) ??
    resolveLaunchProductSlug(title)
  );
}

export function resolveOrderLineProductSlug({
  snapshot,
  variant,
  title,
  recipeName,
  firstText,
}: {
  snapshot: Row;
  variant: Row;
  title: string;
  recipeName: string | null;
  firstText: (row: Row, keys: string[]) => string | null;
}): string | null {
  return (
    resolveLaunchProductSlug(firstText(snapshot, ["productSlug", "product_slug", "flavourSlug", "flavorSlug", "slug"])) ??
    resolveLaunchProductSlug(firstText(variant, ["productSlug", "product_slug", "flavourSlug", "flavorSlug", "slug"])) ??
    resolveLaunchProductSlug(recipeName) ??
    resolveLaunchProductSlug(title)
  );
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
