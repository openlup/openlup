import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { AccountV2TabId } from "../AccountShell";

/**
 * Deep-linkable account navigation. The V2 account is a single `/konto` route;
 * this hook makes the *position within it* (section, selected subscription, open
 * management modal / profile dialog) live in the URL query string so every
 * section and subpage is shareable, reload-stable, and reachable with the
 * browser Back/Forward buttons.
 *
 * Param scheme (all optional; absent ⇒ default):
 *   - `sekcja` → section/tab id (omitted for the default `start`)
 *   - `sub`    → selected subscription id (falls back to the first subscription)
 *   - `modal`  → open overlay: `edit` | `reschedule` | `pause` | `cancel` |
 *                `adres` (change shipping address) | `profil` (profile dialog)
 *
 * The URL is the single source of truth: state is *derived* from the query
 * string each render, so back/forward "just works". User navigation pushes a
 * history entry; closing a modal and normalizing invalid params replace it.
 *
 * Mirrors the `useSearchParams` pattern from the configurator's
 * `useConfiguratorStep`, but pushes (not replaces) on navigation so Back steps
 * between sections/modals instead of leaving `/konto` entirely.
 */

export type AccountModalKind =
  | "edit"
  | "reschedule"
  | "pause"
  | "cancel"
  | "changeAddress";

export interface AccountNavigation {
  tab: AccountV2TabId;
  modal: AccountModalKind | null;
  profileOpen: boolean;
  selectedSubId: string | null;
  setTab: (tab: AccountV2TabId) => void;
  setModal: (modal: AccountModalKind | null) => void;
  setProfileOpen: (open: boolean) => void;
  setSelectedSubId: (id: string | null) => void;
  /**
   * Combined navigation: go to the subscriptions section, select `subscriptionId`,
   * and optionally open `modal` — all in a single history step. Used by the Step 4
   * duplicate-subscription guard CTAs to steer to THIS pet's subscription.
   */
  goToSubscription: (subscriptionId: string | null, modal?: AccountModalKind | null) => void;
}

const TAB_IDS: ReadonlyArray<AccountV2TabId> = [
  "start",
  "subscriptions",
  "orders",
  "pets",
  "addresses",
  "payments",
  "communication",
  "billing",
];

/** Modal kind → URL slug. `changeAddress` reads nicer as `adres` in the bar. */
const MODAL_TO_SLUG: Record<AccountModalKind, string> = {
  edit: "edit",
  reschedule: "reschedule",
  pause: "pause",
  cancel: "cancel",
  changeAddress: "adres",
};
const SLUG_TO_MODAL: Record<string, AccountModalKind> = {
  edit: "edit",
  reschedule: "reschedule",
  pause: "pause",
  cancel: "cancel",
  adres: "changeAddress",
};
const PROFILE_SLUG = "profil";

const SEKCJA_PARAM = "sekcja";
const SUB_PARAM = "sub";
const MODAL_PARAM = "modal";

function isTabId(value: string | null): value is AccountV2TabId {
  return value !== null && (TAB_IDS as ReadonlyArray<string>).includes(value);
}

type NavPatch = {
  tab?: AccountV2TabId;
  sub?: string | null;
  modal?: AccountModalKind | null;
  profile?: boolean;
};

function buildNextParams(prev: URLSearchParams, patch: NavPatch): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (patch.tab !== undefined) {
    if (patch.tab === "start") next.delete(SEKCJA_PARAM);
    else next.set(SEKCJA_PARAM, patch.tab);
    // Entering/leaving a section closes any open subscription modal / profile dialog.
    next.delete(MODAL_PARAM);
  }
  if (patch.sub !== undefined) {
    if (patch.sub) next.set(SUB_PARAM, patch.sub);
    else next.delete(SUB_PARAM);
  }
  if (patch.modal !== undefined) {
    if (patch.modal) next.set(MODAL_PARAM, MODAL_TO_SLUG[patch.modal]);
    else next.delete(MODAL_PARAM);
  }
  if (patch.profile !== undefined) {
    if (patch.profile) next.set(MODAL_PARAM, PROFILE_SLUG);
    else if (next.get(MODAL_PARAM) === PROFILE_SLUG) next.delete(MODAL_PARAM);
  }
  return next;
}

