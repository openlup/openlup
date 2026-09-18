import { useState, useEffect, useCallback, useRef } from "react";

const anchors = [
  { id: "ingredients", label: "Ingredients" },
  { id: "nutrition", label: "Nutritional Info" },
  { id: "feeding", label: "Feeding Guide" },
  { id: "transition", label: "How to Switch" },
];

const ProductAnchorNav = () => {
  const [activeId, setActiveId] = useState<string>("");
  const [isVisible, setIsVisible] = useState(true);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sectionEls = anchors
      .map((a) => document.getElementById(a.id))
      .filter(Boolean) as HTMLElement[];

    if (sectionEls.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
    );

    sectionEls.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // Hide anchor nav when past the transition section
  useEffect(() => {
    const lastSection = document.getElementById("transition");
    if (!lastSection) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // When transition section's bottom is above viewport, hide nav
        setIsVisible(entry.isIntersecting || entry.boundingClientRect.bottom > 0);
      },
      { rootMargin: "0px 0px -100% 0px", threshold: 0 }
    );

    observer.observe(lastSection);
    return () => observer.disconnect();
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;
    const offset = 120; // main nav 72px + anchor nav 48px
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: "smooth" });
  }, []);

  return (
    <div
      ref={navRef}
      className="sticky top-[72px] z-40 w-full bg-[rgba(13,13,13,0.92)] backdrop-blur-md border-b border-white/8"
      style={{ display: isVisible ? undefined : "none" }}
    >
      <div
        className="max-w-[960px] mx-auto px-5 lg:px-12 flex items-center h-[48px] overflow-x-auto"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        <style>{`.anchor-scroll::-webkit-scrollbar { display: none; }`}</style>
        {anchors.map((anchor, i) => (
          <div key={anchor.id} className="flex items-center shrink-0">
            {i > 0 && (
              <span className="text-white/15 text-sm pointer-events-none select-none mx-1">·</span>
            )}
            <a
              href={`#${anchor.id}`}
              onClick={(e) => handleClick(e, anchor.id)}
              className={`font-mono text-xs max-sm:text-xxs uppercase tracking-[0.06em] max-sm:tracking-[0.04em] px-5 max-sm:px-3 h-[48px] inline-flex items-center border-b-2 transition-colors duration-200 shrink-0 ${
                activeId === anchor.id
                  ? "text-teal border-teal"
                  : "text-white/45 border-transparent hover:text-white/85"
              }`}
            >
              {anchor.label}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProductAnchorNav;
