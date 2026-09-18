import type { CommerceEmailContent } from "./commerceEmailContent.js";
import { exampleCommerceEngagementEmailContent } from "./exampleCommerceEngagementEmailContent.js";
import { exampleCommerceFulfillmentEmailContent } from "./exampleCommerceFulfillmentEmailContent.js";
import { exampleCommerceRecoveryEmailContent } from "./exampleCommerceRecoveryEmailContent.js";

/** Public/default transactional copy, usable by any commerce deployment. */
const content: CommerceEmailContent = {
  id: "example",
  orderRefPrefix: "ORDER",
  orderDraft: {
    pl: {
      subject: (orderId) => `Zapisaliśmy Twoje zamówienie ${orderId} – dokończ je`,
      preheader: "Twoje zamówienie czeka na dokończenie.",
      heading: "Zapisaliśmy Twoje zamówienie",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderId) =>
        `zapisaliśmy Twoje zamówienie (${orderId}). Możesz dokończyć je, kiedy będziesz gotowy lub gotowa. Oto podsumowanie:`,
      itemsLabel: "Pozycje zamówienia",
      noItems: "Twoje zamówienie jest zapisane i czeka na dokończenie.",
      subtotalLabel: "Suma częściowa",
      discountRowLabel: "Rabat",
      totalLabel: "Razem",
      cta: "Dokończ zamówienie",
      outro: "Wróć do koszyka, kiedy zechcesz – wybrane pozycje będą na Ciebie czekać.",
      personalizedClosing: (name) => `Zapisaliśmy ten wybór także z myślą o **${name}**.`,
    },
    en: {
      subject: (orderId) => `We saved your order ${orderId} – complete it when you're ready`,
      preheader: "Your order is waiting for you to complete it.",
      heading: "We saved your order",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderId) =>
        `we saved your order (${orderId}). Complete it whenever you're ready. Here's the summary:`,
      itemsLabel: "Order items",
      noItems: "Your order is saved and waiting for you to complete it.",
      subtotalLabel: "Subtotal",
      discountRowLabel: "Discount",
      totalLabel: "Total",
      cta: "Complete your order",
      outro: "Return to your cart whenever you like – your selected items will be waiting.",
      personalizedClosing: (name) => `We've saved this choice with **${name}** in mind.`,
    },
  },
  orderPaid: {
    pl: {
      subject: (orderId) => `Potwierdzenie zamówienia ${orderId}`,
      preheader: "Zamówienie zostało opłacone i potwierdzone.",
      heading: "Zamówienie potwierdzone",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      introOneTime: (orderId) =>
        `potwierdzamy płatność za Twoje zamówienie (${orderId}). Oto podsumowanie:`,
      introSubscription: (orderId) =>
        `potwierdzamy płatność za kolejny cykl subskrypcji (${orderId}). Oto podsumowanie:`,
      noItems: "Twoje zamówienie zostało potwierdzone.",
      subtotalLabel: "Suma częściowa",
      catalogProductsLabel: "Cena katalogowa produktów",
      discountRowLabel: "Rabat w zamówieniu",
      firstSubscriptionDiscountRowLabel: "Rabat na pierwszą subskrypcję",
      productPayableLabel: "Produkty po rabacie",
      shippingLabel: "Dostawa",
      shippingFree: "Gratis",
      totalLabel: "Do zapłaty",
      finalPaidLabel: "Razem zapłacono",
      cta: "Zobacz zamówienie",
      receiptNote: () => "Dziękujemy za zamówienie. Prześlemy kolejną aktualizację, gdy jego status się zmieni.",
      outro: "W razie pytań odpowiedz na tę wiadomość.",
      withdrawalNotice:
        "Jako konsument masz prawo odstąpić od umowy zawartej na odległość w terminie 14 dni bez podania przyczyny. Zasady, wyjątki, procedura zwrotu oraz wzór formularza odstąpienia znajdziesz w regulaminie sklepu.",
      withdrawalLinkLabel: "Regulamin sklepu i formularz odstąpienia",
    },
    en: {
      subject: (orderId) => `Order confirmation ${orderId}`,
      preheader: "Your order has been paid and confirmed.",
      heading: "Order confirmed",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      introOneTime: (orderId) =>
        `we're confirming payment for your order (${orderId}). Here's the summary:`,
      introSubscription: (orderId) =>
        `we're confirming payment for your next subscription cycle (${orderId}). Here's the summary:`,
      noItems: "Your order has been confirmed.",
      subtotalLabel: "Subtotal",
      catalogProductsLabel: "Catalogue price of products",
      discountRowLabel: "Order discount",
      firstSubscriptionDiscountRowLabel: "First subscription discount",
      productPayableLabel: "Products after discount",
      shippingLabel: "Shipping",
      shippingFree: "Free",
      totalLabel: "Total due",
      finalPaidLabel: "Total paid",
      cta: "View your order",
      receiptNote: () => "Thank you for your order. We'll send another update when its status changes.",
      outro: "If you have questions, reply to this email.",
      withdrawalNotice:
        "As a consumer, you may withdraw from a distance contract within 14 days without giving a reason. The rules, exceptions, return procedure and model withdrawal form are available in the shop terms.",
      withdrawalLinkLabel: "Shop terms and model withdrawal form",
    },
  },
  orderCanceled: {
    pl: {
      subject: (orderId) => `Twoje zamówienie ${orderId} zostało anulowane`,
      preheader: "Twoje zamówienie zostało anulowane.",
      heading: "Zamówienie anulowane",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderId) => `Twoje zamówienie (${orderId}) zostało anulowane.`,
      detailsLabel: "Szczegóły",
      details: (amountLabel) =>
        amountLabel
          ? [
              `Kwota zamówienia: ${amountLabel}.`,
              "Ta wiadomość nie uruchamia automatycznego zwrotu. Jeśli płatność została pobrana, potwierdzimy zwrot osobnym mailem po weryfikacji.",
            ]
          : [
              "Zamówienie nie będzie realizowane.",
              "Jeśli płatność została pobrana, potwierdzimy zwrot osobnym mailem po weryfikacji.",
            ],
      returnNote: () => "Jeśli zechcesz wrócić, zapraszamy w każdej chwili.",
      cta: "Wróć do sklepu",
      outro: "Masz pytania lub to pomyłka? Po prostu odpisz na tego maila – pomożemy.",
    },
    en: {
      subject: (orderId) => `Your order ${orderId} has been canceled`,
      preheader: "Your order has been canceled.",
      heading: "Order canceled",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderId) => `Your order (${orderId}) has been canceled.`,
      detailsLabel: "Details",
      details: (amountLabel) =>
        amountLabel
          ? [
              `Order total: ${amountLabel}.`,
              "This message does not start an automatic refund. If you were charged, we'll confirm any refund separately after review.",
            ]
          : [
              "This order will not be fulfilled.",
              "If you were charged, we'll confirm any refund separately after review.",
            ],
      returnNote: () => "If you decide to return, you're welcome at any time.",
      cta: "Back to shop",
      outro: "Questions, or was this a mistake? Just reply to this email – we're happy to help.",
    },
  },
  orderRefunded: {
    pl: {
      subject: (orderId) => `Zwrot za zamówienie ${orderId} został zrealizowany`,
      preheader: "Twój zwrot został zrealizowany.",
      heading: "Zwrot zrealizowany",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderId) => `Zrealizowaliśmy zwrot za Twoje zamówienie (${orderId}).`,
      detailsLabel: "Szczegóły zwrotu",
      details: (amountLabel) => [
        amountLabel ? `Kwota zwrotu: ${amountLabel}.` : "Zwrot został przetworzony.",
        "Pieniądze wrócą na Twoje konto w ciągu kilku dni roboczych – czas zależy od banku.",
      ],
      returnNote: () => "Jeśli zdecydujesz się wrócić, zapraszamy ponownie.",
      cta: "Wróć do sklepu",
      outro: "Masz pytania dotyczące zwrotu? Po prostu odpisz na tego maila – chętnie pomożemy.",
    },
    en: {
      subject: (orderId) => `Your refund for order ${orderId} has been processed`,
      preheader: "Your refund has been processed.",
      heading: "Refund processed",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderId) => `We've processed the refund for your order (${orderId}).`,
      detailsLabel: "Refund details",
      details: (amountLabel) => [
        amountLabel ? `Refund amount: ${amountLabel}.` : "Your refund has been processed.",
        "The money will return to your payment method within a few business days – timing depends on your bank.",
      ],
      returnNote: () => "If you decide to return, you're welcome again.",
      cta: "Back to shop",
      outro: "Questions about your refund? Just reply to this email – we're happy to help.",
    },
  },
  paymentFailed: {
    pl: {
      subject: (orderId) => `Płatność za zamówienie ${orderId} nie przeszła`,
      preheader: "Dokończ płatność bez rozpoczynania nowego zamówienia.",
      heading: "Płatność nie przeszła",
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      intro: (orderId) =>
        `bank odrzucił płatność za zamówienie (${orderId}), ale kontekst zamówienia pozostaje aktywny.`,
      detailsLabel: "Co możesz zrobić",
      details: (amountLabel, mode) => [
        amountLabel
          ? `Kwota do opłacenia: ${amountLabel}.`
          : "Kwota zostanie pokazana ponownie po otwarciu bezpiecznego linku.",
        mode === "subscription_cycle"
          ? "Przejdziesz do konta i naprawisz płatność dla tej subskrypcji bez tworzenia nowego koszyka."
          : "Link poniżej prowadzi do bezpiecznej płatności za to samo zamówienie.",
      ],
      cta: "Dokończ płatność",
      outro: "Jeśli potrzebujesz pomocy, odpowiedz na tę wiadomość.",
    },
    en: {
      subject: (orderId) => `Payment for order ${orderId} failed`,
      preheader: "Complete payment without starting a new order.",
      heading: "Payment failed",
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      intro: (orderId) =>
        `payment for order ${orderId} was declined, but the order context is still active.`,
      detailsLabel: "What you can do",
      details: (amountLabel, mode) => [
        amountLabel ? `Amount to pay: ${amountLabel}.` : "The amount will be shown again when you open the secure link.",
        mode === "subscription_cycle"
          ? "You'll go to your account to fix payment for this subscription without creating a new cart."
          : "You'll go to a secure payment link for the same order.",
      ],
      cta: "Complete payment",
      outro: "If you need help, reply to this email.",
    },
  },
  ...exampleCommerceRecoveryEmailContent,
  ...exampleCommerceEngagementEmailContent,
  ...exampleCommerceFulfillmentEmailContent,
};

export const commerceEmailContent = Object.freeze(content);
