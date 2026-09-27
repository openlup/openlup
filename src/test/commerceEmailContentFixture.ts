import type { CommerceEmailContent } from "../domains/commerce/emails/commerceEmailContent.js";

/** Explicit synthetic presentation for adapter-to-content forwarding tests. */
export function createCommerceEmailContentFixture(defaults: CommerceEmailContent): CommerceEmailContent { return {
  ...defaults,
  checkoutRecovery: { ...defaults.checkoutRecovery, pl: { ...defaults.checkoutRecovery.pl, contextCheer: (name) => `Potwierdzenie dla ${name ?? "klienta"}` } },
  orderPaid: { ...defaults.orderPaid, pl: { ...defaults.orderPaid.pl,
    subject: (ref) => `Mamy Wasze zamówienie ${ref}`,
    receiptNote: (name) => `Potwierdzenie dla ${name ?? "klienta"}`,
  } },
  paymentFailed: { ...defaults.paymentFailed, pl: { ...defaults.paymentFailed.pl,
    details: (amount, mode) => [amount ?? "Kwota w linku", mode === "subscription_cycle"
      ? "dla tej subskrypcji – bez składania koszyka od nowa" : "dla tego zamówienia"],
  } },
  shipmentDispatched: { ...defaults.shipmentDispatched, pl: { ...defaults.shipmentDispatched.pl,
    subject: (ref) => `Przesyłka ${ref} ruszyła w drogę`, heading: "Paczka w drodze",
    accountGuide: { ...defaults.shipmentDispatched.pl.accountGuide,
      path: "/porady/pliki/przewodnik-po-koncie-klienta.pdf", text: (name) => `Konto dla ${name ?? "klienta"}`,
    },
  } },
  shipmentDelivered: { ...defaults.shipmentDelivered, pl: { ...defaults.shipmentDelivered.pl,
    subject: (ref) => `Przesyłka ${ref} dotarła`, heading: "Paczka dostarczona",
    startGuide: { ...defaults.shipmentDelivered.pl.startGuide,
      text: (name) => `Pierwsze kroki dla ${name ?? "klienta"}`,
      path: "/porady/pliki/jak-wprowadzic-nowa-karme.pdf",
      image: { path: "/porady/pliki/okladka-jak-wprowadzic-nowa-karme.jpg", alt: "Test guide", widthPx: 320, heightPx: 200 },
    },
  } },
}; }
