const deferredStylesheetPreloads = document.querySelectorAll<HTMLLinkElement>(
  "link[data-font-stylesheet], link[data-app-stylesheet]",
);

for (const preload of deferredStylesheetPreloads) {
  const activate = () => {
    preload.rel = "stylesheet";
    preload.removeAttribute("as");
    preload.removeAttribute("data-font-stylesheet");
    preload.removeAttribute("data-app-stylesheet");
  };

  if (performance.getEntriesByName(preload.href, "resource").length > 0) {
    activate();
  } else {
    preload.addEventListener("load", activate, { once: true });
  }
}
