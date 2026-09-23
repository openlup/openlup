import i18next from "i18next";
import { initReactI18next } from "react-i18next";

/** Only the existing renewal modal's keys are needed by this English reference. */
export function createReferenceI18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: {
      en: {
        account: {
          dashboard: {
            subscriptionV2: {
              holidayNote: "A public holiday may move this estimate later.",
              modals: {
                reschedule: {
                  title: "Change the next renewal date",
                  description: "Choose a planned renewal and charge date between {{from}} and {{to}}. Delivery timing is an estimate, not a promise.",
                  summaryTitle: "Before you confirm",
                  renewalAndCharge: "Planned renewal and charge: {{date}}",
                  estimatedDelivery: "Estimated delivery window, not guaranteed: {{window}}",
                  futureCadence: "Later renewals remain {{days}} days apart after {{date}}.",
                  protectedAlignment: "An outstanding delivery can move this cycle later, never earlier.",
                  confirm: "Confirm renewal date",
                  noDates: "No renewal dates are currently available.",
                  impact: "This changes the next planned renewal and charge. It does not promise a delivery date.",
                  gridLabel: "Choose a planned renewal and charge date",
                  current: "Current date",
                  inDays: "In {{days}} days",
                },
              },
            },
          },
        },
      },
    },
  });
  return instance;
}
