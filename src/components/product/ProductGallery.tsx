import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StorefrontSsgSummaryItem } from "@/domains/catalog/storefrontSsgCatalog";

interface Props {
  product: StorefrontSsgSummaryItem;
  productName: string;
}

/* Render the images supplied by the product, using its optional hero image for
   the first slide. A fixed image height keeps the gallery steady while switching. */
const ProductGallery = ({ product, productName }: Props) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const { t } = useTranslation("catalog");

  const galleryImages = product.galleryImages;
  const primaryHeroImage = product.heroImageLcp ?? product.heroImage ?? galleryImages[0].src;

  const items = galleryImages.map((img, i) => ({
    src: i === 0 ? primaryHeroImage : img.src,
    label: img.label,
  }));
  const activeItem = items[activeIdx] ?? items[0];

  // Prefetch the remaining images while idle so thumbnail navigation can reuse them.
  useEffect(() => {
    const prefetch = () => {
      for (const { src } of galleryImages.slice(1)) {
        const img = new Image();
        img.src = src;
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(prefetch);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetch, 1200);
    return () => window.clearTimeout(id);
  }, [galleryImages]);

  return (
    <div>
      <div className="relative flex items-center justify-center p-4 lg:p-8 min-h-[380px] lg:min-h-[560px]">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at 50% 55%, ${product.color}20 0%, transparent 60%)`,
          }}
        />
        <img
          src={activeItem.src}
          alt={`${productName}: ${t(activeItem.label)}`}
          width={620}
          height={720}
          loading={activeIdx === 0 ? "eager" : "lazy"}
          decoding={activeIdx === 0 ? "sync" : "async"}
          {...{ fetchpriority: activeIdx === 0 ? "high" : "auto" }}
          className="relative z-10 h-[380px] lg:h-[580px] w-auto object-contain"
          style={{
            filter: `drop-shadow(0 20px 60px ${product.color}26)`,
          }}
        />
      </div>

      {/* Thumbnail controls for the supplied gallery images. */}
      <div className="flex gap-2.5 mt-4 justify-center flex-wrap">
        {items.map((item, i) => {
          const isActive = activeIdx === i;
          const label = `${productName}: ${t(item.label)}`;
          return (
            <button
              key={i}
              onClick={() => setActiveIdx(i)}
              aria-label={label}
              aria-pressed={isActive}
              title={label}
              className={`w-16 h-16 lg:w-[72px] lg:h-[72px] rounded-xl border-2 overflow-hidden flex items-center justify-center transition-all duration-200 ${
                isActive ? "bg-white shadow-sm scale-[1.04]" : "bg-white/55 hover:bg-white/80"
              }`}
              style={{ borderColor: isActive ? product.color : "rgba(0,0,0,0.08)" }}
            >
              <img
                src={item.src}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-[85%] w-auto object-contain"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ProductGallery;
