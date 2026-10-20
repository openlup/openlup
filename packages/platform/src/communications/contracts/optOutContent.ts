import type { Locale } from "./email.js";

export type OptOutOutcome = "invalid_link" | "marketing_applied" | "missing_information" | "not_found" | "legacy_applied" | "legacy_replay" | "error";
export interface OptOutContent { title: string; message: string }
export type OptOutCopy = Record<OptOutOutcome, Record<Locale, OptOutContent>>;
const defaults: OptOutCopy = {
  invalid_link: { pl: {"title": "Link nieprawidłowy lub wygasł", "message": "Nie udało się przetworzyć tej prośby. Skopiuj pełny link z wiadomości lub napisz na {supportEmail}."}, en: {"title": "Invalid or expired link", "message": "We couldn't process this request. Copy the full link from the email or email {supportEmail}."} },
  marketing_applied: { pl: {"title": "Wypisano", "message": "Nie będziesz już otrzymywać tych wiadomości marketingowych. Wiadomości potrzebne do obsługi konta, zamówień, płatności i subskrypcji mogą nadal przychodzić."}, en: {"title": "You're unsubscribed", "message": "You won't receive these marketing emails anymore. Messages needed to manage your account, orders, payments and subscriptions may still arrive."} },
  missing_information: { pl: {"title": "Brakuje danych", "message": "Nieprawidłowy link do wypisania."}, en: {"title": "Missing information", "message": "This unsubscribe link is incomplete."} },
  not_found: { pl: {"title": "Nie znaleziono", "message": "Nie znaleziono takiego zgłoszenia."}, en: {"title": "Not found", "message": "We couldn't find this request."} },
  legacy_applied: { pl: {"title": "Wypisano", "message": "Zapisaliśmy Twoją rezygnację z wybranych wiadomości. Wiadomości potrzebne do obsługi konta, zamówień, płatności i subskrypcji mogą nadal przychodzić."}, en: {"title": "You're unsubscribed", "message": "We've recorded your opt-out from the selected messages. Messages needed to manage your account, orders, payments and subscriptions may still arrive."} },
  legacy_replay: { pl: {"title": "Już wypisano", "message": "Twoja rezygnacja z wybranych wiadomości jest już zapisana. Wiadomości potrzebne do obsługi konta, zamówień, płatności i subskrypcji mogą nadal przychodzić."}, en: {"title": "Already unsubscribed", "message": "Your opt-out from the selected messages is already recorded. Messages needed to manage your account, orders, payments and subscriptions may still arrive."} },
  error: { pl: {"title": "Błąd", "message": "Coś poszło nie tak. Spróbuj ponownie później."}, en: {"title": "Error", "message": "Something went wrong. Try again later."} },
};

/** Display only; the caller independently verifies and durably records opt-out. */
export function createOptOutContentFactory(copy: OptOutCopy = defaults) {
  function optOutContent(locale: Locale, outcome: OptOutOutcome, supportEmail: string): OptOutContent {
    const c = copy[outcome][locale];
    return { title: c.title, message: c.message.split("{supportEmail}").join(supportEmail) };
  }
  return { optOutContent };
}
