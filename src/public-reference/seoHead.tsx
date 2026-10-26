import { useEffect, useLayoutEffect } from "react";
import { Helmet } from "react-helmet-async";
import type { buildHeadDescriptor } from "@openlup/platform/marketing";

const useBrowserLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

export function SeoHead({ descriptor, renderMode }: {
  descriptor: ReturnType<typeof buildHeadDescriptor>;
  renderMode: "csr" | "ssg";
}) {
  useBrowserLayoutEffect(() => {
    if (renderMode !== "csr") return;
    document.head
      .querySelectorAll('link[rel="canonical"]:not([data-rh]), link[rel="alternate"]:not([data-rh])')
      .forEach((element) => element.remove());
  }, [renderMode]);

  return (
    <Helmet defer={false}>
      <html lang={descriptor.htmlLang} />
      <title>{descriptor.title}</title>
      {descriptor.tags.map(({ kind, ...attributes }, index) => kind === "meta"
        ? <meta key={index} {...attributes} />
        : <link key={index} {...attributes} />)}
      {descriptor.jsonLd && <script type="application/ld+json">{descriptor.jsonLd}</script>}
    </Helmet>
  );
}
