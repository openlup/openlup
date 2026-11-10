/** The neutral safety contract reads an actual durable provider object; local absence never proves safety. */
export interface ExpiredPaymentSafetyOrder { orderId:string;totalMinor:number;currency:string }
interface SafetyExecutor {query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>}
/** Selected simulator profile only. Real-provider channels retain the native named refusal. */
export function createPostgresSandboxExpiredCheckoutSafety(db:SafetyExecutor):{
 verifyPriorPayment(order:ExpiredPaymentSafetyOrder):Promise<'safe'|'paid'|'unavailable'>
}{return{async verifyPriorPayment(order){
 try{
  const i=(await db.query('SELECT id,channel_key,status,amount_minor,currency_code FROM public.commerce_settlement_intents WHERE order_id=$1::uuid',[order.orderId])).rows[0];
  if(!i)return'unavailable';
  if(i.channel_key!=='sandbox')throw new Error('native_prepared_attempt_store_unsupported');
  const a=(await db.query('SELECT public.payment_simulator_read_attempt($1::uuid,NULL::uuid) AS result',[i.id])).rows[0]?.result;
  if(!a||typeof a!=='object'||!('state'in a))return'unavailable';
  if(a.state==='captured'||i.status==='settled')return'paid';
  if(!['refused','expired'].includes(String(a.state))||!('latestObservation'in a)||!a.latestObservation||typeof a.latestObservation!=='object'
   ||!('outcome'in a.latestObservation)||a.latestObservation.outcome!==a.state)return'unavailable';
  if(Number(i.amount_minor)!==order.totalMinor||i.currency_code!==order.currency)return'unavailable';
  return'safe';
 }catch(error){if(error instanceof Error&&error.message==='native_prepared_attempt_store_unsupported')throw error;return'unavailable';}
}};}
