import { quoteConfigurations } from './quote.config.ts';
import { demoRenewalConfig } from './renewal.config.ts';
import { demoRecoveryConfiguration } from '../shared/recovery-config.ts';
import type { StoreConfig } from '../shared/config.ts';
import { subscriptionEditing } from './subscription-editing.ts';

/** Change this single input to personalize the running application. */
const inputs = {
  supplements: {
    id: 'supplements',
    quote: quoteConfigurations.supplements,
    renewal: demoRenewalConfig('supplements'),
    recovery: structuredClone(demoRecoveryConfiguration),
    brand: {
      name: 'Aster Goods',
      strapline: { en: 'A fictional everyday collection', pl: 'Fikcyjna kolekcja na co dzień' },
      description: {
        en: 'A demonstration supplement catalogue. No health claims or consumption advice.',
        pl: 'Demonstracyjny katalog suplementów. Bez oświadczeń zdrowotnych i porad dotyczących spożycia.',
      },
    },
    theme: { ink: '#222b2a', paper: '#f7f7f2', accent: '#3d6657', accentInk: '#ffffff', border: '#ccd6cf' },
    copy: {
      heroTitle: { en: 'A small collection. Your own routine.', pl: 'Mała kolekcja. Twój własny rytm.' },
      heroBody: {
        en: 'Explore fictional products, choose a box and try a sandbox purchase. Nothing is charged or shipped.',
        pl: 'Poznaj fikcyjne produkty, skomponuj pakiet i wypróbuj zakup testowy. Bez obciążenia i wysyłki.',
      },
      offerTitle: { en: 'Build your collection', pl: 'Skomponuj swoją kolekcję' },
      offerBody: { en: 'Choose products and a purchase frequency.', pl: 'Wybierz produkty i częstotliwość zakupu.' },
      shippingNote: { en: 'For now this release does not charge shipping on one-off orders.', pl: 'Na razie to wydanie nie pobiera opłat za dostawę zamówień jednorazowych.' },
    },
    media: {
      hero: '/media/collection.svg',
      heroAlt: { en: 'Three illustrated fictional containers', pl: 'Trzy ilustracje fikcyjnych opakowań' },
    },
    market: { country: 'ZZ', currency: 'XTS', timezone: 'UTC', locales: ['en', 'pl'] },
    offer: {
      layout: 'cards',
      minUnits: 1,
      maxUnits: 12,
      shippingMinor: 0,
      freeShippingFromMinor: 0,
      subscriptionDiscountBps: 500, subscriptionRoundingQuantumMinor: 10, renewalShippingMinor: 0,
      cadenceDays: [28, 56],
      defaultCadenceDays: 28,
      products: [
        {
          sku: 'ASTER-DAWN-60', slug: 'dawn', title: 'Dawn',
          physical: { netWeightG: 250, unitGtin: '0000000000017', issuer: 'demo' },
          name: { en: 'Dawn', pl: 'Świt' },
          description: { en: 'A fictional supplement in a simple amber container.', pl: 'Fikcyjny suplement w prostym bursztynowym opakowaniu.' },
          details: { en: 'Demonstration product. The label is fictional and gives no consumption instructions.', pl: 'Produkt demonstracyjny. Etykieta jest fikcyjna i nie zawiera zaleceń spożycia.' },
          media: '/media/dawn.svg', mediaAlt: { en: 'Illustrated Dawn container', pl: 'Ilustracja opakowania Świt' },
          contents: '60', unitPrice: { amountMinor: 3900, currency: 'XTS' },
          permittedPurchaseModes: ['one_time', 'subscription'],
        },
        {
          sku: 'ASTER-NOON-60', slug: 'noon', title: 'Noon',
          physical: { netWeightG: 250, unitGtin: '0000000000024', issuer: 'demo' },
          name: { en: 'Noon', pl: 'Południe' },
          description: { en: 'A fictional supplement with a pale green label.', pl: 'Fikcyjny suplement z jasnozieloną etykietą.' },
          details: { en: 'An inert catalogue example for testing product selection, prices and recurring orders.', pl: 'Przykład katalogowy do testowania wyboru produktów, cen i zamówień cyklicznych.' },
          media: '/media/noon.svg', mediaAlt: { en: 'Illustrated Noon container', pl: 'Ilustracja opakowania Południe' },
          contents: '60', unitPrice: { amountMinor: 4500, currency: 'XTS' },
          permittedPurchaseModes: ['one_time', 'subscription'],
        },
        {
          sku: 'ASTER-DUSK-30', slug: 'dusk', title: 'Dusk',
          physical: { netWeightG: 250, unitGtin: '0000000000031', issuer: 'demo' },
          name: { en: 'Dusk', pl: 'Zmierzch' },
          description: { en: 'A fictional supplement with a muted blue label.', pl: 'Fikcyjny suplement ze stonowaną niebieską etykietą.' },
          details: { en: 'No medical benefit is implied. No physical product is supplied by this application.', pl: 'Nie przypisujemy produktowi korzyści medycznych. Aplikacja nie dostarcza fizycznych produktów.' },
          media: '/media/dusk.svg', mediaAlt: { en: 'Illustrated Dusk container', pl: 'Ilustracja opakowania Zmierzch' },
          contents: '30', unitPrice: { amountMinor: 2900, currency: 'XTS' },
          permittedPurchaseModes: ['one_time', 'subscription'],
        },
      ],
    },
    purchase: {
      recoveryMessage: {
        subject: { en: 'Complete your demonstration purchase', pl: 'Dokończ zakup demonstracyjny' },
        body: { en: 'Use this private link to view your order and complete its sandbox payment.', pl: 'Użyj prywatnego linku, aby zobaczyć zamówienie i dokończyć płatność testową.' },
        expiryLabel: { en: 'Link expires at:', pl: 'Link wygasa:' },
        orderLabel: { en: 'Order:', pl: 'Zamówienie:' },
      },
      inputLimits: { text: 200, postalCode: 32, email: 160, name: 64, phone: 32 }, reservationMinutes: 30,
      contact: { acquisitionSource: 'local-demonstration', lifecycleStage: 'lead' }, responseFloorMs: 150,
      attemptLimits: { windowMs: 180000, maxPerRequester: 36, maxPerEmail: 12, retentionMs: 900000, maxEntries: 2000 },
      stock: { quantities: { 'ASTER-DAWN-60': 1000, 'ASTER-NOON-60': 1000, 'ASTER-DUSK-30': 1000 },
        collectedAt: '2000-01-01T00:00:00.000Z', staleAfter: '3000-01-01T00:00:00.000Z', providerRef: 'starter-sandbox', syncRunId: 'starter-demo-v1' },
      tax: { vatRateBps: 0, category: 'standard', legalBasis: 'Fictional local demonstration' },
      sandbox: { dunningTemplateSlug: 'starter-sandbox-refused', recoveryTemplateSlug: 'starter-sandbox-recovered', recoveryUrlPath: '/payment-repair' },
    },
    legal: { revision: 'demo-1', returnsDays: 14, demoOnly: true },
    features: { reviews: true, acquisition: true, research: true, partners: true, risk: false, normalizedIngest: true },
  },
  coffee: {
    id: 'coffee',
    quote: quoteConfigurations.coffee,
    renewal: demoRenewalConfig('coffee'),
    recovery: structuredClone(demoRecoveryConfiguration),
    brand: {
      name: 'Pebble Coffee',
      strapline: { en: 'A fictional coffee shelf', pl: 'Fikcyjna półka z kawą' },
      description: {
        en: 'A demonstration coffee catalogue using the same commerce and subscription engine.',
        pl: 'Demonstracyjny katalog kawy korzystający z tego samego silnika sprzedaży i subskrypcji.',
      },
    },
    theme: { ink: '#352e2a', paper: '#fbf7ef', accent: '#805139', accentInk: '#ffffff', border: '#d9cdbf' },
    copy: {
      heroTitle: { en: 'Choose your next fictional coffee.', pl: 'Wybierz swoją kolejną fikcyjną kawę.' },
      heroBody: {
        en: 'Three illustrative roasts, one shared engine. Try a single order or a recurring box in the sandbox.',
        pl: 'Trzy przykładowe palenia, jeden wspólny silnik. Wypróbuj zakup jednorazowy lub cykliczny pakiet w piaskownicy.',
      },
      offerTitle: { en: 'Make a coffee box', pl: 'Skomponuj pakiet kawy' },
      offerBody: { en: 'Mix the fictional roasts and choose your frequency.', pl: 'Połącz fikcyjne kawy i wybierz częstotliwość.' },
      shippingNote: { en: 'For now this release does not charge shipping on one-off orders.', pl: 'Na razie to wydanie nie pobiera opłat za dostawę zamówień jednorazowych.' },
    },
    media: { hero: '/media/coffee.svg', heroAlt: { en: 'Illustrated coffee bags', pl: 'Ilustracja torebek kawy' } },
    market: { country: 'ZZ', currency: 'XTS', timezone: 'UTC', locales: ['en', 'pl'] },
    offer: {
      layout: 'list', minUnits: 1, maxUnits: 12, shippingMinor: 0,
      freeShippingFromMinor: 0, subscriptionDiscountBps: 500, subscriptionRoundingQuantumMinor: 10, renewalShippingMinor: 0,
      cadenceDays: [14, 28, 56], defaultCadenceDays: 28,
      products: [
        {
          sku: 'PEBBLE-LIGHT-250', slug: 'light-roast', title: 'Light roast',
          physical: { netWeightG: 250, unitGtin: '0000000000048', issuer: 'demo' },
          name: { en: 'Light roast', pl: 'Jasne palenie' },
          description: { en: 'A fictional light roast in a paper bag.', pl: 'Fikcyjna jasno palona kawa w papierowej torebce.' },
          details: { en: 'Illustrative whole-bean coffee. No actual origin, certification or stock is claimed.', pl: 'Przykładowa kawa ziarnista. Bez deklaracji rzeczywistego pochodzenia, certyfikacji lub zapasu.' },
          media: '/media/light.svg', mediaAlt: { en: 'Illustrated light roast bag', pl: 'Ilustracja torebki jasnego palenia' },
          contents: '250 g', unitPrice: { amountMinor: 4200, currency: 'XTS' },
          permittedPurchaseModes: ['one_time', 'subscription'],
        },
        {
          sku: 'PEBBLE-MEDIUM-250', slug: 'medium-roast', title: 'Medium roast',
          physical: { netWeightG: 250, unitGtin: '0000000000055', issuer: 'demo' },
          name: { en: 'Medium roast', pl: 'Średnie palenie' },
          description: { en: 'A fictional medium roast for your demonstration box.', pl: 'Fikcyjna średnio palona kawa do demonstracyjnego pakietu.' },
          details: { en: 'Use this product to test mixed boxes and recurring cadence. No real coffee is supplied.', pl: 'Ten produkt służy do testowania pakietów mieszanych i częstotliwości. Nie dostarczamy rzeczywistej kawy.' },
          media: '/media/medium.svg', mediaAlt: { en: 'Illustrated medium roast bag', pl: 'Ilustracja torebki średniego palenia' },
          contents: '250 g', unitPrice: { amountMinor: 4600, currency: 'XTS' },
          permittedPurchaseModes: ['one_time', 'subscription'],
        },
        {
          sku: 'PEBBLE-DARK-250', slug: 'dark-roast', title: 'Dark roast',
          physical: { netWeightG: 250, unitGtin: '0000000000062', issuer: 'demo' },
          name: { en: 'Dark roast', pl: 'Ciemne palenie' },
          description: { en: 'A fictional dark roast with an illustrated label.', pl: 'Fikcyjna ciemno palona kawa z ilustrowaną etykietą.' },
          details: { en: 'The product, media and prices are fictional demonstration data.', pl: 'Produkt, ilustracje i ceny są fikcyjnymi danymi demonstracyjnymi.' },
          media: '/media/dark.svg', mediaAlt: { en: 'Illustrated dark roast bag', pl: 'Ilustracja torebki ciemnego palenia' },
          contents: '250 g', unitPrice: { amountMinor: 4900, currency: 'XTS' },
          permittedPurchaseModes: ['one_time', 'subscription'],
        },
      ],
    },
    purchase: {
      recoveryMessage: {
        subject: { en: 'Complete your demonstration purchase', pl: 'Dokończ zakup demonstracyjny' },
        body: { en: 'Use this private link to view your order and complete its sandbox payment.', pl: 'Użyj prywatnego linku, aby zobaczyć zamówienie i dokończyć płatność testową.' },
        expiryLabel: { en: 'Link expires at:', pl: 'Link wygasa:' },
        orderLabel: { en: 'Order:', pl: 'Zamówienie:' },
      },
      inputLimits: { text: 200, postalCode: 32, email: 160, name: 64, phone: 32 }, reservationMinutes: 30,
      contact: { acquisitionSource: 'local-demonstration', lifecycleStage: 'lead' }, responseFloorMs: 150,
      attemptLimits: { windowMs: 180000, maxPerRequester: 36, maxPerEmail: 12, retentionMs: 900000, maxEntries: 2000 },
      stock: { quantities: { 'PEBBLE-LIGHT-250': 1000, 'PEBBLE-MEDIUM-250': 1000, 'PEBBLE-DARK-250': 1000 },
        collectedAt: '2000-01-01T00:00:00.000Z', staleAfter: '3000-01-01T00:00:00.000Z', providerRef: 'starter-sandbox', syncRunId: 'starter-demo-v1' },
      tax: { vatRateBps: 0, category: 'standard', legalBasis: 'Fictional local demonstration' },
      sandbox: { dunningTemplateSlug: 'starter-sandbox-refused', recoveryTemplateSlug: 'starter-sandbox-recovered', recoveryUrlPath: '/payment-repair' },
    },
    legal: { revision: 'demo-1', returnsDays: 14, demoOnly: true },
    features: { reviews: true, acquisition: true, research: true, partners: true, risk: false, normalizedIngest: true },
  },
} satisfies Record<string, Omit<StoreConfig, 'subscriptionEditing'>>;

export const configurations: Record<string, StoreConfig> = Object.fromEntries(Object.entries(inputs)
  .map(([id, config]) => [id, { ...config, subscriptionEditing: subscriptionEditing(config.offer.products) }]));

/** The application owns its default identity and registry, including additional brands. */
export const defaultConfigurationId = 'supplements';

export function selectConfiguration(id: string = defaultConfigurationId): StoreConfig {
  const config = Object.hasOwn(configurations, id) ? configurations[id] : undefined;
  if (!config) throw new Error('starter_configuration_unknown');
  return config;
}
