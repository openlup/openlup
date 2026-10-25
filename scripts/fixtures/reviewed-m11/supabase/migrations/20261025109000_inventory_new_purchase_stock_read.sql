-- One-time preview runs with the owner's privileges; only service_role may execute.
-- Bound work to 200 requested array items before deduplication.
CREATE FUNCTION public.inventory_new_purchase_stock_read(p_skus jsonb, p_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF jsonb_typeof(p_skus) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'inventory_stock_skus_invalid' USING ERRCODE = '22023';
 END IF;
 IF jsonb_array_length(p_skus)>200 THEN
  RAISE EXCEPTION 'inventory_stock_skus_limit_exceeded' USING ERRCODE = '22023';
 END IF;
 IF p_as_of IS NULL THEN
  RAISE EXCEPTION 'inventory_stock_as_of_invalid' USING ERRCODE = '22023';
 END IF;
 RETURN (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'sku',requested.sku,'catalogSkuId',sku.id,
   'source',CASE WHEN atp.available_quantity IS NULL THEN 'missing' ELSE 'provider' END,
   'providerForSale',atp.for_sale_quantity,'activeHolds',COALESCE(atp.hard_hold_quantity,0),
   'safetyStock',COALESCE(atp.safety_quantity,0),'available',COALESCE(atp.available_quantity,0),
   -- Conservative freshness: any stale row fails safe, exact for one provider kind.
   -- ATP quantities stay authoritative; allocation retains its own stale refusal.
   'stale',EXISTS(SELECT 1 FROM public.fulfillment_provider_stock_current stock
     WHERE stock.catalog_sku_id=sku.id AND stock.stale_after<=p_as_of),
   'renewalDemand',COALESCE(atp.soft_subscription_demand_quantity,0),
   'availableForNewPurchases',COALESCE(atp.available_quantity,0),'excludedOrderHolds',0,
   'channelExposure',COALESCE(atp.channel_exposure_quantity,0)) ORDER BY requested.sku),'[]'::jsonb)
  FROM (SELECT DISTINCT value sku FROM jsonb_array_elements_text(p_skus)) requested
  LEFT JOIN public.catalog_skus sku ON sku.sku=requested.sku
  LEFT JOIN LATERAL public.inventory_available_to_promise(sku.id,p_as_of,false) atp ON true
 );
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_new_purchase_stock_read(jsonb,timestamptz) FROM PUBLIC, anon, authenticated, openlup_mcp_reader;
GRANT EXECUTE ON FUNCTION public.inventory_new_purchase_stock_read(jsonb,timestamptz) TO service_role;
