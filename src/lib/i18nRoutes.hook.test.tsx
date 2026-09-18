import { renderHook } from "@testing-library/react";
import { createInstance } from "i18next";
import { type PropsWithChildren } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { useLocalizedPath } from "@/lib/i18nRoutes";

function renderLocalizedPath(language: string) {
  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: false,
    initAsync: false,
  });
  const Wrapper = ({ children }: PropsWithChildren) => (
    <I18nextProvider i18n={instance}>{children}</I18nextProvider>
  );
  return renderHook(() => useLocalizedPath(), { wrapper: Wrapper });
}

describe("useLocalizedPath", () => {
  it("uses the English route set when i18n is set to English", () => {
    const { result } = renderLocalizedPath("en");

    expect(result.current("productLamb")).toBe("/dogs/lamb");
  });

  it("falls back to Polish for every other language", () => {
    const { result } = renderLocalizedPath("de");

    expect(result.current("science")).toBe("/jak-to-dziala");
  });
});
