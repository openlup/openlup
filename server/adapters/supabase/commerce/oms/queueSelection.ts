import { readQueueSelection as readNeutral } from "@openlup/platform/commerce/server";
import type { AdminOmsOrderSearchMatch, AdminOmsOrderListSummaryCounts } from "../../../../../src/domains/commerce/omsContracts.js";
import { referenceOmsCurrency } from "../../../../../src/domains/commerce/omsReferenceBinding.js";
import { referenceOmsManagedProjections } from "./referenceProjections.js";
import { omsManagedStore,type CommerceOmsClient } from "./types.js";
export type QueueSelection = Omit<Awaited<ReturnType<typeof readNeutral>>, "summaryCounts" | "matches"> & { summaryCounts: AdminOmsOrderListSummaryCounts; matches: Record<string, AdminOmsOrderSearchMatch> };
export async function readQueueSelection(client: CommerceOmsClient, request: Parameters<typeof readNeutral>[1]): Promise<QueueSelection> {
 const result = await readNeutral(omsManagedStore(client), request, { currency: referenceOmsCurrency, projectResult: referenceOmsManagedProjections.projectQueue, matchSchema: referenceOmsManagedProjections.queueMatchSchema });
 const { providerDispatchedNotPicked, ...rest } = result.summaryCounts;
 return { ...result, matches: result.matches as Record<string, AdminOmsOrderSearchMatch>, summaryCounts: { ...rest, omnipackDispatchedNotPicked: providerDispatchedNotPicked ?? 0 } };
}
