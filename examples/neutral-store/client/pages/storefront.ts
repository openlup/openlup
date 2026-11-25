import { quantityChoices } from '../../shared/subscription-offer.ts';
import type { PageContext } from '../context.ts';
import type { Cart, OfferResult } from '../../shared/offer.ts';
import { emptyCart, validateCart } from '../../shared/offer.ts';
import { nativeUnitPrice, refreshLiveQuote, clearLiveQuote } from '../live-quote.ts';
import { productPath, routes } from '../../shared/routes.ts';
import { selectCatalogueProduct } from '../../shared/catalogue-products.ts';
import { append, button, el, link } from '../dom.ts';
import { field, refusal } from '../forms.ts';

export function homePage(context: PageContext): HTMLElement {
  const { config, locale } = context;
  return el('div', {},
    el('section', { class: 'hero' },
      el('div', {}, el('p', { class: 'eyebrow' }, config.brand.strapline[locale]),
        el('h1', {}, config.copy.heroTitle[locale]),
        el('p', {}, config.copy.heroBody[locale]),
        el('div', { class: 'actions' }, link(context.t('catalog'), routes.catalog[locale], 'button-link'),
          link(context.t('builder'), routes.builder[locale], 'button-link secondary'))),
      el('img', { src: config.media.hero, alt: config.media.heroAlt[locale], width: 320, height: 320 })),
    context.fragments.offerIntro(context),
    productGrid(context),
    el('section', { class: 'panel' }, el('h2', {}, context.t('preview')),
      el('p', {}, config.brand.description[locale]),
      el('p', {}, context.t('sandboxOnly')),
      link(context.t('limits'), routes.limits[locale])));
}

export function catalogPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('catalog')), productGrid(context),
    context.fragments.offerIntro(context));
}

function productGrid(context: PageContext): HTMLElement {
  return el('div', { class: `products ${context.config.offer.layout}` },
    context.catalogueError ? refusal(context, context.catalogueError, context.t('applicationUnavailable')) : null,
    ...context.catalogueProducts.map(product => {
      const card = context.fragments.productCard(context, product);
      if (product.variantTitle !== undefined) {
        if (!product.media) {
          for (const image of card.querySelectorAll('img[src=""]')) image.remove();
          if (context.config.offer.layout === 'list') card.style.gridTemplateColumns = 'minmax(0, 1fr)';
        }
        const path = productPath(product.slug, context.locale);
        for (const anchor of card.querySelectorAll('a')) if (anchor.getAttribute('href') === path) anchor.href = skuHref(path, product.sku);
        append(card, el('p', {}, product.variantTitle));
      }
      return card;
    }));
}

const skuHref = (path: string, sku: string) => `${path}?sku=${encodeURIComponent(sku)}`;

export function productPage(context: PageContext): HTMLElement {
  const selections = context.query.getAll('sku'), slug = context.route.slug ?? '';
  const product = selections.length <= 1 ? selectCatalogueProduct(context.catalogueProducts, slug, selections[0] ?? null) : undefined;
  if (!product) return el('section', {}, el('h1', {}, context.t('notFound')),
    context.catalogueError ? refusal(context, context.catalogueError, context.t('applicationUnavailable')) : null,
    link(context.t('catalog'), routes.catalog[context.locale]));
  const minimum = product.minQuantity ?? 1;
  const quantity = field(context, { name: 'quantity', label: 'quantity', type: 'number', value: String(minimum),
    min: minimum, max: context.config.offer.maxUnits });
  const output = el('div', { 'aria-live': 'polite' });
  const add = button(context.t('buy'), () => {
    const count = Number(quantity.control.value);
    if (!Number.isSafeInteger(count) || count < minimum || count > context.config.offer.maxUnits) {
      output.replaceChildren(refusal(context, 'quantity_invalid', context.t('quantity_invalid')));
      return;
    }
    const cart = context.getCart();
    if (product.minQuantity !== undefined && !cart.lines.length && !product.permittedPurchaseModes.includes(cart.mode)) {
      cart.mode = product.permittedPurchaseModes[0]!;
      cart.cadenceDays = cart.mode === 'subscription' ? context.config.offer.defaultCadenceDays : null;
    }
    const previous = cart.lines.find(line => line.sku === product.sku);
    if (previous) previous.quantity += count;
    else cart.lines.push({ sku: product.sku, quantity: count });
    // A partially composed cart may be below the minimum. It is revalidated before checkout.
    if (cart.lines.reduce((sum, line) => sum + line.quantity, 0) > context.config.offer.maxUnits) {
      output.replaceChildren(refusal(context, 'maximum_units', context.t('maximum_units')));
      return;
    }
    context.setCart(cart);
    output.replaceChildren(el('p', {}, context.t('cartSaved')),
      link(context.t('cart'), routes.cart[context.locale], 'button-link'));
  });
  return el('article', { class: 'product-detail' },
    product.media ? el('img', { src: product.media, alt: product.mediaAlt[context.locale], width: 440, height: 440 }) : null,
    el('div', {}, link(context.t('catalog'), routes.catalog[context.locale]),
      el('h1', {}, product.name[context.locale]),
      product.variantTitle !== undefined ? el('p', {}, product.variantTitle, ' · ', product.sku) : null,
      ...context.catalogueProducts.filter(item => item.slug === slug && item.sku !== product.sku).map(item =>
        link(item.variantTitle ?? item.sku, skuHref(productPath(slug, context.locale), item.sku))),
      product.description[context.locale] && el('p', {}, product.description[context.locale]),
      product.details[context.locale] && el('p', {}, product.details[context.locale]),
      product.contents && el('p', { class: 'muted' }, `${context.t('packContents')}: ${product.contents}`),
      nativeUnitPrice(context, product),
      quantity.wrapper, add, output));
}

