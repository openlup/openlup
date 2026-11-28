import type { StoreConfig, Locale } from '../shared/config.ts';
import type { Cart } from '../shared/offer.ts';
import type { CopyKey } from '../owned/copy.ts';
import type { ResolvedRoute } from '../shared/routes.ts';
import type { CustomizationFragments } from '../owned/fragments.ts';
import type { StarterCatalogueItem } from '../shared/catalogue-products.ts';

export interface PageContext {
  config: StoreConfig;
  locale: Locale;
  route: ResolvedRoute;
  query: URLSearchParams;
  catalogueProducts: readonly StarterCatalogueItem[];
  catalogueError?: string;
  /** False while the storefront catalogue request is open; absent means validate against the products at hand. */
  catalogueSettled?: boolean;
  fragments: CustomizationFragments;
  t: (key: CopyKey) => string;
  money: (minor: number) => string;
  getCart: () => Cart;
  setCart: (cart: Cart) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}
