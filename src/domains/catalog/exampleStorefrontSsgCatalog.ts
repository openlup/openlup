import { packshotCanPrimary, packshotCanSecondary } from "#deployment-media";

import { storefrontFaqsByLocale } from "./exampleStorefrontFaqs.js";
import type { StorefrontItem } from "./storefrontItemModel.js";
import type { StorefrontSsgCatalog, StorefrontSsgLocale, StorefrontSsgProduct, StorefrontSsgProductDetails, StorefrontSsgProductSlug } from "./storefrontSsgCatalog.js";
import { productFromStorefrontSsgCatalog, STOREFRONT_SSG_LOCALES } from "./storefrontSsgCatalog.js";

export type { StorefrontSsgCatalog, StorefrontSsgFaq, StorefrontSsgLocale, StorefrontSsgProduct, StorefrontSsgProductSlug } from "./storefrontSsgCatalog.js";

const slugs = ["example-original", "example-reserve"] as const;
type Slug = typeof slugs[number];
const presentationBySlug = {
  "example-original": { heroBackground: "#e5f3f1", cardBackground: "#e5f3f1" },
  "example-reserve": { heroBackground: "#f0eaf3", cardBackground: "#f0eaf3" },
} as const;
const copyByLocale = {
  [STOREFRONT_SSG_LOCALES[0]]: {
    "example-original": {
      name: "Example Original",
      shortName: "Original",
      routePath: "/psy/example-original",
      subtitle: "Codzienny wybór.",
      description: "Kompletna codzienna karma z jednym deklarowanym źródłem białka.",
    },
    "example-reserve": {
      name: "Example Reserve",
      shortName: "Reserve",
      routePath: "/psy/example-reserve",
      subtitle: "Drugi wybór do rotacji.",
      description: "Kompletna karma rezerwowa z drugim deklarowanym źródłem białka.",
    },
  },
  en: {
    "example-original": {
      name: "Example Original",
      shortName: "Original",
      routePath: "/dogs/example-original",
      subtitle: "The everyday option.",
      description: "A complete everyday item with one declared protein source.",
    },
    "example-reserve": {
      name: "Example Reserve",
      shortName: "Reserve",
      routePath: "/dogs/example-reserve",
      subtitle: "A second option for rotation.",
      description: "A complete reserve item with a second declared protein source.",
    },
  },
} as const;
const images: Record<Slug, string> = {
  "example-original": packshotCanPrimary,
  "example-reserve": packshotCanSecondary,
};
const firstLocaleFaqs: Record<Slug, StorefrontSsgProduct["faq"]> = {
  "example-original": [
    { key: "faq_1", question: "Ile Example Original podać w jednej porcji?", answer: "Jedna puszka 400 g pokrywa dzienne zapotrzebowanie średniego zwierzęcia towarzyszącego lub dwa posiłki małego zwierzęcia. Konfigurator dobierze plan do podanej wagi." },
    { key: "faq_2", question: "Co zawiera Example Original?", answer: "Jedno źródło białka, warzywa oraz premiks witamin i składników mineralnych. Pełny skład jest na stronie produktu i etykiecie każdej puszki." },
    { key: "faq_3", question: "Czy mogę zmienić lub wstrzymać plan po zamówieniu?", answer: "Tak. Plan można wstrzymać, pominąć, zmienić jego rozmiar lub anulować przed kolejną płatnością." },
  ],
  "example-reserve": [
    { key: "faq_1", question: "Czym Example Reserve różni się od Example Original?", answer: "Reserve wykorzystuje drugie, mniej powszechne źródło białka. Jest przeznaczony dla zwierząt, które dobrze tolerują Original, ale potrzebują zmiany lub planowej rotacji." },
    { key: "faq_2", question: "Czy mogę łączyć Example Original i Example Reserve w jednym planie?", answer: "Tak. Plan może zawierać dowolne połączenie produktów z katalogu; konfigurator utrzymuje minimalną wartość zamówienia i pokazuje mieszankę przed potwierdzeniem." },
    { key: "faq_3", question: "Jak przechowywać Example Reserve?", answer: "Zamknięte puszki można przechowywać w temperaturze pokojowej do daty z dna opakowania. Po otwarciu należy je schłodzić i zużyć w ciągu 48 godzin." },
  ],
};

