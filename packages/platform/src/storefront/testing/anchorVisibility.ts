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
 * - `insideScrollArea`: the buyer can bring the box into view, judged per axis
 *   before anything moves, walking its scrollers from the anchor outward (the
 *   overflow ancestors in its containing-block chain, then the viewport, whose
 *   overflow is the root element's, or body's while the root's is visible). A
 *   scroller the buyer can scroll (not `hidden` or `clip`) brings anything in
 *   its scrollable content into its range, so from there outward what must be
 *   shown is that range; a locked one must already show the anchor, or an
 *   anchor-sized part of what an inner scrollable scroller shows. A container
 *   with nothing to scroll on an axis only clips there; the viewport always
 *   counts, and does not move a fixed box;
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
    // The scrollers that show the anchor, innermost first: every overflow ancestor in its chain but the root scroller,
    // then the viewport, whose overflow is the root element's, or body's while the root's is visible. Each has, per
    // axis, the range it shows now and the scroll extent its position can take; the buyer can move it only when its
    // overflow on that axis is not `hidden` or `clip`. A fixed anchor or ancestor is not moved by the viewport.
    const viewportStyle = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible" && owner.body !== null
      ? view.getComputedStyle(owner.body) : rootStyle;
    const locked = (overflow: string) => overflow === "hidden" || overflow === "clip";
    // A container scrolls for the buyer under `auto`, `scroll` or `overlay`; the viewport under anything but a lock.
    const userScrollable = (overflow: string) => overflow !== "visible" && !locked(overflow);
    const windowScroll = { x: view.scrollX, y: view.scrollY };
    const saved = chain.map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));
    // The extent of a scroll position, read by scrolling to both ends and back (instantly; everything is restored).
    const extent = (read: () => number, write: (value: number) => void) => {
      const current = read();
      write(-1e7);
      const min = read();
      write(1e7);
      const max = read();
      write(current);
      return { min, max, current };
    };
    type Axis = { range: [number, number]; min: number; max: number; current: number; user: boolean };
    const scrollers: { x: Axis; y: Axis; viewport: boolean }[] = [];
    for (const node of chain) {
      if (!inChain.has(node) || isRootScroller(node)) continue;
      const style = view.getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const nodeBox = node.getBoundingClientRect();
      const left = nodeBox.left + node.clientLeft;
      const top = nodeBox.top + node.clientTop;
      scrollers.push({
        viewport: false,
        x: { range: [left, left + node.clientWidth], user: userScrollable(style.overflowX),
          ...extent(() => node.scrollLeft, (value) => node.scrollTo({ left: value, behavior: "instant" })) },
        y: { range: [top, top + node.clientHeight], user: userScrollable(style.overflowY),
          ...extent(() => node.scrollTop, (value) => node.scrollTo({ top: value, behavior: "instant" })) },
      });
    }
    const moves = awaiting !== "fixed";
    const still = { min: 0, max: 0, current: 0 };
    scrollers.push({
      viewport: true,
      x: { range: [0, view.innerWidth], user: moves && !locked(viewportStyle.overflowX),
        ...(moves ? extent(() => view.scrollX, (value) => view.scrollTo({ left: value, behavior: "instant" })) : still) },
      y: { range: [0, view.innerHeight], user: moves && !locked(viewportStyle.overflowY),
        ...(moves ? extent(() => view.scrollY, (value) => view.scrollTo({ top: value, behavior: "instant" })) : still) },
    });
    // Reachability per axis, decided before anything moves, from the anchor outward (one pixel of tolerance). While
    // no scroller the buyer can move lies inside, the anchor stays where it is and must lie within every range that
    // shows it. A scroller the buyer can move brings anything in its scrollable content into its range, so from there
    // outward what must be shown is that range, of which an anchor-sized part must survive every locked scroller
    // outside. A container with nothing to scroll on an axis only clips there (measured below); the viewport always
    // counts, since nothing beyond it shows the anchor.
    const before = element.getBoundingClientRect();
    const reachable = (axis: "x" | "y") => {
      const size = axis === "x" ? before.width : before.height;
      let from = axis === "x" ? before.left : before.top;
      let to = from + size;
      let placeable = false;
      for (const scroller of scrollers) {
        const { range: [start, end], min, max, current, user } = scroller[axis];
        if (!scroller.viewport && max <= min) continue;
        if (user) {
          // Content the buyer can scroll into this range, in current coordinates.
          const [first, last] = [start + min - current, end + max - current];
          if (placeable ? Math.min(to, last) - Math.max(from, first) < size - 1 : from < first - 1 || to > last + 1) return false;
          [from, to, placeable] = [start, end, true];
        } else if (placeable) {
          [from, to] = [Math.max(from, start), Math.min(to, end)];
          if (to - from < size - 1) return false;
        } else if (from < start - 1 || to > end + 1) return false;
      }
      return true;
    };
    const unreachable = !reachable("x") || !reachable("y");
    // Scroll only to measure an anchor some scroller does not fully show.
    const within = (from: number, size: number, [start, end]: [number, number]) => from > start - 1 && from + size < end + 1;
    if (scrollers.some(({ x, y }) => !within(before.left, before.width, x.range) || !within(before.top, before.height, y.range))) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }

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

    const insideScrollArea = !unreachable;
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
