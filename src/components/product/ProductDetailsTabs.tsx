import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import type { StorefrontSsgLocale, StorefrontSsgSummaryItem } from "@/domains/catalog/storefrontSsgCatalog";
import { detailsFromStorefrontSsgCatalog } from "@/domains/catalog/storefrontSsgCatalog";
import { storefrontSsgDetails } from "#storefront-ssg-details";
import { useTranslation } from "react-i18next";
import IngredientsTab from "./tabs/IngredientsTab";
import NutritionalTab from "./tabs/NutritionalTab";
import TransitionTab from "./tabs/TransitionTab";
import { useRenderRuntime } from "@/app/renderMode";

interface Props {
  product: StorefrontSsgSummaryItem;
  locale: StorefrontSsgLocale;
}

type ProductTabId = "ingredients" | "nutrition" | "transition";

const useBrowserLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

const ProductDetailsTabs = ({ product: summary, locale }: Props) => {
  const detail = detailsFromStorefrontSsgCatalog(storefrontSsgDetails, summary.slug, locale);
  if (!detail) throw new Error(`storefront SSG detail missing: ${locale}:${summary.slug}`);
  const product: StorefrontItem = { ...summary, ...detail.item };
  const [activeTab, setActiveTab] = useState<ProductTabId>("ingredients");
  const { t } = useTranslation("catalog");
  const { mode } = useRenderRuntime();
  // The server and the first hydration render expose every panel. Enhancement is
  // local so a lazy boundary that resolves after the root provider effect still
  // gets a matching first render; the layout effect upgrades it before paint.
  const [enhanced, setEnhanced] = useState(mode === "csr");
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  useBrowserLayoutEffect(() => setEnhanced(true), []);

  const tabs = [
    { id: "ingredients", label: t("catalog:product.tabIngredients"), content: <IngredientsTab product={product} /> },
    { id: "nutrition", label: t("catalog:product.tabNutrition"), content: <NutritionalTab product={product} /> },
    { id: "transition", label: t("catalog:product.tabTransition"), content: <TransitionTab product={product} /> },
  ];

  const selectTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    setActiveTab(tab.id as ProductTabId);
    tabRefs.current[index]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (!enhanced) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(nextIndex);
  };

  return (
    <section className="bg-offwhite py-[60px] lg:py-[80px] px-6 lg:px-[72px]">
      <div className="max-w-[1080px] mx-auto">
        {/* Tab bar */}
        <div
          role={enhanced ? "tablist" : undefined}
          aria-label={enhanced ? t("catalog:product.detailsTabsLabel", { defaultValue: "Product details" }) : undefined}
          className="flex border-b border-border-light mb-8 overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {tabs.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
            <a
              key={tab.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              id={`product-tab-${tab.id}`}
              href={`#product-panel-${tab.id}`}
              role={enhanced ? "tab" : undefined}
              aria-controls={`product-panel-${tab.id}`}
              aria-selected={enhanced ? isActive : undefined}
              tabIndex={enhanced ? (isActive ? 0 : -1) : undefined}
              onClick={(event) => {
                if (!enhanced) return;
                event.preventDefault();
                setActiveTab(tab.id as ProductTabId);
              }}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={`relative font-body font-semibold text-sm lg:text-sm-plus px-5 lg:px-8 py-3 whitespace-nowrap transition-colors duration-200 ${
                isActive
                  ? "text-primary"
                  : "text-text-on-light/50 hover:text-text-on-light/80"
              }`}
            >
              {tab.label}
              {isActive && (
                <motion.div
                  layoutId="tab-underline"
                  className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary"
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
            </a>
            );
          })}
        </div>

        {/* Every panel is real HTML. Without JS the links above jump to these
            labelled sections; after hydration they become a conventional tabset. */}
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <div
              key={tab.id}
              id={`product-panel-${tab.id}`}
              data-product-tab-panel={tab.id}
              role={enhanced ? "tabpanel" : undefined}
              aria-labelledby={`product-tab-${tab.id}`}
              tabIndex={enhanced && isActive ? 0 : undefined}
              hidden={enhanced && !isActive}
              className={enhanced ? undefined : "mb-12 last:mb-0"}
            >
              <h3 className={enhanced ? "sr-only" : "font-display text-2xl font-semibold text-text-on-light mb-5"}>
                {tab.label}
              </h3>
              {tab.content}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default ProductDetailsTabs;
