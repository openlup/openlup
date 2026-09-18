import type { VercelResponse } from "../types/vercel.js";
import { sendBffError } from "../bff/response.js";
import {
  AGENT_CUSTOMER_READ_FLAG,
  auditAgentCustomerRead,
  enforceAgentCustomerRead,
  maskEmail,
  maskPhone,
  type AgentAuditClient,
} from "./agentCustomerReadGuard.js";

/**
 * Actor-kind-aware governance for the agent-operable OMS CUSTOMER reads. The OMS
 * order list/detail routes are shared by the human admin UI and the MCP agent;
 * governance is keyed on `isMachineActor` (machine-only flag gate + audit + mask).
 * Wave 7a.
 */
export interface OmsAgentReadGovernance {
  flagEnabled: boolean;
  auditClient: AgentAuditClient;
  onAuditError?: (error: unknown) => void;
}

type Authorization = { ok: true; userId?: string; isMachineActor?: boolean };

interface OmsOrderCustomer {
  email?: string | null;
  phone?: string | null;
}

/** Why the order matched the operator's search, plus a preview of the matched value. */
interface OmsOrderSearchMatch {
  field?: string;
  valuePreview?: string | null;
}

interface OmsOrderRow {
  orderId?: string;
  clientId?: string | null;
  customer?: OmsOrderCustomer | null;
  match?: OmsOrderSearchMatch | null;
  deliveryContact?: {
    baseline?: OmsDeliveryContact | null;
    effective?: OmsDeliveryContact | null;
    digest?: string | null;
    correctionAllowed?: boolean;
  } | null;
  shippingAddress?: OmsOrderAddress | null;
  billingAddress?: OmsOrderAddress | null;
}

interface OmsDeliveryContact {
  contactEmail?: string | null;
  contactPhone?: string | null;
}

interface OmsOrderAddress {
  contactPhone?: string | null;
}

export interface OmsAgentReadGate {
  blocked: boolean;
  isMachine: boolean;
  audit: (customerIds: string[]) => Promise<void>;
  /** Mask the customer PII on each order of a list result; identity for humans. */
  maskOrders: <TOrder extends OmsOrderRow, TResult extends { orders: TOrder[] }>(
    result: TResult,
  ) => TResult;
}

export function applyOmsAgentCustomerReadGate(input: {
  authorization: Authorization;
  governance: OmsAgentReadGovernance | undefined;
  res: VercelResponse;
  route: string;
  query: Record<string, unknown>;
}): OmsAgentReadGate {
  const { authorization, governance, res, route, query } = input;
  const isMachine = authorization.isMachineActor === true;
  const actorId = authorization.userId;

  const passthrough: OmsAgentReadGate = {
    blocked: false,
    isMachine,
    audit: async () => {},
    maskOrders: (result) => result,
  };

  if (!governance || !isMachine) return passthrough;

  if (enforceAgentCustomerRead({ isMachineActor: true, flagEnabled: governance.flagEnabled }).blocked) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Agent customer reads are disabled", {
      details: { reason: "feature_flag_disabled", featureFlag: AGENT_CUSTOMER_READ_FLAG },
    });
    return { ...passthrough, blocked: true };
  }

  const onError =
    governance.onAuditError ?? ((error: unknown) => console.error("agent_customer_read_audit_failed", error));
  return {
    blocked: false,
    isMachine: true,
    audit: async (customerIds) => {
      if (!actorId) return;
      await auditAgentCustomerRead(governance.auditClient, { actorId, route, query, customerIds }, onError);
    },
    maskOrders: (result) => ({
      ...result,
      orders: result.orders.map((order) => {
        const customer = order.customer
          ? { ...order.customer, email: maskEmail(order.customer.email) ?? order.customer.email, phone: maskPhone(order.customer.phone) }
          : order.customer;
        const match = order.match ? maskSearchMatch(order.match) : order.match;
        const deliveryContact = maskDeliveryContactProjection(order.deliveryContact);
        const shippingAddress = maskOrderAddress(order.shippingAddress);
        const billingAddress = maskOrderAddress(order.billingAddress);
        if (
          customer === order.customer
          && match === order.match
          && deliveryContact === order.deliveryContact
          && shippingAddress === order.shippingAddress
          && billingAddress === order.billingAddress
        ) return order;
        return { ...order, customer, match, deliveryContact, shippingAddress, billingAddress };
      }),
    }),
  };
}

function maskOrderAddress<TAddress extends OmsOrderAddress | null | undefined>(
  address: TAddress,
): TAddress {
  if (!address) return address;
  return { ...address, contactPhone: maskPhone(address.contactPhone) } as TAddress;
}

function maskDeliveryContactProjection<TProjection extends OmsOrderRow["deliveryContact"]>(
  projection: TProjection,
): TProjection {
  if (!projection) return projection;
  return {
    ...projection,
    baseline: maskDeliveryContact(projection.baseline),
    effective: maskDeliveryContact(projection.effective),
    // The digest is computed from the unmasked contact and would otherwise be
    // a stable dictionary oracle for machine readers that receive masked PII.
    digest: null,
    // ...and withholding it while still reporting `correctionAllowed: true` told
    // the machine reader it may correct the address, when the digest is the only
    // token that satisfies the correction fence. The two fields now agree.
    correctionAllowed: false,
  } as TProjection;
}

function maskDeliveryContact<TContact extends OmsDeliveryContact | null | undefined>(
  contact: TContact,
): TContact {
  if (!contact) return contact;
  return {
    ...contact,
    contactEmail: maskEmail(contact.contactEmail),
    contactPhone: maskPhone(contact.contactPhone),
  } as TContact;
}

/**
 * The search preview is masked in SQL for EVERY caller, with a more revealing
 * algorithm than this gate's — so a gated agent used to read the same person's
 * address at two redaction levels in one response. Re-mask the two PII previews
 * with the gate's own maskers (idempotent over the SQL output). Every other match
 * field is an order/tracking/product locator and is left as the operator sees it.
 */
function maskSearchMatch<TMatch extends OmsOrderSearchMatch>(match: TMatch): TMatch {
  if (match.field === "email") return { ...match, valuePreview: maskEmail(match.valuePreview) };
  if (match.field === "phone") return { ...match, valuePreview: maskPhone(match.valuePreview) };
  return match;
}
