import type { CustomerMeResponse } from "./customerContracts.js";
export interface CustomerMePort { getCustomerMe(principalId: string): Promise<CustomerMeResponse | null> }
