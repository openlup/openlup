import { createElement, type PropsWithChildren } from "react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

/** Each suite supplies its own copy; no adopter locale or global instance is loaded. */
export function createI18nFixture(resources: Record<string, Record<string, string>>) {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    lng: "pl", fallbackLng: false, initAsync: false,
    keySeparator: false, resources: { pl: resources },
    interpolation: { escapeValue: false },
  });
  return function I18nFixture({ children }: PropsWithChildren) {
    return createElement(I18nextProvider, { i18n }, children);
  };
}
