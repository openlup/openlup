import { readOmsInboundEvents } from "@openlup/platform/commerce/server";
import { omsManagedStore,type CommerceOmsClient } from "./types.js";
export function readOmnipackInboundEvents(client: CommerceOmsClient, input: Omit<Parameters<typeof readOmsInboundEvents>[1], "providerKind">) { return readOmsInboundEvents(omsManagedStore(client), { ...input, providerKind: "omnipack" }); }
