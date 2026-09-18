import type {
  ChannelIngestOrderItemReadPort,
  ChannelIngestPaymentControlPort,
  ChannelIngestReservationPort,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import {
  createManagedChannelIngestOrderItemRead,
  type ManagedChannelRailsClient,
} from "../supabase/channelIngestRails.js";
import { ChannelIngestCapabilityUnavailableError } from "./channelIngestStore.js";

// The saga's three borrowed rails on the direct-Postgres lane, where exactly one of them can be
// honest.
//
// THIS FILE IS MOSTLY REFUSALS, AND THAT IS THE POINT. The store adapter on this lane already
// refuses `channel_ingest_upsert_buyer` and `commerce_create_channel_order` by name, because the
// platform migration catalogue authors neither. The rails divide the same way when measured
// against that catalogue rather than assumed:
//
//   - ORDER ITEMS: authored. `public.commerce_order_items` exists on this chain, so the read binds,
//     and it binds to the SAME reader the managed chain uses. That is not a coincidence worth
//     hiding behind a second implementation: the direct-Postgres gateway client exposes the same
//     `from(...).select(...).eq(...)` surface the managed client does, so one reader is correct on
//     both chains and a second one would only be a place for them to drift apart.
//   - RESERVATIONS: absent. There is no `inventory_reservations` table and no reservation boundary
//     in this catalogue at all.
//   - PAYMENT CONTROL: absent. This chain's money model is the settlement-intent rail; it has no
//     payment intents, attempts, events or apply-result boundary for the saga to drive.
//
// A refusal names the missing capability rather than returning a fabricated id, for the reason the
// store adapter already states: a fabricated reservation would let an order reach `paid` with no
// stock held, which is the one failure this whole saga is shaped to prevent. A deployment on this
// lane can therefore ingest a channel delivery as far as the quarantine drawer and no further, and
// it finds that out from an error that says which rail is missing.

/**
 * One operation, one transaction — the posture the store adapter on this lane already takes. The
 * runner is passed in rather than a client, because on this chain a client only exists inside a
 * transaction the lane opens.
 */
export type PostgresChannelRailsRunner = <T>(
  work: (client: ManagedChannelRailsClient) => Promise<T>,
) => Promise<T>;

/** Reused verbatim: the platform catalogue authors this table, and the gateway shapes alike. */
export function createPostgresChannelIngestOrderItemRead(
  run: PostgresChannelRailsRunner,
): ChannelIngestOrderItemReadPort {
  return {
    readOrderItems: (orderId) =>
      run((client) => createManagedChannelIngestOrderItemRead(client).readOrderItems(orderId)),
  };
}

export function createPostgresChannelIngestReservations(): ChannelIngestReservationPort {
  return {
    reserveChannelOrderItems() {
      return Promise.reject(new ChannelIngestCapabilityUnavailableError("inventory_reserve_order_items"));
    },
  };
}

export function createPostgresChannelIngestPayments(): ChannelIngestPaymentControlPort {
  return {
    createIntent() {
      return Promise.reject(
        new ChannelIngestCapabilityUnavailableError("commerce_payment_control_create_intent"),
      );
    },
    recordAttempt() {
      return Promise.reject(
        new ChannelIngestCapabilityUnavailableError("commerce_payment_control_record_attempt"),
      );
    },
    ingestSettlementEvent() {
      return Promise.reject(
        new ChannelIngestCapabilityUnavailableError("commerce_payment_control_ingest_event"),
      );
    },
    applySucceeded() {
      return Promise.reject(
        new ChannelIngestCapabilityUnavailableError("commerce_payment_control_apply_result"),
      );
    },
  };
}

export interface PostgresChannelIngestRails {
  reservations: ChannelIngestReservationPort;
  orderItems: ChannelIngestOrderItemReadPort;
  payments: ChannelIngestPaymentControlPort;
}

export function createPostgresChannelIngestRails(
  run: PostgresChannelRailsRunner,
): PostgresChannelIngestRails {
  return {
    reservations: createPostgresChannelIngestReservations(),
    orderItems: createPostgresChannelIngestOrderItemRead(run),
    payments: createPostgresChannelIngestPayments(),
  };
}
