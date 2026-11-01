import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PgGatewayClient } from "@openlup/platform/data";
import { createManagedChannelPurchasedContextRead, type PurchasedReadClient, createManagedChannelIngestStore, createManagedChannelIngestPayments, createChannelExposureReservationRail, runChannelOrderIngest, type ChannelIngestPortOptions } from "@openlup/platform/channels/server";
import { createManagedPaymentControlRuntimePort } from "../../server/adapters/managed/commerce/paymentControlRuntimePort.js";
import type { channelPurchaseFixture } from "./channelPurchaseFixture.js";

export async function channelManagedIngestFixture(db: PoolClient, f: Awaited<ReturnType<typeof channelPurchaseFixture>>) {
  const { providerKind } = f;
  const definition = (await db.query("SELECT pg_get_functiondef('public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)'::regprocedure) body")).rows[0].body;
  const location = /WHERE code = '([^']+)'/u.exec(definition)![1];
  await db.query(`INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
    VALUES($1,'fulfillment','Synthetic stock','active',ARRAY['DE']) ON CONFLICT(kind) DO UPDATE SET enabled_for_region=EXCLUDED.enabled_for_region`, [providerKind]);
  await db.query(`INSERT INTO public.inventory_locations(code,display_name,kind,status,region,fulfillable,provider_kind)
    VALUES($1,'Synthetic stock','third_party_logistics','active','DE',true,$2) ON CONFLICT(code) DO NOTHING`, [location,providerKind]);
  async function stock(quantity: number) {
    await db.query("SELECT public.fulfillment_provider_upsert_stock_current($1,$2,'PART-A',$3,$3,0,now(),now()+interval '1 hour','channel-proof','{}')", [randomUUID(),providerKind,quantity]);
  }
  const store = createManagedChannelIngestStore({ rpc:f.rpc, from(){ throw new Error("unused_channel_fixture_read"); } });
  const channels = { async readChannelBySlug(slug: string) {
    const row = (await db.query(`SELECT s.*,c.connector_provider_kind FROM public.sales_channels s JOIN public.sales_channel_connections c ON c.id=s.connection_id WHERE s.slug=$1`,[slug])).rows[0];
    return row ? { id:row.id, connectionId:row.connection_id, slug:row.slug, status:row.status, currency:row.currency,
      connectorProviderKind:row.connector_provider_kind, settlementProviderKind:row.settlement_provider_kind,
      buyerCommsOwner:row.buyer_comms_owner, deliverySelection:row.delivery_selection } : null;
  } };
  const query=new PgGatewayClient({async query(sql,args) {
    const result=await f.asRole("service_role",()=>db.query(sql,[...(args??[])])).catch(error=>{
      const detail=error as {code?:string;message?:string;where?:string};f.failures.push({name:"managed_reader",code:detail.code,message:detail.message,where:detail.where});throw error;
    });
    // PostgREST emits bounded int8 values as JSON numbers; pg's raw int8 parser emits strings.
    return {rows:result.rows.map(row=>"exposure_generation" in row?{...row,exposure_generation:Number(row.exposure_generation)}:row)};
  }});
  const read=createManagedChannelPurchasedContextRead({actorId:f.actor,bundles:{async read(id){return id===f.context.bundle.bundleId?f.context.bundle:null;}},
    client:{from(table:string){
      const builder=query.from(table);
      return Object.assign(builder,{not(column:string,operator:string,value:unknown){
        if(table!=="channel_order_ingests"||column!=="purchase_capture_text"||operator!=="is"||value!==null)throw new Error("unsupported_channel_fixture_filter");
        // Captures are either null or nonempty canonical JSON; the existing pg shim has no .not().
        return builder.gt(column,"");
      }});
    },rpc:f.rpc} as unknown as PurchasedReadClient});
  const options: ChannelIngestPortOptions = { store,channels,acceptedCurrencies:["EUR"],noopSettlementForbidden:true,
    rails:{ reservations:{ async reserveChannelOrderItems(){throw new Error("retained_rail_required");} },
      orderItems:{async readOrderItems(orderId){return (await db.query("SELECT id,sku_id,quantity FROM public.commerce_order_items WHERE order_id=$1 ORDER BY allocation_ordinal",[orderId])).rows.map(row=>({orderItemId:row.id,skuId:row.sku_id,quantity:row.quantity}));}},
      payments:createManagedChannelIngestPayments({rpc:f.rpc},createManagedPaymentControlRuntimePort({rpc:f.rpc})) } };
  async function run(ledgerId:string) {
    const reservations=createChannelExposureReservationRail({jobRunId:f.job,ledgerId,capture:f.capture,source:f.source,read,newId:randomUUID});
    return runChannelOrderIngest({ ...options.rails!,store,channels,reservations,purchasedRows:f.capture.retainedRows,
      acceptedCurrencies:["EUR"],noopSettlementForbidden:true },f.capture.normalized).catch(error=>{throw new Error(JSON.stringify(f.failures),{cause:error});});
  }
  return { stock,store,options,read,run };
}
