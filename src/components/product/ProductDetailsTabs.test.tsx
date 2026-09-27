import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RenderRuntimeProvider } from "@/app/renderMode";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";

import ProductDetailsTabs from "./ProductDetailsTabs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./tabs/IngredientsTab", () => ({
  default: () => <p>Ingredients content</p>,
}));

vi.mock("./tabs/NutritionalTab", () => ({
  default: () => <p>Nutrition content</p>,
}));

vi.mock("./tabs/TransitionTab", () => ({
  default: () => <p>Transition content</p>,
}));

const product = { slug: "lamb" } as StorefrontItem;

function DelayedSsgTabs() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready ? <ProductDetailsTabs product={product} locale="pl" /> : null;
}

describe("ProductDetailsTabs selective hydration", () => {
  it("renders every labelled panel as visible link targets without JavaScript", () => {
    const html = renderToStaticMarkup(
      <RenderRuntimeProvider mode="ssg">
        <ProductDetailsTabs product={product} locale="pl" />
      </RenderRuntimeProvider>,
    );

    expect(html).toContain("Ingredients content");
    expect(html).toContain("Nutrition content");
    expect(html).toContain("Transition content");
    expect(html).toContain('href="#product-panel-nutrition"');
    expect(html).not.toContain(" hidden=");
    expect(html).not.toContain("opacity:0");
    expect(html).not.toContain("translateY(8px)");
  });

  it("upgrades a delayed SSG boundary to keyboard-operable tabs", async () => {
    render(
      <RenderRuntimeProvider mode="ssg">
        {/* Models a lazy boundary resolving after RenderRuntimeProvider's effect. */}
        <DelayedSsgTabs />
      </RenderRuntimeProvider>,
    );

    const ingredientsTab = await screen.findByRole("tab", { name: "catalog:product.tabIngredients" });
    const nutritionTab = screen.getByRole("tab", { name: "catalog:product.tabNutrition" });
    const ingredientsPanel = screen.getByRole("tabpanel", { name: "catalog:product.tabIngredients" });

    expect(ingredientsTab).toHaveAttribute("aria-selected", "true");
    expect(within(ingredientsPanel).getByText("Ingredients content")).toBeVisible();

    fireEvent.keyDown(ingredientsTab, { key: "ArrowRight" });

    expect(nutritionTab).toHaveFocus();
    expect(nutritionTab).toHaveAttribute("aria-selected", "true");
    expect(ingredientsPanel).not.toBeVisible();
    expect(screen.getByRole("tabpanel", { name: "catalog:product.tabNutrition" })).toBeVisible();
  });
});
