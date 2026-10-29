import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/account.js";
import pl from "./locales/pl/account.js";

export const DEFAULT_REFERENCE_LANGUAGE = "en";

export function createReferenceI18n(language = DEFAULT_REFERENCE_LANGUAGE) {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: language, fallbackLng: DEFAULT_REFERENCE_LANGUAGE, initAsync: false,
    interpolation: { escapeValue: false },
    resources: { en: { account: en }, pl: { account: pl } },
  });
  return instance;
}
