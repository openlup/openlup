import type { PageContext } from '../context.ts';
import { el, link } from '../dom.ts';
import { routes } from '../../shared/routes.ts';
import { editorAccount, text, notice, date } from './view.ts';

/** The account owns entry points; editor state lives on its separate pages. */
export function subscriptionEditorEntries(context: PageContext): HTMLElement {
  const root = el('section',{ 'data-testid': 'subscription-editor-entries' },el('p',{ role: 'status' },text(context,'loading')));
  void editorAccount().then(subscriptions => {
    root.replaceChildren();
    if (context.query.get('packageSaved') === '1') root.append(el('p',{ role: 'status' },text(context,'saved')));
    for (const subscription of subscriptions) {
      const card = el('section',{ class: 'panel','data-editor-subscription': subscription.subscriptionId },el('h3',{},text(context,'currentPackage')),
        el('ul',{},...subscription.lines.map(line => el('li',{},`${line.qty} × ${line.title ?? line.sku ?? line.variantId}`))),
        el('p',{},text(context,'nextCycle',{ date: date(context,subscription.nextCycleAt) })));
      if (subscription.recurringTotal) card.append(el('p',{},new Intl.NumberFormat(context.locale,{ style: 'currency',currency: subscription.recurringTotal.currency }).format(subscription.recurringTotal.amountMinor/100)));
      if (!subscription.canEditUpcomingPackage) card.append(el('p',{ role: 'alert' },notice(context,subscription.editBlockedReason ?? 'unavailable')));
      else {
        const query = `?subscription=${encodeURIComponent(subscription.subscriptionId)}`;
        card.append(link(text(context,subscription.offerVersion === 'classic' ? 'classic' : 'sized'),
          routes[subscription.offerVersion === 'classic' ? 'classicEdit' : 'sizedEdit'][context.locale]+query,'button-link'));
        if (subscription.offerVersion === 'classic') card.append(el('div',{ 'data-testid': 'sized-invitation' },el('p',{},text(context,'invitationBody')),
          link(text(context,'invitation'),routes.sizedEdit[context.locale]+query+'&optIn=1')));
      }
      root.append(card);
    }
  }).catch(error => root.replaceChildren(el('p',{ role: 'alert' },notice(context,error instanceof Error ? error.message : 'unavailable'))));
  return root;
}
