import {
  CommerceNotEnabledError,
  type CommerceOrderDraftWritePort,
} from "../../../src/domains/commerce/ports.js";

export function createDisabledCommerceOrderDraftPort(): CommerceOrderDraftWritePort {
  return {
    async createOrderDraft() {
      throw new CommerceNotEnabledError("order draft");
    },
  };
}
