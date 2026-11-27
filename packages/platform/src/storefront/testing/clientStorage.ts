/**
 * Runs in the browser over the document's root element: clears each named
 * storage (`localStorage`, `sessionStorage`) of that document and returns its
 * origin (`"null"` for a document of no origin, such as `about:blank`, or when
 * no root element was found). The page handle passes this function to the page
 * by its source text, so it reads only its arguments and the root element's
 * `ownerDocument.defaultView`, and calls nothing outside itself. A document
 * whose origin may not use a storage throws a `SecurityError` when it is read;
 * that storage is left as it is. Any other failure is rethrown.
 */
export function clientStorage(elements: readonly Element[], names: readonly string[]): string {
  const view = elements[0]?.ownerDocument.defaultView;
  if (view === null || view === undefined) return "null";
  for (const name of names) {
    if (name !== "localStorage" && name !== "sessionStorage") continue;
    try {
      view[name].clear();
    } catch (error) {
      if (typeof error !== "object" || error === null || (error as { name?: unknown }).name !== "SecurityError") throw error;
    }
  }
  return view.location.origin;
}
