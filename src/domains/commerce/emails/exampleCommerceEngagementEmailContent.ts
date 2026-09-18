import type { CommerceEngagementEmailContent } from "./commerceEngagementEmailContent.js";

/** Public/default engagement copy without deployment-specific product assumptions. */
export const exampleCommerceEngagementEmailContent = {
  backInStock: {
    pl: {
      genericLabel: "Wybrany produkt",
      subject: (productLabel) => `Znów dostępne: ${productLabel}`,
      preheader: "Produkt, który Cię zainteresował, jest ponownie dostępny.",
      heading: (productLabel) => `${productLabel} jest znów dostępny`,
      greeting: "Dzień dobry,",
      intro: (productLabel) =>
        `dobra wiadomość – ${productLabel} jest ponownie dostępny i możesz już złożyć zamówienie.`,
      hook: "Sprawdź szczegóły produktu i zamów go, kiedy będziesz gotowy lub gotowa.",
      cta: "Zobacz produkt",
    },
    en: {
      genericLabel: "Your selected product",
      subject: (productLabel) => `Back in stock: ${productLabel}`,
      preheader: "The product you were interested in is available again.",
      heading: (productLabel) => `${productLabel} is back in stock`,
      greeting: "Hello,",
      intro: (productLabel) =>
        `good news – ${productLabel} is available again and ready to order.`,
      hook: "Review the product details and order whenever you're ready.",
      cta: "View product",
    },
  },
  reorderReminder: {
    pl: {
      subject: "Czas uzupełnić zapasy?",
      preheader: "Minął mniej więcej miesiąc od Twojego ostatniego zamówienia.",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      heading: "Potrzebujesz kolejnego zamówienia?",
      intro: (appName) =>
        `minął mniej więcej miesiąc od dostawy z ${appName}. Jeśli zapasy się kończą, możesz wygodnie zamówić kolejną dostawę.`,
      consistencyNote:
        "Regularne uzupełnianie zapasów pomaga uniknąć przerw, a termin kolejnego zamówienia zawsze zależy od Twoich potrzeb.",
      upsellLabel: "Mniej pamiętania, więcej kontroli",
      upsellLines: [
        "Możesz wybrać dostawę cykliczną, aby kolejne zamówienia pojawiały się w ustalonym rytmie.",
        "Subskrypcję możesz wstrzymać, zmienić lub anulować w dowolnej chwili na swoim koncie.",
      ],
      cta: "Zamów ponownie",
    },
    en: {
      subject: "Time to restock?",
      preheader: "It's been about a month since your last order.",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      heading: "Need another order?",
      intro: (appName) =>
        `it's been about a month since your delivery from ${appName}. If you're running low, you can place another order whenever it suits you.`,
      consistencyNote:
        "Regular restocking helps avoid gaps, while the timing of every order remains under your control.",
      upsellLabel: "Less to remember, more control",
      upsellLines: [
        "Choose recurring delivery if you want future orders to arrive on a schedule.",
        "You can pause, change, or cancel a subscription anytime from your account.",
      ],
      cta: "Order again",
    },
  },
  reviewRequest: {
    pl: {
      subject: "Jak oceniasz pierwsze wrażenie?",
      preheader: "Podziel się pierwszym wrażeniem po otrzymaniu zamówienia.",
      heading: "Pierwsze wrażenie?",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: () =>
        "zamówienie dotarło kilka dni temu. Jak oceniasz pierwsze wrażenie?",
      body:
        "Na dłuższą ocenę przyjdzie jeszcze czas. Dziś chcemy poznać Twoje pierwsze doświadczenie po dostawie.",
      cta: "Oceń pierwsze wrażenie",
      outro: "To zajmie mniej niż minutę. Dziękujemy za opinię.",
    },
    en: {
      subject: "How was your first experience?",
      preheader: "Share your first impression after receiving the order.",
      heading: "First impression?",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: () =>
        "your order arrived a few days ago. What was your first impression?",
      body:
        "There will be time for a longer-term assessment later. For now, we'd like to hear about your first experience after delivery.",
      cta: "Rate your first experience",
      outro: "It takes less than a minute. Thank you for sharing your feedback.",
    },
  },
  reviewEffects: {
    pl: {
      subject: "Jak produkt sprawdza się po dwóch tygodniach?",
      preheader: "Podziel się opinią po dłuższym czasie korzystania.",
      heading: "Jak sprawdza się po dłuższym czasie?",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: () =>
        "od dostawy minęły co najmniej dwa tygodnie – to dobry moment, aby ocenić produkt po dłuższym czasie korzystania.",
      body:
        "Czy produkt spełnia Twoje oczekiwania? Będziemy wdzięczni za krótką opinię o tym, co działa dobrze, a co możemy poprawić.",
      cta: "Podziel się opinią",
      outro: "Minuta w zupełności wystarczy. Dziękujemy za pomoc.",
    },
    en: {
      subject: "How is the product working after two weeks?",
      preheader: "Share your experience after using it for a while.",
      heading: "How is it working over time?",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: () =>
        "at least two weeks have passed since delivery, making this a good time to assess the product after longer use.",
      body:
        "Is the product meeting your expectations? We'd appreciate a short review of what works well and what we could improve.",
      cta: "Share your experience",
      outro: "A minute is all it takes. Thank you for helping us improve.",
    },
  },
} satisfies CommerceEngagementEmailContent;
