/**
 * Measures anchors in the browser. The page handle passes this function to the
 * page by its source text, so it reads only its arguments and each element's
 * `ownerDocument` and `defaultView`, and calls nothing outside itself.
 *
 * Each element is scrolled into view, then measured: its box, whether the box
 * lies inside the page's scrollable area, whether it is hidden (`display: none`
 * or a `hidden` attribute up the tree, or an inherited `visibility` other than
 * `visible`), whether the product of its and its ancestors' opacity is 0, and
 * whether the element hit at its centre is neither the anchor, a descendant nor
 * an ancestor. `attributes` lists the attribute values read per element. The
 * window's scroll position is restored afterwards.
 */
export function anchorVisibility(elements: readonly Element[], attributes: readonly string[]): {
  attributes: (string | null)[];
  width: number;
  height: number;
  insideScrollArea: boolean;
  hidden: boolean;
  transparent: boolean;
  coveredAtCentre: boolean;
}[] {
  const measured = [];
  const first = elements[0];
  const startView = first === undefined ? null : first.ownerDocument.defaultView;
  const start = startView === null ? null : { x: startView.scrollX, y: startView.scrollY };
  for (const element of elements) {
    const owner = element.ownerDocument;
    const view = owner.defaultView;
    if (view === null) throw new TypeError("storefront_page_detached: the anchor's document has no window.");
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = element.getBoundingClientRect();
    let hidden = view.getComputedStyle(element).visibility !== "visible";
    let opacity = 1;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if (style.display === "none" || node.hasAttribute("hidden")) hidden = true;
      opacity *= Number(style.opacity);
    }
    // One pixel of tolerance for sub-pixel layout against the integer scroll size.
    const left = box.left + view.scrollX;
    const top = box.top + view.scrollY;
    const root = owner.documentElement;
    const insideScrollArea = left > -1 && top > -1 && left + box.width < root.scrollWidth + 1 && top + box.height < root.scrollHeight + 1;
    const hit = box.width > 0 && box.height > 0 ? owner.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
    const coveredAtCentre = hit === null || !(hit === element || element.contains(hit) || hit.contains(element));
    measured.push({
      attributes: attributes.map((name) => element.getAttribute(name)),
      width: box.width, height: box.height, insideScrollArea, hidden, transparent: opacity === 0, coveredAtCentre,
    });
  }
  if (startView !== null && start !== null) startView.scrollTo(start.x, start.y);
  return measured;
}
