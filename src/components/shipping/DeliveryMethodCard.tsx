import type { DeliveryKind, DeliveryOption, PickupPoint } from "@openlup/platform/shipping/contracts";
import { PickupPointPicker } from "./PickupPointPicker";

/** Dictionary selection with a manual method fallback when the dictionary is unavailable. */
export function DeliveryMethodCard({ options = [], selectedOption, selectedPickupPoint,
  addressPostalCode, addressCity, deliverySelectionEnabled = false, loadingOptions = false,
  error, pickupPointError, onSelectOption, onPickupPointChange, value, onChange }: {
  options?: DeliveryOption[];
  selectedOption?: DeliveryOption | null;
  selectedPickupPoint?: PickupPoint | null;
  addressPostalCode?: string;
  addressCity?: string;
  deliverySelectionEnabled?: boolean;
  loadingOptions?: boolean;
  error?: string;
  pickupPointError?: string;
  onSelectOption?: (option: DeliveryOption) => void;
  onPickupPointChange?: (point: PickupPoint) => void;
  value?: DeliveryKind;
  onChange?: (method: DeliveryKind) => void;
}) {
  const showTiles = deliverySelectionEnabled && options.length > 0;
  const deliveryState = loadingOptions ? "loading" : showTiles ? "dictionary" : "legacy";
  return (
    <section data-delivery-state={deliveryState} className="rounded-2xl border border-warm-sand bg-white p-5">
      <h2 className="font-display text-[16px] font-semibold text-teal-dark">Sposób dostawy</h2>
      {deliveryState === "loading" ? <p role="status">Ładowanie sposobów dostawy…</p> : (
        <fieldset aria-describedby={error ? "delivery-method-error" : undefined}>
          <legend className="sr-only">Sposób dostawy</legend>
          {showTiles ? options.map((option) => (
            <label key={option.id} className="mb-2 block">
              <input type="radio" name="delivery-method" checked={selectedOption?.id === option.id}
                onChange={() => onSelectOption?.(option)} />
              {option.label}<span className="block text-xs text-text-muted">{option.description}</span>
            </label>
          )) : ([["courier", "Kurier"], ["parcel-locker", "Punkt odbioru"]] as const).map(([method, label]) => (
            <label key={method} className="mb-2 block">
              <input type="radio" name="delivery-method" checked={value === method} onChange={() => onChange?.(method)} />{label}
            </label>
          ))}
        </fieldset>
      )}
      {deliveryState === "dictionary" && selectedOption?.pickupPointRequired && onPickupPointChange && (
        <PickupPointPicker carrierKind={selectedOption.carrierKind} postalCode={addressPostalCode} city={addressCity}
          selected={selectedPickupPoint} error={pickupPointError} onSelect={onPickupPointChange} />
      )}
      {error && <p id="delivery-method-error" role="alert">{error}</p>}
    </section>
  );
}
