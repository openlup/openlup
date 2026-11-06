import { createSizedParcelProjection, type SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';
import type { OrderPaidParcelNoteReader } from '@openlup/platform/commerce/server';
import type { Locale, StoreConfig } from '../shared/config.ts';
import { editorText } from '../owned/editor-copy.ts';
import { isRecord } from '../shared/offer.ts';

/** Compatible with describeParcel; this starter does not mount a paid-email handler. */
export function composeSizedPaidEmailNote(db: SubscriptionQueryExecutor,config: StoreConfig): OrderPaidParcelNoteReader<Locale> {
  const project = createSizedParcelProjection({ allowedCadences: config.subscriptionEditing.sized.allowedCadences,
    async read(orderId) {
      const row = (await db.query(`SELECT o.subscription_cycle_id,c.subscription_id,c.id AS cycle_id,r.cycle_snapshot,s.configured_offer_version AS binding
        FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
        JOIN public.subscription_renewal_operations r ON r.id=c.renewal_operation_id AND r.id=o.renewal_operation_id AND r.subscription_id=c.subscription_id
        JOIN public.subscriptions s ON s.id=c.subscription_id WHERE o.id=$1::uuid`, [orderId])).rows[0];
      if (!row || !isRecord(row.cycle_snapshot)) return null;
      const snapshot = row.cycle_snapshot,template = isRecord(snapshot.templateSnapshot) ? snapshot.templateSnapshot : null;
      const cycle = isRecord(snapshot.cycle) ? snapshot.cycle : null,order = isRecord(snapshot.orderSnapshot) ? snapshot.orderSnapshot : null;
      if (!template || snapshot.subscriptionId !== row.subscription_id || cycle?.status !== 'correlated' || !Number.isSafeInteger(cycle.logicalCycleNumber)
        || !order || !Array.isArray(order.lines)) return null;
      const rows = (await db.query(`SELECT sku_id,quantity,line_ordinal FROM public.commerce_order_items WHERE order_id=$1::uuid ORDER BY line_ordinal`, [orderId])).rows;
      if (rows.length !== order.lines.length) return null;
      const lines = [];
      for (const item of rows) {
        const frozen = order.lines.filter(line => isRecord(line) && line.lineOrdinal === item.line_ordinal);
        if (frozen.length !== 1 || !isRecord(frozen[0]) || frozen[0].quantity !== item.quantity || typeof frozen[0].sku !== 'string') return null;
        lines.push({ sku: frozen[0].sku,quantity: Number(item.quantity),retainedId: typeof item.sku_id === 'string' ? item.sku_id : null });
      }
      return { subscriptionId: String(row.subscription_id),cycleId: String(row.cycle_id),binding: String(row.binding),
        cycle: { id: String(row.cycle_id),subscriptionId: String(row.subscription_id),number: Number(cycle.logicalCycleNumber),cadenceDays: Number(template.cadenceDays) },
        lines };
    },
    async readExactPhysicalSize(id) {
      const row = (await db.query('SELECT id,sku,net_weight_g FROM public.catalog_skus WHERE id=$1::uuid',[id])).rows[0];
      return row ? { id: String(row.id),sku: String(row.sku),physicalSize: Number(row.net_weight_g) } : null;
    } });
  return async (orderId,locale,signal) => {
    const facts = await project(orderId,signal);
    if (!facts) return null;
    const sizes = facts.sizes.map(size => `${size.quantity} × ${size.physicalSize} g`).join(', ');
    return `${editorText(locale,'parcelItems',{ count: facts.quantity,sizes })}${facts.cadenceDays === null ? '' : ` · ${editorText(locale,'everyDays',{ days: facts.cadenceDays })}`}`;
  };
}
