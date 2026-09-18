import type { CommerceFulfillmentEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";

const localized = <T>(primary: T, secondary: T): Record<Locale, T> => ({
  pl: primary,
  en: secondary,
});

/** Public/default fulfillment and return copy, usable by any commerce deployment. */
export const exampleCommerceFulfillmentEmailContent: CommerceFulfillmentEmailContent = {
  shipmentDispatched: localized(
    {
      subject: (orderRef) => `Przesyłka (${orderRef}) jest w drodze`,
      preheader: "Nadaliśmy przesyłkę – możesz ją śledzić.",
      heading: "Przesyłka jest w drodze",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderRef) => `Twoje zamówienie (${orderRef}) zostało przekazane przewoźnikowi.`,
      trackingLabel: "Numer przesyłki",
      trackParcel: "Śledź przesyłkę",
      noTrackingLabel: "Status przesyłki",
      noTracking: [
        "Twoja przesyłka została nadana i jest w drodze.",
        "Numer śledzenia powinien przekazać przewoźnik.",
      ],
      accountGuide: {
        eyebrow: "Przewodnik po koncie",
        title: "Poznaj swoje konto",
        text: () =>
          "Zanim przesyłka dotrze, zobacz, jak korzystać z konta: podgląd zamówień, adresy i ustawienia w jednym miejscu.",
        cta: "Otwórz przewodnik",
        path: "/guides/account.pdf",
      },
      outro: () => "Jeśli masz pytania dotyczące dostawy, odpowiedz na tę wiadomość.",
    },
    {
      subject: (orderRef) => `Your shipment (${orderRef}) is on its way`,
      preheader: "We've shipped your order – you can track it.",
      heading: "Your shipment is on its way",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderRef) => `Your order (${orderRef}) has been handed to the carrier.`,
      trackingLabel: "Tracking number",
      trackParcel: "Track shipment",
      noTrackingLabel: "Shipment status",
      noTracking: [
        "Your shipment has been sent and is on its way.",
        "The carrier should provide the tracking number.",
      ],
      accountGuide: {
        eyebrow: "Account guide",
        title: "Get to know your account",
        text: () =>
          "While the shipment travels, see how your account works: orders, addresses and settings in one place.",
        cta: "Open the guide",
        path: "/guides/account.pdf",
      },
      outro: () => "If you have questions about delivery, reply to this email.",
    },
  ),
  shipmentDelivered: localized(
    {
      subject: (orderRef) => `Przesyłka (${orderRef}) została dostarczona`,
      preheader: "Przesyłka dotarła – zobacz, jak dobrze zacząć.",
      heading: "Przesyłka dostarczona",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderRef) => `Twoje zamówienie (${orderRef}) zostało dostarczone.`,
      startGuide: {
        eyebrow: "Na dobry początek",
        title: "Przewodnik po pierwszych krokach",
        text: () =>
          "Przygotowaliśmy krótki przewodnik, który pomoże Ci dobrze zacząć. Zajrzyj do niego, zanim otworzysz przesyłkę.",
        cta: "Otwórz przewodnik",
        path: "/guides/getting-started.pdf",
      },
      outro: "Coś nie tak z przesyłką? Odpowiedz na tę wiadomość – chętnie pomożemy.",
    },
    {
      subject: (orderRef) => `Your shipment (${orderRef}) has been delivered`,
      preheader: "Your shipment has arrived – here's how to get started.",
      heading: "Shipment delivered",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderRef) => `Your order (${orderRef}) has been delivered.`,
      startGuide: {
        eyebrow: "Getting started",
        title: "Your first-steps guide",
        text: () =>
          "We've prepared a short guide to help you get started. Have a look before you open the shipment.",
        cta: "Open the guide",
        path: "/guides/getting-started.pdf",
      },
      outro: "Something not right with your shipment? Reply to this email and we'll help.",
    },
  ),
  shipmentException: localized(
    {
      subject: (orderRef) => `Twoja przesyłka ${orderRef} wyjedzie z opóźnieniem`,
      preheader: "Nasz zespół już działa – nie musisz nic robić.",
      heading: "Potrzebujemy chwili dłużej",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderRef) =>
        `przy przygotowaniu zamówienia (${orderRef}) napotkaliśmy drobny problem, więc wysyłka potrwa trochę dłużej. Przepraszamy!`,
      reassuranceLabel: "Co dalej",
      reassurance: [
        "Nasz zespół już się tym zajmuje – z Twojej strony nie jest potrzebne żadne działanie.",
        "Damy znać, gdy tylko przesyłka ruszy w drogę. Gdyby pojawiło się coś, co wymaga Twojej decyzji, odezwiemy się.",
      ],
      cta: "Zobacz status zamówienia",
      outro: "Masz pytania? Odpowiedz na tę wiadomość – chętnie pomożemy.",
    },
    {
      subject: (orderRef) => `We're working on your order ${orderRef}`,
      preheader: "We're already on it – there's nothing you need to do.",
      heading: "We're working on your shipment",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderRef) =>
        `We hit a small snag while preparing your order (${orderRef}), so shipment is taking a little longer.`,
      reassuranceLabel: "What happens next?",
      reassurance: [
        "Our team is already on it – there's nothing you need to do.",
        "We'll let you know as soon as your shipment is on its way. If anything needs your decision, we'll reach out to you.",
      ],
      cta: "View your order",
      outro: "Questions, or something not right? Reply to this email and we'll help.",
    },
  ),
  returns: {
    approved: localized(
      {
        subject: (orderRef) => `Zwrot do zamówienia ${orderRef} został zaakceptowany`,
        preheader: "Zwrot zaakceptowany – sprawdź instrukcję i kolejne kroki.",
        heading: "Zwrot zaakceptowany",
        greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Cześć,"),
        intro: (orderRef) =>
          `Zaakceptowaliśmy Twój wniosek o zwrot do zamówienia ${orderRef}. Zanim cokolwiek odeślesz, otwórz instrukcję zwrotu – znajdziesz tam kolejne kroki, zasady pakowania i informacje o wysyłce.`,
        returnAddressNotice:
          "Jeśli nie masz jeszcze potwierdzonego adresu zwrotu, odpisz na ten mail przed nadaniem paczki. Zachowaj potwierdzenie nadania do czasu, aż poinformujemy Cię mailem o wyniku.",
        cta: "Zobacz instrukcję zwrotu",
      },
      {
        subject: (orderRef) => `Your return for order ${orderRef} is approved`,
        preheader: "Return approved – see the guide and next steps.",
        heading: "Return approved",
        greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hi,"),
        intro: (orderRef) =>
          `We've approved your return request for order ${orderRef}. Before sending anything back, open the returns guide for the next steps, packing guidance, and shipping details.`,
        returnAddressNotice:
          "If you have not received a confirmed return address yet, reply to this email before shipping. Keep proof of shipping until we email you with the outcome.",
        cta: "Open returns guide",
      },
    ),
    rejected: localized(
      {
        subject: (orderRef) => `Aktualizacja zwrotu do zamówienia ${orderRef}`,
        preheader: "Aktualizacja Twojego wniosku o zwrot.",
        heading: "W sprawie Twojego zwrotu",
        greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Cześć,"),
        intro: (orderRef) =>
          `Rozpatrzyliśmy Twój wniosek o zwrot do zamówienia ${orderRef} i niestety nie możemy go przyjąć. Jeśli uważasz, że to pomyłka lub masz pytania, odpisz na tego maila – pomożemy.`,
        cta: "Moje zamówienia",
      },
      {
        subject: (orderRef) => `Update on your return for order ${orderRef}`,
        preheader: "An update on your return request.",
        heading: "About your return",
        greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hi,"),
        intro: (orderRef) =>
          `We've reviewed your return request for order ${orderRef} and unfortunately we're unable to accept it. If you think this is a mistake or you have questions, just reply to this email and we'll help.`,
        cta: "View my orders",
      },
    ),
    refunded: localized(
      {
        subject: (orderRef) => `Zwrot środków za zamówienie ${orderRef} w drodze`,
        preheader: "Zwrot środków został wystawiony.",
        heading: "Zwrot środków wystawiony",
        greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Cześć,"),
        amountKnown: (amountLabel, orderRef) =>
          `Wystawiliśmy zwrot środków w wysokości ${amountLabel} za zamówienie ${orderRef}. Środki powinny pojawić się na Twoim koncie w ciągu kilku dni roboczych, zależnie od banku.`,
        amountUnknown: (orderRef) =>
          `Wystawiliśmy zwrot środków za zamówienie ${orderRef}. Środki powinny pojawić się na Twoim koncie w ciągu kilku dni roboczych, zależnie od banku.`,
        returnNote: "Jeśli zdecydujesz się wrócić, zapraszamy ponownie.",
        cta: "Wróć do sklepu",
      },
      {
        subject: (orderRef) => `Your refund for order ${orderRef} is on its way`,
        preheader: "Your refund has been issued.",
        heading: "Refund issued",
        greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hi,"),
        amountKnown: (amountLabel, orderRef) =>
          `We've issued a refund of ${amountLabel} for your return on order ${orderRef}. It should appear on your statement within a few business days, depending on your bank.`,
        amountUnknown: (orderRef) =>
          `We've issued your refund for the return on order ${orderRef}. It should appear on your statement within a few business days, depending on your bank.`,
        returnNote: "If you decide to return, you're welcome again.",
        cta: "Back to shop",
      },
    ),
  },
};