/**
 * @param defaultSubscriptionId Which subscription is selected when `?sub` is
 *   absent/invalid. Callers pass the preferred default (e.g. the first
 *   active/paused subscription) so an abandoned provisional doesn't shadow a
 *   real one; falls back to the first subscription when omitted.
 */
export function useAccountNavigation(
  account: CustomerAccountV2Response,
  defaultSubscriptionId?: string | null,
): AccountNavigation {
  const [searchParams, setSearchParams] = useSearchParams();

  const subIds = useMemo(
    () => account.subscriptions.map((sub) => sub.subscriptionId),
    [account.subscriptions],
  );
  const subIdKey = subIds.join(",");
  const hasSubscriptions = subIds.length > 0;
  const fallbackSubId =
    defaultSubscriptionId && subIds.includes(defaultSubscriptionId)
      ? defaultSubscriptionId
      : subIds[0] ?? null;

  const rawTab = searchParams.get(SEKCJA_PARAM);
  const rawSub = searchParams.get(SUB_PARAM);
  const rawModal = searchParams.get(MODAL_PARAM);

  const tab: AccountV2TabId = isTabId(rawTab) ? rawTab : "start";
  const selectedSubId = rawSub && subIds.includes(rawSub) ? rawSub : fallbackSubId;
  const profileOpen = rawModal === PROFILE_SLUG;
  const modal: AccountModalKind | null =
    !profileOpen && rawModal && rawModal in SLUG_TO_MODAL ? SLUG_TO_MODAL[rawModal] : null;

  // Strip params that are present but invalid for this account (replace: no
  // history entry). Display values are already derived to safe fallbacks above,
  // so this only tidies the URL bar; it never forces a default param onto a
  // bare `/konto`.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (rawTab !== null && (!isTabId(rawTab) || rawTab === "start")) {
      next.delete(SEKCJA_PARAM);
      changed = true;
    }
    if (rawSub !== null && !subIds.includes(rawSub)) {
      next.delete(SUB_PARAM);
      changed = true;
    }
    if (rawModal !== null) {
      const isSubscriptionModal = rawModal in SLUG_TO_MODAL;
      const isKnown = rawModal === PROFILE_SLUG || isSubscriptionModal;
      if (!isKnown || (isSubscriptionModal && !hasSubscriptions)) {
        next.delete(MODAL_PARAM);
        changed = true;
      }
    }
    if (changed) setSearchParams(next, { replace: true });
    // subIdKey captures the subscription-id set without an array dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTab, rawSub, rawModal, subIdKey, hasSubscriptions, setSearchParams]);

  const navigate = useCallback(
    (patch: NavPatch, opts?: { replace?: boolean }) => {
      setSearchParams((prev) => buildNextParams(prev, patch), {
        replace: opts?.replace ?? false,
      });
    },
    [setSearchParams],
  );

  const setTab = useCallback((next: AccountV2TabId) => navigate({ tab: next }), [navigate]);
  const setSelectedSubId = useCallback(
    (id: string | null) => navigate({ sub: id }),
    [navigate],
  );
  // Opening pushes (Back closes); closing replaces (no forward-history clutter).
  const setModal = useCallback(
    (next: AccountModalKind | null) => navigate({ modal: next }, { replace: next === null }),
    [navigate],
  );
  const setProfileOpen = useCallback(
    (open: boolean) => navigate({ profile: open }, { replace: !open }),
    [navigate],
  );
  const goToSubscription = useCallback(
    (subscriptionId: string | null, nextModal: AccountModalKind | null = null) =>
      navigate({ tab: "subscriptions", sub: subscriptionId, modal: nextModal }),
    [navigate],
  );

  return {
    tab,
    modal,
    profileOpen,
    selectedSubId,
    setTab,
    setModal,
    setProfileOpen,
    setSelectedSubId,
    goToSubscription,
  };
}
