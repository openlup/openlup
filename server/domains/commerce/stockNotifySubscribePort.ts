// Neutral port for the back-in-stock notify-me flow. Recording explicit
// marketing consent and linking the contact to the pending stock alert is a
// managed-persistence concern: the concrete implementation lives in
// `server/adapters/supabase/commerce/stockNotifySubscribe.ts`. The domain keeps
// only the shape, so a self-hosted composition can implement `subscribe`
// against its own store.

export interface StockNotifySubscribeInput {
  sku: string;
  email: string;
}

export interface StockNotifySubscribePort {
  subscribe(input: StockNotifySubscribeInput): Promise<void>;
}
