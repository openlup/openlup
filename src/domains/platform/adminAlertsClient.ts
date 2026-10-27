import { requestBff } from "@/lib/bff/client";
import { createOperationsClients } from "@openlup/platform/operations";
export const getAdminAlertsOverview = createOperationsClients(requestBff).getAdminAlertsOverview;
