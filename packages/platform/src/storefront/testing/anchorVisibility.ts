/**
 * Measures anchors in the browser. The page handle passes this function to the
 * page by its source text, so it reads only its arguments and each element's
 * `ownerDocument` and `defaultView`, and calls nothing outside itself (its
 * helpers are declared inside it).
 *
 * Each element is scrolled into view when the viewport or an overflow
 * ancestor in its containing-block chain does not already show all of it, then
 * measured:
 *
 * - its box;
 * - `insideScrollArea`: the box lies inside the page's scrollable area, and,
 *   judged before anything moves, no scroller the buyer cannot scroll
 *   (`overflow: hidden` or `clip`; the viewport's overflow is the root
 *   element's, or body's while the root's is visible; a container only on an
 *   axis it can scroll) leaves part of the box outside the range it shows;
 * - `hidden`: `display: none` or a `hidden` attribute up the tree, or an
 *   inherited `visibility` other than `visible`;
 * - `transparent`: the product of its and its ancestors' opacity is 0;
 * - `coveredAtCentre`: the part of the box left after clipping by the overflow
 *   boxes of the ancestors in its containing-block chain (never the root
 *   scroller, which is the viewport) and by its own and its ancestors' `clip`
 *   and `clip-path` is empty, or the element hit at that part's centre is neither
 *   the anchor, a descendant nor an ancestor. An ancestor hit is accepted only
 *   when no `clip-path` other than `inset()` lies on the way, because other
 *   shapes are not measured.
 *
 * `attributes` lists the attribute values read per element. The scroll
 * position of the window and of every ancestor is restored after each element,
 * instantly whatever the page's `scroll-behavior`.
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
    // The root scroller is the viewport, which scrolling into view and the scroll area already measure: it never
    // clips like a container. `body` is one too while the root element's overflow is visible (it then propagates).
    const rootStyle = view.getComputedStyle(owner.documentElement);
    const isRootScroller = (node: Element) => node === owner.documentElement || node === owner.scrollingElement
      || (node === owner.body && rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible");
    const own = view.getComputedStyle(element);
    // An overflow box clips only the boxes in its containing-block chain: a fixed box escapes every ancestor but one
    // that contains fixed boxes (transform, filter, perspective, paint or layout containment), an absolute box every
    // ancestor below its positioned (or so containing) ancestor.
    const inChain = new Set<Element>();
    let awaiting = own.position;
    for (const node of chain) {
      const style = view.getComputedStyle(node);
      const containsFixed = style.transform !== "none" || style.filter !== "none" || style.perspective !== "none"
        || /\b(?:paint|layout|strict|content)\b/.test(style.contain) || /\b(?:transform|perspective|filter)\b/.test(style.willChange)
        || (style.backdropFilter !== undefined && style.backdropFilter !== "none" && style.backdropFilter !== "");
      if (awaiting === "fixed" ? containsFixed : awaiting === "absolute" ? style.position !== "static" || containsFixed : true) {
        inChain.add(node);
        awaiting = style.position;
      }
    }
    // The scrollers that show the anchor: the viewport, and every overflow ancestor in its chain but the root scroller.
    const locked = (overflow: string) => overflow === "hidden" || overflow === "clip";
    // The viewport's overflow is the root element's, or body's while the root's is visible.
    const viewportStyle = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible" && owner.body !== null
      ? view.getComputedStyle(owner.body) : rootStyle;
    const scrollers: { x: [number, number]; y: [number, number]; lockedX: boolean; lockedY: boolean }[] = [
      { x: [0, view.innerWidth], y: [0, view.innerHeight], lockedX: locked(viewportStyle.overflowX), lockedY: locked(viewportStyle.overflowY) },
    ];
    for (const node of chain) {
      if (!inChain.has(node) || isRootScroller(node)) continue;
      const style = view.getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const nodeBox = node.getBoundingClientRect();
      const left = nodeBox.left + node.clientLeft;
      const top = nodeBox.top + node.clientTop;
      // A locked container counts only on an axis it could scroll; one with nothing to scroll merely clips (below).
      scrollers.push({
        x: [left, left + node.clientWidth], y: [top, top + node.clientHeight],
        lockedX: locked(style.overflowX) && node.scrollWidth > node.clientWidth, lockedY: locked(style.overflowY) && node.scrollHeight > node.clientHeight,
      });
    }
    // Decided before anything moves: an axis needs a scroller to move only when the box is not already within the
    // range it shows (one pixel of tolerance), and the buyer cannot move a locked one. Centring an anchor that is
    // already in view would move a locked viewport or container without the buyer needing it to.
    const before = element.getBoundingClientRect();
    const within = (start: number, size: number, [from, to]: [number, number]) => start > from - 1 && start + size < to + 1;
    const needs = scrollers.map((scroller) => ({
      x: !within(before.left, before.width, scroller.x), y: !within(before.top, before.height, scroller.y), scroller,
    }));
    const unreachable = needs.some(({ x, y, scroller }) => (x && scroller.lockedX) || (y && scroller.lockedY));
    const windowScroll = { x: view.scrollX, y: view.scrollY };
    const saved = chain.map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));
    // Scroll only to measure an anchor some scroller does not fully show.
    if (needs.some(({ x, y }) => x || y)) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

    const box = element.getBoundingClientRect();
    let hidden = own.visibility !== "visible";
    let opacity = 1;
    let visibleRect: Rect = { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height };
    let unmeasuredClip = false;
    for (const node of [element, ...chain]) {
      const style = node === element ? own : view.getComputedStyle(node);
      if (style.display === "none" || node.hasAttribute("hidden")) hidden = true;
      opacity *= Number(style.opacity);
      const nodeBox = node === element ? box : node.getBoundingClientRect();
      if (node !== element && inChain.has(node) && !isRootScroller(node) && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
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

    // Instant, so `scroll-behavior: smooth` cannot leave the next anchor reading a moving page.
    for (const { node, left: savedLeft, top: savedTop } of saved) node.scrollTo({ left: savedLeft, top: savedTop, behavior: "instant" });
    view.scrollTo({ left: windowScroll.x, top: windowScroll.y, behavior: "instant" });
  }
  return measured;
}
