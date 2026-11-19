import type { StoreConfig, Locale } from '../shared/config.ts';
import type { Cart } from '../shared/offer.ts';
import type { CopyKey } from '../owned/copy.ts';
import type { ResolvedRoute } from '../shared/routes.ts';
import type { CustomizationFragments } from '../owned/fragments.ts';

export interface PageContext {
  config: StoreConfig;
  governedCatalogue?: boolean;
  catalogueDraftType: import('../shared/api.ts').AppConfigurationResponse['catalogueDraftType'];
  locale: Locale;
  route: ResolvedRoute;
  query: URLSearchParams;
  fragments: CustomizationFragments;
  t: (key: CopyKey) => string;
  money: (minor: number) => string;
  getCart: () => Cart;
  setCart: (cart: Cart) => void;
  navigate: (path: string) => void;
}
