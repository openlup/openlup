/**
 * Neutral example FAQ data retained for direct adopter tests and examples.
 *
 * The map is keyed by locale code first and storefront item slug second, so the
 * platform never has to know WHICH languages a store sells in: a consumer looks
 * up the active i18n language and gets whatever that deployment published. A
 * pair of exports each suffixed with a market's own language code would have put
 * that knowledge in publishable code and pinned the platform to two languages.
 *
 * The questions below are the ones every storefront answers about a consumable
 * subscription item — how much, how often, what is in it, what happens if it
 * does not suit. They are written to be answerable from the example catalog
 * alone, so the rendered FAQ and the FAQPage JSON-LD are consistent with the
 * items beside them rather than describing a product that does not exist.
 */
import type { ProductFaq } from "./faqModel.js";

/** The entry shape is the platform's contract; only the copy lives here. */
export type { ProductFaq } from "./faqModel.js";

const exampleFaqsEnglish: Record<string, ProductFaq[]> = {
  "example-original": [
    {
      q: "How much Example Original does one serving use?",
      a: "One 400 g unit covers a full day for a medium-sized companion animal, or two servings for a small one. The configurator sizes the plan from the weight you enter, so you do not have to work it out by hand.",
    },
    {
      q: "What is in Example Original?",
      a: "A single protein source, vegetables, and a vitamin and mineral premix. The full composition and analytical constituents are printed on the item page and on the label of every unit.",
    },
    {
      q: "Can I change or pause my plan after ordering?",
      a: "Yes. Every plan can be paused, skipped, resized or cancelled from your account at any time before the next charge, with no phone call and no notice period.",
    },
  ],
  "example-reserve": [
    {
      q: "How is Example Reserve different from Example Original?",
      a: "Reserve uses a second, less common protein source. It exists for animals that already eat the Original well but need a change, and for anyone rotating proteins on purpose.",
    },
    {
      q: "Can I mix Example Original and Example Reserve in one plan?",
      a: "Yes. A plan may contain any combination of the items in the catalogue; the configurator keeps the total within the ordering minimum and shows the mix before you confirm.",
    },
    {
      q: "How should Example Reserve be stored?",
      a: "Unopened units keep at room temperature until the date printed on the base. Once opened, refrigerate and use within 48 hours.",
    },
  ],
};

const exampleFaqsFrench: Record<string, ProductFaq[]> = {
  "example-original": [
    {
      q: "Quantité d'Example Original par portion ?",
      a: "Une unité de 400 g couvre une journée entière pour un animal de taille moyenne, ou deux portions pour un petit animal. Le configurateur calcule le plan à partir du poids que vous indiquez.",
    },
    {
      q: "Que contient Example Original ?",
      a: "Une seule source de protéines, des légumes et un prémélange de vitamines et de minéraux. La composition complète figure sur la page de l'article et sur l'étiquette de chaque unité.",
    },
    {
      q: "Puis-je modifier ou suspendre mon plan après la commande ?",
      a: "Oui. Chaque plan peut être suspendu, décalé, redimensionné ou annulé depuis votre compte avant le prochain prélèvement, sans préavis.",
    },
  ],
  "example-reserve": [
    {
      q: "Quelle est la différence entre Example Reserve et Example Original ?",
      a: "Reserve utilise une seconde source de protéines, moins courante. Elle existe pour les animaux qui mangent déjà bien l'Original mais ont besoin de changement, et pour la rotation des protéines.",
    },
    {
      q: "Puis-je mélanger Example Original et Example Reserve dans un plan ?",
      a: "Oui. Un plan peut contenir n'importe quelle combinaison des articles du catalogue ; le configurateur respecte le minimum de commande et affiche le mélange avant confirmation.",
    },
    {
      q: "Comment conserver Example Reserve ?",
      a: "Les unités non ouvertes se conservent à température ambiante jusqu'à la date imprimée sur le fond. Après ouverture, réfrigérer et consommer sous 48 heures.",
    },
  ],
};

/** Locale code -> storefront item slug -> that item's questions. */
export const storefrontFaqsByLocale: Record<string, Record<string, ProductFaq[]>> = {
  en: exampleFaqsEnglish,
  fr: exampleFaqsFrench,
};