export function builderPage(context: PageContext): HTMLElement {
  const config = context.config;
  const initial = context.getCart();
  const selected = new Map<string, HTMLInputElement>();
  const unitPrices = new Map<string, HTMLElement>();
  const mode = modeFields(context, initial);
  const result = el('div', { 'aria-live': 'polite' });
  const form = el('form', { class: 'builder' });
  append(form, el('h1', {}, config.copy.offerTitle[context.locale]),
    el('p', {}, context.t('chooseProducts')), rules(context));
  for (const product of config.offer.products) {
    const quantity = field(context, { name: product.sku, label: 'quantity', type: 'number',
      value: String(initial.lines.find(line => line.sku === product.sku)?.quantity ?? 0),
      min: 0, max: config.offer.maxUnits });
    selected.set(product.sku, quantity.control as HTMLInputElement);
    const unitPrice = el('p'); unitPrices.set(product.sku, unitPrice);
    append(form, el('section', { class: 'builder-row' },
      el('img', { src: product.media, alt: product.mediaAlt[context.locale], width: 96, height: 96 }),
      el('div', {}, el('h2', {}, product.name[context.locale]), unitPrice),
      quantity.wrapper));
  }
  append(form, mode.node);
  const submit = el('button', { type: 'submit' }, context.t('addBox'));
  append(form, submit, result);
  const input = (): Cart => ({ schemaVersion: 1, configuration: config.id,
    mode: mode.value(), cadenceDays: mode.cadence(),
    lines: [...selected.entries()].map(([sku, control]) => ({ sku, quantity: Number(control.value) }))
      .filter(line => line.quantity !== 0) });
  function preview(): void {
    for (const [sku,control] of selected) {
      const quantities = mode.value() === 'subscription' ? quantityChoices(config.subscriptionOffers.classic,sku,mode.cadence()!).filter(qty => qty <= config.offer.maxUnits) : [];
      control.disabled = mode.value() === 'subscription' && quantities.length === 0;
      control.setCustomValidity(mode.value() === 'subscription' && Number(control.value) !== 0 && !quantities.includes(Number(control.value)) ? context.t('quantity_invalid') : '');
      control.max = String(mode.value() === 'subscription' ? quantities.at(-1) ?? 0 : config.offer.maxUnits);
    }
    for (const element of unitPrices.values()) element.textContent = '';
    const value = validateCart(config, input());
    if (!value.ok) { clearLiveQuote(result); result.replaceChildren(offerIssues(context,value)); return; }
    void refreshLiveQuote(context,value.cart,result,quote => {
      for (const line of quote.lines) unitPrices.get(line.sku)!.textContent = context.money(line.unitMinor);
      result.replaceChildren(context.fragments.checkoutSummary(context,quote));
    });
  }
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const value = validateCart(config, input());
    if (!value.ok) { result.replaceChildren(offerIssues(context, value)); return; }
    context.setCart(value.cart);
    context.navigate(routes.cart[context.locale]);
  });
  preview();
  return form;
}