export const storefrontSsgCatalog: StorefrontSsgCatalog = freeze({
  productSlugs: slugs,
  slugMap: { "example-original": "example-original", "example-reserve": "example-reserve" },
  productsByLocale: {
    [STOREFRONT_SSG_LOCALES[0]]: localeProducts(STOREFRONT_SSG_LOCALES[0]),
    [STOREFRONT_SSG_LOCALES[1]]: localeProducts(STOREFRONT_SSG_LOCALES[1]),
  },
});

export const storefrontSsgDetails: readonly StorefrontSsgProductDetails[] = freeze(
  STOREFRONT_SSG_LOCALES.flatMap((locale) => slugs.map((slug) => {
    const product = storefrontSsgCatalog.productsByLocale[locale][slug]!;
    const { ingredients, ingredientCards, supplements, supplementsList, analytics, servingGuide, servingNote, servingExtra, storage, manufacturer, approvalNumber, madeIn, transitionCallout } = product.item as StorefrontItem;
    return { locale, productSlug: slug, item: { ingredients, ingredientCards, supplements, supplementsList, analytics, servingGuide, servingNote, servingExtra, storage, manufacturer, approvalNumber, madeIn, transitionCallout }, faq: product.faq ?? [] };
  })),
);

export function getStorefrontSsgProduct(slug: string, locale: StorefrontSsgLocale): StorefrontSsgProduct | undefined { return productFromStorefrontSsgCatalog(storefrontSsgCatalog, slug, locale); }
export function resolveStorefrontSsgSlug(urlSlug: string): StorefrontSsgProductSlug | undefined { return storefrontSsgCatalog.slugMap[urlSlug]; }

function localeProducts(locale: StorefrontSsgLocale): Record<Slug, StorefrontSsgProduct> {
  const result = {} as Record<Slug, StorefrontSsgProduct>;
  for (const slug of slugs) {
    const copy = copyByLocale[locale][slug];
    result[slug] = {
    item: exampleItem(slug, copy.name, images[slug], slug === "example-original" ? "#287f78" : "#765486"),
    primarySku: examplePrimarySku(slug),
    routePath: copy.routePath,
    shortName: copy.shortName,
    presentation: presentationBySlug[slug],
    proteinBasePercent: slug === "example-original" ? 90 : 88,
    subtitle: copy.subtitle,
    description: copy.description,
    faq: locale === STOREFRONT_SSG_LOCALES[0]
      ? firstLocaleFaqs[slug]
      : storefrontFaqsByLocale.en![slug]!.map(({ q, a }, index) => ({ key: `faq_${index + 1}`, question: q, answer: a })),
    };
  }
  return result;
}

function examplePrimarySku(slug: Slug): StorefrontSsgProduct["primarySku"] {
  return {
    code: slug === "example-original" ? "EXAMPLE-ORIGINAL-400G" : "EXAMPLE-RESERVE-400G",
    primaryUnitGtin: slug === "example-original" ? "0000000000000" : "0000000000001",
    netContent: { unscaled: 400, scale: 0, unit: "GRAM" },
    sellability: { oneTime: true, subscription: true },
  };
}

function exampleItem(slug: Slug, name: string, image: string, color: string): StorefrontItem {
  return {
    slug, name, status: "available", lineName: "Example essentials", species: "Dog", format: "Complete wet food", weight: "400 g", color, colorVar: "--primary",
    heroImage: image, heroImageLcp: image, galleryImages: [{ src: image, label: "Package front" }], tagline: "Simple, complete, clearly declared.", badges: ["Complete", "Single protein"], claim: "One clear everyday choice",
    ingredients: "Declared protein source, vegetables, vitamins and minerals.", ingredientCards: [], supplements: { IU_kg: "Declared on pack", mg_kg: "Declared on pack", ug_kg: "Declared on pack" }, analytics: [], energyPer100g: 110,
    servingGuide: [{ weight: "1–10 kg", amount: "", grams: "Follow the plan" }], servingNote: "Serve at room temperature and adjust to individual needs.", storage: "Store unopened units at room temperature. Refrigerate after opening and use within 48 hours.",
    manufacturer: "Example Store", approvalNumber: "EXAMPLE", madeIn: "Example region",
  };
}

function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value as Record<string, unknown>).forEach(freeze); Object.freeze(value); } return value; }
