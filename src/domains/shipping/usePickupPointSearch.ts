import { useCallback, useEffect, useRef, useState } from "react";

import type { PickupPointSearchResult } from "@/domains/shipping/pickupPointSearchContracts";
import { searchPickupPoints } from "@/domains/shipping/deliverySelectionClient";


export type PickupSearchStatus = "idle" | "loading" | "done" | "error";

const DEBOUNCE_MS = 350;
const RESULT_LIMIT = 15;

/** Debounced address-seeded text search with stale-response protection. */
export function usePickupPointSearch({
  carrierKind,
  postalCode,
  city,
}: {
  carrierKind: string;
  postalCode?: string;
  city?: string;
}) {
  const seed = (postalCode?.trim() || city?.trim() || "");
  const [query, setQuery] = useState(seed);
  const [results, setResults] = useState<PickupPointSearchResult[]>([]);
  const [status, setStatus] = useState<PickupSearchStatus>("idle");

  // Debounce and address seeding mean several searches can be in
  // flight at once, and a slow early response must never overwrite a newer one.
  // The abort saves bandwidth; the monotonic id is the actual correctness net,
  // because an aborted request can still have resolved before it was cancelled.
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (locator: { query?: string }) => {
      const term = locator.query?.trim() ?? "";
      if (!term) {
        // Invalidate FIRST. Clearing the box must also cancel whatever is in
        // flight, or a seed response that lands afterwards still passes the id
        // guard and repopulates the list the customer just emptied — lockers
        // for a postcode that is no longer on screen, ready to be picked.
        requestIdRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setStatus("idle");
        setResults([]);
        return;
      }

      const requestId = ++requestIdRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("loading");

      try {
        const response = await searchPickupPoints(
          {
            carrierKind,
            query: term,
            limit: RESULT_LIMIT,
          },
          { signal: controller.signal },
        );
        if (requestId !== requestIdRef.current) return;
        setResults(response.points);
        setStatus("done");
      } catch {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        setResults([]);
        setStatus("error");
      }
    },
    [carrierKind],
  );

  const typedRef = useRef(false);

  // Follow address edits until the customer explicitly types a search.
  useEffect(() => {
    if (typedRef.current || !seed.trim()) return;
    setQuery(seed);
    const timer = setTimeout(() => void run({ query: seed }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [seed, run]);

  // A carrier switch invalidates the list: the effects above are latched behind
  // typedRef, so without this the previous carrier's lockers stay on
  // screen under the new carrier and can still be picked.
  const carrierRef = useRef(carrierKind);
  useEffect(() => {
    if (carrierRef.current === carrierKind) return;
    carrierRef.current = carrierKind;
    void run({ query });
  }, [carrierKind, run, query]);

  // Debounced re-search while typing. The seed path above owns address searches,
  // and this is skipped until the customer actually types, so a seed never
  // fires two searches.
  useEffect(() => {
    if (!typedRef.current) return;
    const timer = setTimeout(() => void run({ query }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, run]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const changeQuery = useCallback((value: string) => {
    typedRef.current = true;
    setQuery(value);
  }, []);

  return {
    query,
    changeQuery,
    results,
    status,
    /** Re-runs the current locator. A failed search otherwise has no way out:
     *  the debounce only fires on a keystroke, so the customer would have to
     *  edit their query to escape a transient network error. */
    retry: useCallback(
      () => void run({ query }),
      [run, query],
    ),
  };
}