export function cartPage(context: PageContext): HTMLElement {
  const page = el('div', {}, el('h1', {}, context.t('cart')));
  const cart = context.getCart();
  if (cart.lines.length === 0) {
    append(page, el('p', {}, context.t('cartEmpty')), link(context.t('builder'), routes.builder[context.locale]));
    return page;
  }
  const mode = modeFields(context, cart);
  const result = el('div', { 'aria-live': 'polite' });
  const rows = el('div', { class: 'cart-lines' });
  const quantities = new Map<string, HTMLInputElement>();
  for (const line of cart.lines) {
    const product = context.catalogueProducts.find(item => item.sku === line.sku);
    const quantity = field(context, { name: line.sku, label: 'quantity', type: 'number',
      value: String(line.quantity), min: product?.minQuantity ?? 1, max: context.config.offer.maxUnits });
    quantities.set(line.sku, quantity.control as HTMLInputElement);
    append(rows, el('section', { class: 'cart-row' },
      el('h2', {}, product?.variantTitle ? `${product.variantTitle} · ${line.sku}` : product?.name[context.locale] ?? line.sku), quantity.wrapper,
      button(context.t('remove'), () => {
        cart.lines = cart.lines.filter(item => item.sku !== line.sku);
        context.setCart(cart);
        context.navigate(routes.cart[context.locale]);
      }, 'secondary')));
  }
  function save(): boolean {
    const next: Cart = { ...cart, mode: mode.value(), cadenceDays: mode.cadence(),
      lines: cart.lines.map(line => ({ sku: line.sku, quantity: Number(quantities.get(line.sku)?.value) })) };
    const value = validateCart(context.config, next, 'checkout', context.catalogueProducts);
    if (!value.ok) { clearLiveQuote(result); result.replaceChildren(offerIssues(context,value)); return false; }
    void refreshLiveQuote(context,value.cart,result,quote => result.replaceChildren(context.fragments.checkoutSummary(context,quote)));
    context.setCart(value.cart);
    return true;
  }
  append(page, rows, mode.node, el('div', { class: 'actions' },
    button(context.t('update'), () => { save(); }),
    button(context.t('checkout'), () => { if (save()) context.navigate(routes.checkout[context.locale]); }),
    button(context.t('demoReset'), () => { context.setCart(emptyCart(context.config)); context.navigate(routes.cart[context.locale]); }, 'secondary')),
    result, context.catalogueError ? refusal(context, context.catalogueError, context.t('applicationUnavailable')) : null,
    link(context.t('builder'), routes.builder[context.locale]));
  save();
  return page;
}

function modeFields(context: PageContext, cart: Cart) {
  const mode = field(context, { name: 'mode', label: 'purchaseMode', type: 'select', value: cart.mode,
    options: [{ value: 'one_time', text: context.t('oneTime') }, { value: 'subscription', text: context.t('subscription') }] });
  const cadence = field(context, { name: 'cadenceDays', label: 'cadence', type: 'select',
    value: String(cart.cadenceDays ?? context.config.offer.defaultCadenceDays),
    options: context.config.offer.cadenceDays.map(days => ({ value: String(days), text: `${days} ${context.t('days')}` })) });
  function changed(): void {
    cadence.wrapper.hidden = mode.control.value !== 'subscription';
    cadence.control.disabled = mode.control.value !== 'subscription';
  }
  mode.control.addEventListener('change', changed);
  changed();
  return { node: el('fieldset', {}, el('legend', {}, context.t('purchaseMode')), mode.wrapper, cadence.wrapper),
    value: () => mode.control.value === 'subscription' ? 'subscription' as const : 'one_time' as const,
    cadence: () => mode.control.value === 'subscription' ? Number(cadence.control.value) : null };
}

export function offerIssues(context: PageContext, result: Extract<OfferResult, { ok: false }>): HTMLElement {
  return el('div', { class: 'validation', role: 'status' }, el('p', {}, context.t('invalidOffer')),
    el('ul', {}, ...result.issues.map(issue => el('li', {}, context.t(issue.code),
      issue.limit === undefined ? null : ` (${issue.limit})`, issue.sku ? ` · ${issue.sku}` : null))));
}

function rules(context: PageContext): HTMLElement {
  const offer = context.config.offer;
  return el('aside', { class: 'panel small' }, el('h2', {}, context.t('offerRules')),
    el('p', {}, `${context.t('minUnits')}: ${offer.minUnits} · ${context.t('maxUnits')}: ${offer.maxUnits}`),
    el('p', {}, context.t('acquisitionInterim')));
}
