/**
 * Measures anchors in the browser. The page handle passes this function to the
 * page by its source text, so it reads only its arguments and each element's
 * `ownerDocument` and `defaultView`, and calls nothing outside itself (its
 * helpers are declared inside it).
 *
 * Each element is scrolled into view, then measured:
 *
 * - its box;
 * - `insideScrollArea`: the box lies inside the page's scrollable area, and
 *   bringing it into view did not need a container the buyer cannot scroll
 *   (`overflow: hidden` or `clip`) to move;
 * - `hidden`: `display: none` or a `hidden` attribute up the tree, or an
 *   inherited `visibility` other than `visible`;
 * - `transparent`: the product of its and its ancestors' opacity is 0;
 * - `coveredAtCentre`: the part of the box left after clipping by its
 *   ancestors' overflow boxes and by its own and its ancestors' `clip` and
 *   `clip-path` is empty, or the element hit at that part's centre is neither
 *   the anchor, a descendant nor an ancestor. An ancestor hit is accepted only
 *   when no `clip-path` other than `inset()` lies on the way, because other
 *   shapes are not measured.
 *
 * `attributes` lists the attribute values read per element. The scroll
 * position of the window and of every ancestor is restored after each element.
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
  type Rect = { left: number; top: number; right: number; bottom: number };
  const intersect = (a: Rect, b: Rect): Rect => ({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  });
  // A computed length list: `auto` stays null, `%` resolves against the basis for its position.
  const lengths = (text: string, bases: readonly number[]): (number | null)[] =>
    text.split(/[\s,]+/).filter((part) => part !== "").map((part, index) => {
      if (part === "auto") return null;
      const value = Number.parseFloat(part);
      return part.endsWith("%") ? value / 100 * (bases[index % bases.length] ?? 0) : value;
    });
  // The rect a `clip` or `clip-path` leaves of a border box, or null when it cannot be measured.
  const clipRect = (box: DOMRect, clip: string, clipPath: string, positioned: boolean): Rect | null | "unmeasured" => {
    let rect: Rect | null = null;
    const clipMatch = /^rect\((.*)\)$/.exec(clip);
    if (positioned && clipMatch !== null) {
      const [top, right, bottom, left] = lengths(clipMatch[1] ?? "", [box.height, box.width]);
      rect = {
        left: box.left + (left ?? 0), top: box.top + (top ?? 0),
        right: box.left + (right ?? box.width), bottom: box.top + (bottom ?? box.height),
      };
    }
    if (clipPath === "none") return rect;
    const insetMatch = /^inset\(([^)]*?)(?:\s+round\s.*)?\)$/.exec(clipPath);
    if (insetMatch === null) return "unmeasured";
    const values = lengths(insetMatch[1] ?? "", [box.height, box.width]).map((value) => value ?? 0);
    const [top = 0, right = top, bottom = top, left = right] = values;
    const inset = { left: box.left + left, top: box.top + top, right: box.left + box.width - right, bottom: box.top + box.height - bottom };
    return rect === null ? inset : intersect(rect, inset);
  };

  const measured = [];
  for (const element of elements) {
    const owner = element.ownerDocument;
    const view = owner.defaultView;
    if (view === null) throw new TypeError("storefront_page_detached: the anchor's document has no window.");
    const chain: Element[] = [];
    for (let node = element.parentElement; node !== null; node = node.parentElement) chain.push(node);
    const windowScroll = { x: view.scrollX, y: view.scrollY };
    const saved = chain.map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    // A container the buyer cannot scroll moved to reveal the anchor: the buyer could not do that.
    const unreachable = saved.some(({ node, left, top }) => {
      const style = view.getComputedStyle(node);
      const locked = (overflow: string) => overflow === "hidden" || overflow === "clip";
      return (node.scrollTop !== top && locked(style.overflowY)) || (node.scrollLeft !== left && locked(style.overflowX));
    });

    const box = element.getBoundingClientRect();
    const own = view.getComputedStyle(element);
    let hidden = own.visibility !== "visible";
    let opacity = 1;
    let visibleRect: Rect = { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height };
    let unmeasuredClip = false;
    for (const node of [element, ...chain]) {
      const style = node === element ? own : view.getComputedStyle(node);
      if (style.display === "none" || node.hasAttribute("hidden")) hidden = true;
      opacity *= Number(style.opacity);
      const nodeBox = node === element ? box : node.getBoundingClientRect();
      if (node !== element && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const left = nodeBox.left + node.clientLeft;
        const top = nodeBox.top + node.clientTop;
        visibleRect = intersect(visibleRect, {
          left: style.overflowX === "visible" ? -Infinity : left, right: style.overflowX === "visible" ? Infinity : left + node.clientWidth,
          top: style.overflowY === "visible" ? -Infinity : top, bottom: style.overflowY === "visible" ? Infinity : top + node.clientHeight,
        });
      }
      const clipped = clipRect(nodeBox, style.clip, style.clipPath, style.position === "absolute" || style.position === "fixed");
      if (clipped === "unmeasured") unmeasuredClip = true;
      else if (clipped !== null) visibleRect = intersect(visibleRect, clipped);
    }

    const left = box.left + view.scrollX;
    const top = box.top + view.scrollY;
    const root = owner.documentElement;
    // One pixel of tolerance for sub-pixel layout against the integer scroll size.
    const insideScrollArea = !unreachable && left > -1 && top > -1 && left + box.width < root.scrollWidth + 1 && top + box.height < root.scrollHeight + 1;
    const empty = !(visibleRect.right > visibleRect.left && visibleRect.bottom > visibleRect.top);
    const hit = empty ? null : owner.elementFromPoint((visibleRect.left + visibleRect.right) / 2, (visibleRect.top + visibleRect.bottom) / 2);
    const accepted = hit !== null && (hit === element || element.contains(hit) || (!unmeasuredClip && hit.contains(element)));
    measured.push({
      attributes: attributes.map((name) => element.getAttribute(name)),
      width: box.width, height: box.height, insideScrollArea, hidden, transparent: opacity === 0, coveredAtCentre: !accepted,
    });

    for (const { node, left: savedLeft, top: savedTop } of saved) {
      node.scrollLeft = savedLeft;
      node.scrollTop = savedTop;
    }
    view.scrollTo(windowScroll.x, windowScroll.y);
  }
  return measured;
}
