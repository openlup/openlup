import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/account";
import pl from "./locales/pl/account";

export function createReferenceI18n(language = "en") {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: language, fallbackLng: "en", initAsync: false,
    interpolation: { escapeValue: false },
    resources: { en: { account: en }, pl: { account: pl } },
  });
  return instance;
}
