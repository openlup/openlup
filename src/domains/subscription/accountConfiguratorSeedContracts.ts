/**
 * What a signed-in account hands the package composer when it starts a new order.
 *
 * A *port* in the strict sense: it states the fields the ordering surfaces read
 * and nothing else. The composition of the seed — reading the account, mapping
 * its stored details onto composer form fields, deciding which of them survive —
 * is a deployment concern and stays with whoever owns those mappings. What the
 * screens downstream may rely on is this shape, and they depend on it rather
 * than on the builder that happens to produce it.
 *
 * It exists because the account's confirmation screen previously imported this
 * declaration from the composer's own seed builder, which made a publishable
 * surface depend on an unpublishable one for a type it fully describes on its
 * own. The builder still produces exactly this shape; it now says so by
 * importing the declaration instead of owning it.
 */
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";

export interface AccountConfiguratorSeed {
  /** A complete form seed — always set, including the verified `email`. */
  form: ConfiguratorFormData;
  /** Free-text exclusions that still need confirming in the composer. */
  unrecognizedAllergies: string[];
  /** Age band could not be derived → the confirm screen must resolve it. */
  ageUnresolved: boolean;
  /**
   * The subject already holds a live subscription → block a second one and
   * offer a one-time order instead.
   */
  hasActiveSubscriptionForSubject: boolean;
  /**
   * The id of the subject's live subscription (active/paused/pending), or null
   * when there is none. Lets the guard CTAs steer to THAT subscription rather
   * than to the generic all-subscriptions list.
   */
  activeSubscriptionId: string | null;
  /**
   * The composer payment-method value the account last used, for the
   * account-only "last used" badge. `null` when there is nothing to badge (the
   * last method was one the picker cannot render).
   */
  lastUsedPaymentMethod: ConfiguratorFormData["paymentMethod"];
}
