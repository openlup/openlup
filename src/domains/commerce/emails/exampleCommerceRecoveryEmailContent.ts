import type { CommerceRecoveryEmailContent } from "./commerceEngagementEmailContent.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";

const localized = <T>(primary: T, secondary: T): Record<Locale, T> => ({
  pl: primary,
  en: secondary,
});

/** Public/default cart and checkout-recovery copy for a generic commerce deployment. */
export const exampleCommerceRecoveryEmailContent: CommerceRecoveryEmailContent = {
  abandonedCart: localized(
    {
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      first: {
        subject: "Twoje zamówienie jest zapisane",
        preheader: "Możesz wrócić i dokończyć zamówienie w dogodnym momencie.",
        heading: "Zamówienie czeka na dokończenie",
        intro: "zapisaliśmy rozpoczęte zamówienie, ale nie zostało jeszcze dokończone.",
        body: "Wróć do koszyka, gdy będziesz gotowy lub gotowa – zapisany wybór nadal tam będzie.",
        cta: "Dokończ zamówienie",
      },
      gentle: {
        subject: "Twoje zapisane zamówienie nadal czeka",
        preheader: "Wróć do koszyka, gdy będziesz gotowy lub gotowa.",
        heading: "Zapisane zamówienie czeka",
        intro: "rozpoczęte zamówienie nie zostało jeszcze dokończone.",
        body: "Nic nie musisz robić teraz. Możesz wrócić do zapisanego koszyka w dogodnym momencie.",
        cta: "Dokończ zamówienie",
      },
      last: {
        subject: "Ostatnie przypomnienie o zapisanym zamówieniu",
        preheader: "To ostatnie przypomnienie; do zamówienia możesz wrócić później.",
        heading: "Ostatnie przypomnienie",
        intro: "to ostatnie przypomnienie o rozpoczętym zamówieniu.",
        body: "Jeśli to nie jest dobry moment, nie musisz nic robić. Do sklepu możesz wrócić, kiedy zechcesz.",
        cta: "Wróć do zamówienia",
      },
    },
    {
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      first: {
        subject: "Your order is saved",
        preheader: "Return and complete your order whenever you're ready.",
        heading: "Your order is waiting",
        intro: "we saved the order you started, but it has not been completed yet.",
        body: "Return to your cart whenever you're ready – your saved selection will still be there.",
        cta: "Complete your order",
      },
      gentle: {
        subject: "Your saved order is still waiting",
        preheader: "Return to your cart whenever you're ready.",
        heading: "Your saved order is waiting",
        intro: "the order you started has not been completed yet.",
        body: "There is nothing you need to do now. You can return to your saved cart when it suits you.",
        cta: "Complete your order",
      },
      last: {
        subject: "A final reminder about your saved order",
        preheader: "This is the final reminder; you can return later.",
        heading: "A final reminder",
        intro: "this is the final reminder about the order you started.",
        body: "If now is not a good time, there is nothing you need to do. You can return to the shop whenever you like.",
        cta: "Return to your order",
      },
    },
  ),
  checkoutExpired: {
    expired: localized(
      {
        subject: (orderRef) => `Rezerwacja zamówienia ${orderRef} wygasła`,
        preheader: "Rezerwacja zamówienia wygasła – możesz rozpocząć nowe zamówienie.",
        heading: "Rezerwacja wygasła",
        greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
        intro: (orderRef) =>
          `płatność za zamówienie (${orderRef}) nie została dokończona w dostępnym czasie. Rezerwacja wygasła i nie pobraliśmy żadnej opłaty.`,
        detailsLabel: "Co dalej?",
        details: (amountLabel) => [
          amountLabel ? `Kwota poprzedniego zamówienia: ${amountLabel}.` : "Poprzednie zamówienie nie jest już aktywne.",
          "Aby kontynuować zakupy, rozpocznij nowe zamówienie.",
        ],
        cta: "Rozpocznij nowe zamówienie",
        outro: "Jeśli to pomyłka lub potrzebujesz pomocy, odpowiedz na tę wiadomość.",
      },
      {
        subject: (orderRef) => `Your reserved order ${orderRef} expired`,
        preheader: "The order reservation expired – you can start a new order.",
        heading: "Reserved order expired",
        greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
        intro: (orderRef) =>
          `payment for order ${orderRef} was not completed in time. The reservation expired, and we have not charged you.`,
        detailsLabel: "What's next?",
        details: (amountLabel) => [
          amountLabel ? `Previous order total: ${amountLabel}.` : "The previous order is no longer active.",
          "To continue shopping, start a new order.",
        ],
        cta: "Start a new order",
        outro: "If this was a mistake or you need help, reply to this email.",
      },
    ),
    recovery: localized(
      {
        subject: (orderRef) => `Dokończ płatność za zamówienie ${orderRef}`,
        preheader: "Twoje zamówienie czeka – wróć do bezpiecznego kroku płatności.",
        heading: "Dokończ płatność",
        greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
        intro: (orderRef) =>
          `nie mamy potwierdzenia zakończenia płatności za zamówienie (${orderRef}). Link poniżej pozwoli bezpiecznie sprawdzić jej stan i ją dokończyć.`,
        detailsLabel: "Co dalej?",
        details: (amountLabel) => [
          amountLabel ? `Kwota zamówienia: ${amountLabel}.` : "Zamówienie jest gotowe do ponownego sprawdzenia płatności.",
          "Jeśli zawartość, cena lub dostępność zmieniły się po drodze, poprosimy o ponowne sprawdzenie zamówienia.",
        ],
        cta: "Dokończ płatność",
        outro: "Jeśli link nie działa albo potrzebujesz pomocy, odpowiedz na tę wiadomość.",
      },
      {
        subject: (orderRef) => `Complete payment for order ${orderRef}`,
        preheader: "Your order is waiting – return to the secure payment step.",
        heading: "Complete payment",
        greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
        intro: (orderRef) =>
          `we do not have confirmation that payment for order ${orderRef} was completed. The link below lets you securely check its status and complete it.`,
        detailsLabel: "What's next?",
        details: (amountLabel) => [
          amountLabel ? `Order total: ${amountLabel}.` : "Your order is ready for another payment check.",
          "If the contents, price, or availability changed meanwhile, we will ask you to review the order again.",
        ],
        cta: "Complete payment",
        outro: "If the link does not work or you need help, reply to this email.",
      },
    ),
  },
  checkoutRecovery: localized(
    {
      greeting: (firstName) => (firstName ? `Cześć ${firstName},` : "Dzień dobry,"),
      cta: "Dokończ płatność",
      subjectFirst: "Dokończ swoje zamówienie",
      subjectFinal: "Rezerwacja zamówienia kończy się dziś",
      preheader: "Twoje zamówienie czeka – brakuje tylko płatności.",
      headingFirst: "Jeszcze tylko płatność",
      headingFinal: "Rezerwacja zamówienia wkrótce wygaśnie",
      introSubscription:
        "Twoja subskrypcja jest prawie gotowa – dokończ pierwszą płatność, aby ją aktywować i ustalić termin pierwszej dostawy.",
      introOneTime: "Twoje zamówienie jest prawie gotowe – brakuje tylko zakończenia płatności.",
      contextCheer: () => "Po potwierdzeniu płatności zamówienie przejdzie do realizacji.",
      subscriptionCheer: () => "Po potwierdzeniu płatności subskrypcja zostanie aktywowana.",
      finalNote:
        "Zamówienie rezerwujemy na 24 godziny. Po tym czasie zostanie anulowane, ale zawsze możesz rozpocząć nowe.",
    },
    {
      greeting: (firstName) => (firstName ? `Hi ${firstName},` : "Hello,"),
      cta: "Complete payment",
      subjectFirst: "Complete your order",
      subjectFinal: "Your order reservation ends today",
      preheader: "Your order is waiting – only payment remains.",
      headingFirst: "Complete payment",
      headingFinal: "Your order reservation is about to expire",
      introSubscription:
        "Your subscription is almost ready – complete the first payment to activate it and schedule the first delivery.",
      introOneTime: "Your order is almost ready – only payment remains.",
      contextCheer: () => "Once payment is confirmed, the order can move to fulfilment.",
      subscriptionCheer: () => "Once payment is confirmed, the subscription will be activated.",
      finalNote:
        "We reserve the order for 24 hours. After that it will be canceled, but you can always start a new order.",
    },
  ),
};
