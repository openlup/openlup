import { type ImgHTMLAttributes, useEffect, useRef, useState } from "react";

import { useRenderRuntime } from "@/app/renderMode";

interface LazyViewportImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "loading" | "src"> {
  src: string;
  rootMargin?: string;
}

export function LazyViewportImage({
  src,
  rootMargin = "240px 0px",
  ...props
}: LazyViewportImageProps) {
  const { mode } = useRenderRuntime();
  const shouldLoadInitially = mode === "ssg";
  const imageRef = useRef<HTMLImageElement>(null);
  const [shouldLoad, setShouldLoad] = useState(shouldLoadInitially);

  useEffect(() => {
    if (shouldLoadInitially) return undefined;
    const node = imageRef.current;
    if (!node) return undefined;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin, shouldLoadInitially]);

  const fallbackHtml = `<img src="${escapeHtml(src)}" alt="${escapeHtml(
    typeof props.alt === "string" ? props.alt : "",
  )}"${renderAttribute("width", props.width)}${renderAttribute(
    "height",
    props.height,
  )}${renderAttribute("class", props.className)} loading="lazy" decoding="async">`;

  return (
    <>
      <img
        {...props}
        ref={imageRef}
        src={shouldLoad ? src : undefined}
        data-src={shouldLoad ? undefined : src}
        loading="lazy"
        decoding="async"
      />
      <noscript dangerouslySetInnerHTML={{ __html: fallbackHtml }} />
    </>
  );
}

function renderAttribute(name: string, value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? ` ${name}="${escapeHtml(String(value))}"`
    : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
