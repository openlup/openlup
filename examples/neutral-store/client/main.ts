import './style.css';
import { captureCompletionEntry } from './purchase.ts';
import { copy, type CopyKey } from '../owned/copy.ts';
import { fragments } from '../owned/fragments.ts';
import { assertConfig } from '../shared/config.ts';
import { productPath, resolveRoute, routes, type RouteKey } from '../shared/routes.ts';
import { configuration } from './api.ts';
import { createBrowserCart } from './cart.ts';
import { append, el, link } from './dom.ts';
import type { PageContext } from './context.ts';
import { homePage, catalogPage, productPage, builderPage, cartPage } from './pages/storefront.ts';
import { checkoutPage, completionPage, repairPage } from './pages/checkout.ts';
import { accountPage, invoicesPage, authPage, callbackPage } from './pages/account.ts';
import { operatorPage } from './pages/operator.ts';
import { acquisitionPage, partnersPage, researchPage } from './pages/participation.ts';
import { returnsPage, termsPage, reviewPage, unsubscribePage, supportPage,
  trackingPage, destinationsPage, limitsPage } from './pages/destinations.ts';

captureCompletionEntry();

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('starter_root_missing');

const pages: Record<RouteKey | 'product' | 'notFound', (context: PageContext) => HTMLElement> = {
  home: homePage,
  catalog: catalogPage,
  product: productPage,
  builder: builderPage,
  cart: cartPage,
  checkout: checkoutPage,
  account: accountPage,
  repair: repairPage,
  completion: completionPage,
  returns: returnsPage,
  terms: termsPage,
  invoices: invoicesPage,
  admin: operatorPage,
  unsubscribe: unsubscribePage,
  legacyUnsubscribe: unsubscribePage,
  auth: authPage,
  callback: callbackPage,
  support: supportPage,
  tracking: trackingPage,
  review: reviewPage,
  acquisition: acquisitionPage,
  research: researchPage,
  partners: partnersPage,
  limits: limitsPage,
  destinations: destinationsPage,
  notFound: context => el('section', {}, el('h1', {}, context.t('notFound')),
    el('p', {}, context.t('notFoundBody')), link(context.t('home'), routes.home[context.locale])),
};

async function start(): Promise<void> {
  const response = await configuration();
  const config = response.config;
  assertConfig(config);
  const notices = new Set<'storageUnavailable' | 'cartReset' | 'storageChanged'>();
  let renderReady = false;
  const cart = createBrowserCart(config, kind => {
    notices.add(kind);
    if (renderReady) render(false);
  });
  function navigate(path: string): void {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('starter_navigation_not_local');
    history.pushState(null, '', path);
    render(true);
  }
  function render(focus: boolean): void {
    const route = resolveRoute(location.pathname);
    const locale = route.locale;
    const context: PageContext = {
      config, locale, route, query: new URLSearchParams(location.search), fragments,
      t: key => copy[locale][key],
      money: amount => new Intl.NumberFormat(locale, {
        style: 'currency', currency: config.market.currency,
      }).format(amount / 100),
      getCart: cart.get,
      setCart: cart.set,
      navigate,
    };
    document.documentElement.lang = locale;
    const main = el('main', { id: 'content', tabindex: '-1' }, pages[route.key](context));
    root!.replaceChildren(link(context.t('skip'), location.pathname + location.search + '#content', 'skip-link'),
      el('div', { class: 'demo-banner' }, context.t('demo')),
      shellHeader(context),
      el('div', { class: 'notices', 'aria-live': 'polite' },
        ...[...notices].map(kind => el('p', { class: 'notice' }, context.t(kind)))),
      main, shellFooter(context));
    const title = main.querySelector('h1')?.textContent ?? config.brand.name;
    document.title = `${title} · ${config.brand.name}`;
    const tokens: Record<string, string> = {
      '--ink': config.theme.ink, '--paper': config.theme.paper, '--accent': config.theme.accent,
      '--accent-ink': config.theme.accentInk, '--border': config.theme.border,
    };
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    if (focus) { main.focus(); window.scrollTo(0, 0); }
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }
  window.addEventListener('popstate', () => render(true));
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target.closest('a') : null;
    if (!target || target.target || target.hasAttribute('download')) return;
    const url = new URL(target.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  window.addEventListener('beforeunload', () => cart.close());
  renderReady = true;
  render(false);
}

function shellHeader(context: PageContext): HTMLElement {
  const nav = el('nav', { 'aria-label': context.t('home') });
  const keys: Array<[RouteKey, CopyKey]> = [
    ['catalog', 'catalog'], ['builder', 'builder'], ['cart', 'cart'], ['account', 'account'],
  ];
  for (const [key, label] of keys) {
    const item = link(context.t(label), routes[key][context.locale]);
    if (context.route.key === key) item.setAttribute('aria-current', 'page');
    append(nav, item);
  }
  const alternate = context.locale === 'en' ? 'pl' : 'en';
  const alternatePath = context.route.key === 'product'
    ? productPath(context.route.slug ?? '', alternate)
    : context.route.key === 'notFound' ? routes.home[alternate] : routes[context.route.key][alternate];
  const language = link(copy[alternate][alternate === 'pl' ? 'languagePolish' : 'languageEnglish'], alternatePath + location.search);
  language.hreflang = alternate;
  language.lang = alternate;
  return el('header', { class: 'site-header' },
    link(context.config.brand.name, routes.home[context.locale], 'wordmark'), nav, language);
}

function shellFooter(context: PageContext): HTMLElement {
  const links: Array<[RouteKey, CopyKey]> = [
    ['returns', 'returns'], ['terms', 'terms'], ['support', 'support'], ['partners', 'partners'],
    ['acquisition', 'acquisition'], ['research', 'research'], ['review', 'review'],
    ['destinations', 'destinations'], ['limits', 'limits'], ['admin', 'admin'],
  ];
  return el('footer', {}, el('p', {}, context.config.brand.description[context.locale]),
    el('nav', { 'aria-label': context.t('support') },
      ...links.map(([key, label]) => link(context.t(label), routes[key][context.locale]))),
    el('p', { class: 'small muted' }, context.t('preview')));
}

void start().catch(() => {
  const locale = resolveRoute(location.pathname).locale;
  document.documentElement.lang = locale;
  document.title = copy[locale].applicationUnavailable;
  root.replaceChildren(el('main', {}, el('h1', {}, copy[locale].applicationUnavailable),
    el('code', {}, 'starter_configuration_unavailable')));
});
