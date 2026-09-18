import type { RouteKey } from "@/lib/i18nRoutes";

export interface NavChild {
  labelKey: string;
  routeKey: RouteKey;
  dotColor?: string;
}

export interface NavLink {
  labelKey: string;
  href?: string;
  routeKey?: RouteKey;
  children?: NavChild[];
}

export const navLinks: NavLink[] = [
  { labelKey: "common:nav.forDogs", href: "#products", children: [
    { labelKey: "common:nav.lambRecipe", routeKey: "productLamb", dotColor: "#00BFB3" },
    { labelKey: "common:nav.venisonRecipe", routeKey: "productVenison", dotColor: "#8B1A4A" },
    { labelKey: "common:nav.beefRecipe", routeKey: "productBeef", dotColor: "#e06040" },
    { labelKey: "common:nav.turkeyRecipe", routeKey: "productTurkey", dotColor: "#50b0dc" },
    { labelKey: "common:nav.salmonRecipe", routeKey: "productSalmon", dotColor: "#e6a050" },
    { labelKey: "common:nav.porkRecipe", routeKey: "productPork", dotColor: "#d88e9c" },
  ] },
  { labelKey: "common:nav.science", routeKey: "science" },
  { labelKey: "common:nav.ourStory", routeKey: "ourStory" },
];
