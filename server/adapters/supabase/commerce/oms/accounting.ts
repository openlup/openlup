import * as managed from "@openlup/platform/commerce/server";
import { omsManagedStore,type CommerceOmsClient } from "./types.js";
export function readAccountingOutbox(client: CommerceOmsClient, ...args: Parameters<typeof managed.readAccountingOutbox> extends [unknown, ...infer Rest] ? Rest : never) { return managed.readAccountingOutbox(omsManagedStore(client), ...args); }
