import { useEffect, useRef, useState } from "react";
import type { PickupPoint } from "@openlup/platform/shipping/contracts";
import { usePickupPointSearch } from "@/domains/shipping/usePickupPointSearch";

/** List-first point picking through the existing shipping client. */
export function PickupPointPicker({ carrierKind, postalCode, city, selected, error, onSelect }: {
  carrierKind: string;
  postalCode?: string;
  city?: string;
  selected?: PickupPoint | null;
  error?: string;
  onSelect: (point: PickupPoint) => void;
}) {
  const [picking, setPicking] = useState(!selected);
  const justPickedRef = useRef(false);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const search = usePickupPointSearch({ carrierKind, postalCode, city });
  const showList = !selected || picking;
  useEffect(() => {
    if (!showList && justPickedRef.current) selectedRef.current?.focus();
  }, [showList]);
  function commit(point: PickupPoint) {
    justPickedRef.current = true;
    onSelect(point);
    setPicking(false);
  }
  return (
    <section className="mt-3 rounded-xl border border-warm-sand p-4">
      <h3 className="text-sm font-semibold">Punkt odbioru</h3>
      {showList ? <>
        <label className="block">Szukaj punktu
          <input value={search.query} onChange={(event) => search.changeQuery(event.target.value)}
            aria-invalid={Boolean(error)} aria-describedby={error ? "pickup-point-error" : undefined} />
        </label>
        <div aria-live="polite">
          {search.status === "loading" && <p>Wyszukiwanie…</p>}
          {search.status === "done" && <p>Znalezione punkty: {search.results.length}</p>}
          {search.status === "error" && <p role="alert">Nie udało się wyszukać punktów.
            <button type="button" onClick={search.retry}>Spróbuj ponownie</button>
          </p>}
        </div>
        <ul aria-label="Wyniki wyszukiwania punktów">
          {search.results.map((point) => <li key={point.id}>
            <button type="button" aria-pressed={selected?.id === point.id} onClick={() => commit({
              id: point.id, provider: point.carrierKind, name: point.name, address: point.address,
            })}>
              {point.name}, {point.address.line1}, {point.address.postalCode} {point.address.city}
              {point.appAssisted && <span> Wymaga aplikacji przewoźnika</span>}
            </button>
          </li>)}
        </ul>
      </> : <div>
        <p>{selected.name}, {selected.address.line1}, {selected.address.postalCode} {selected.address.city}</p>
        <button type="button" ref={selectedRef} onClick={() => { justPickedRef.current = false; setPicking(true); }}>Zmień punkt</button>
      </div>}
      {error && <p id="pickup-point-error" role="alert">{error}</p>}
    </section>
  );
}
