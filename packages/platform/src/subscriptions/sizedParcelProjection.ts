import { z } from "zod";

/** Host reads immutable order/cycle rows and localizes the returned facts through
 * the existing paid-email note hook. Quantity is never a physical packing promise. */
export interface SizedParcelProjectionPorts {
  read(orderId: string): Promise<{
    subscriptionId: string | null; cycleId: string | null; binding: string | null;
    cycle: { id: string; subscriptionId: string; number: number; cadenceDays: number } | null;
    lines: { sku: string; quantity: number; retainedId: string | null; capturedId?: string; physicalSize?: number }[];
  } | null>;
  readExactPhysicalSize(retainedId: string): Promise<{ id: string; sku: string; physicalSize: number } | null>;
  allowedCadences: readonly number[];
}
export function createSizedParcelProjection(ports: SizedParcelProjectionPorts) {
  return async (orderId: string, signal: AbortSignal): Promise<{ quantity: number; sizes: { physicalSize: number; quantity: number }[]; cadenceDays: number | null } | null> => {
    if (signal.aborted) return null;
    try {
      const order = await ports.read(orderId), cycle = order?.cycle;
      if (!order || order.binding !== "sized.v1" || !cycle || !Number.isSafeInteger(cycle.number) || cycle.number <= 1 ||
        cycle.id !== order.cycleId || cycle.subscriptionId !== order.subscriptionId || !order.lines.length) return null;
      const counts = new Map<number, number>(); let quantity = 0;
      for (const line of order.lines) {
        if (!line.sku || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 ||
          (line.retainedId !== null && !z.uuid().safeParse(line.retainedId).success) ||
          (line.capturedId !== undefined && !z.uuid().safeParse(line.capturedId).success) ||
          (line.capturedId !== undefined && line.retainedId !== null && line.capturedId !== line.retainedId)) return null;
        let physicalSize = line.physicalSize;
        if (physicalSize === undefined) {
          if (!line.retainedId) return null;
          const retained = await ports.readExactPhysicalSize(line.retainedId);
          if (!retained || retained.id !== line.retainedId || retained.sku !== line.sku) return null;
          physicalSize = retained.physicalSize;
        }
        if (!Number.isSafeInteger(physicalSize) || physicalSize! <= 0) return null;
        quantity += line.quantity; if (!Number.isSafeInteger(quantity)) return null;
        counts.set(physicalSize!, (counts.get(physicalSize!) ?? 0) + line.quantity);
      }
      return { quantity, sizes: [...counts].sort(([a], [b]) => a - b).map(([physicalSize, count]) => ({ physicalSize, quantity: count })),
        cadenceDays: ports.allowedCadences.includes(cycle.cadenceDays) ? cycle.cadenceDays : null };
    } catch { return null; }
  };
}
