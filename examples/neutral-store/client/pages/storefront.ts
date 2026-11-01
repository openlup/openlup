import type { PageContext } from '../context.ts';
import type { Cart, OfferResult } from '../../shared/offer.ts';
import { emptyCart, evaluateOffer } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
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
    ...context.config.offer.products.map(product => context.fragments.productCard(context, product)));
}

export function productPage(context: PageContext): HTMLElement {
  const product = context.config.offer.products.find(item => item.slug === context.route.slug);
  if (!product) return el('section', {}, el('h1', {}, context.t('notFound')),
    link(context.t('catalog'), routes.catalog[context.locale]));
  const quantity = field(context, { name: 'quantity', label: 'quantity', type: 'number', value: '1',
    min: 1, max: context.config.offer.maxUnits });
  const output = el('div', { 'aria-live': 'polite' });
  const add = button(context.t('buy'), () => {
    const count = Number(quantity.control.value);
    if (!Number.isSafeInteger(count) || count < 1 || count > context.config.offer.maxUnits) {
      output.replaceChildren(refusal(context, 'quantity_invalid', context.t('quantity_invalid')));
      return;
    }
    const cart = context.getCart();
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
    el('img', { src: product.media, alt: product.mediaAlt[context.locale], width: 440, height: 440 }),
    el('div', {}, link(context.t('catalog'), routes.catalog[context.locale]),
      el('h1', {}, product.name[context.locale]),
      el('p', {}, product.description[context.locale]),
      el('p', {}, product.details[context.locale]),
      el('p', { class: 'muted' }, product.contents),
      el('p', { class: 'price' }, context.money(product.unitPrice.amountMinor)),
      quantity.wrapper, add, output,
      el('p', { class: 'muted' }, context.config.copy.shippingNote[context.locale])));
}

export function builderPage(context: PageContext): HTMLElement {
  const config = context.config;
  const initial = context.getCart();
  const selected = new Map<string, HTMLInputElement>();
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
    append(form, el('section', { class: 'builder-row' },
      el('img', { src: product.media, alt: product.mediaAlt[context.locale], width: 96, height: 96 }),
      el('div', {}, el('h2', {}, product.name[context.locale]), el('p', {}, context.money(product.unitPrice.amountMinor))),
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
    const value = evaluateOffer(config, input());
    result.replaceChildren(value.ok ? context.fragments.checkoutSummary(context, value.quote) : offerIssues(context, value));
  }
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const value = evaluateOffer(config, input());
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
    const product = context.config.offer.products.find(item => item.sku === line.sku);
    const quantity = field(context, { name: line.sku, label: 'quantity', type: 'number',
      value: String(line.quantity), min: 1, max: context.config.offer.maxUnits });
    quantities.set(line.sku, quantity.control as HTMLInputElement);
    append(rows, el('section', { class: 'cart-row' },
      el('h2', {}, product?.name[context.locale] ?? line.sku), quantity.wrapper,
      button(context.t('remove'), () => {
        cart.lines = cart.lines.filter(item => item.sku !== line.sku);
        context.setCart(cart);
        context.navigate(routes.cart[context.locale]);
      }, 'secondary')));
  }
  function save(): boolean {
    const next: Cart = { ...cart, mode: mode.value(), cadenceDays: mode.cadence(),
      lines: cart.lines.map(line => ({ sku: line.sku, quantity: Number(quantities.get(line.sku)?.value) })) };
    const value = evaluateOffer(context.config, next);
    result.replaceChildren(value.ok ? context.fragments.checkoutSummary(context, value.quote) : offerIssues(context, value));
    if (!value.ok) return false;
    context.setCart(value.cart);
    return true;
  }
  append(page, rows, mode.node, el('div', { class: 'actions' },
    button(context.t('update'), () => { save(); }),
    button(context.t('checkout'), () => { if (save()) context.navigate(routes.checkout[context.locale]); }),
    button(context.t('demoReset'), () => { context.setCart(emptyCart(context.config)); context.navigate(routes.cart[context.locale]); }, 'secondary')),
    result, link(context.t('builder'), routes.builder[context.locale]));
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
    el('p', {}, `${context.t('freeShipping')}: ${context.money(offer.freeShippingFromMinor)}`));
}
