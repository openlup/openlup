/** Verified human administrator context, supplied by the host. */
export interface OperatorContext { operatorId: string; role: "admin"; isMachineActor: false; graph: "managed" | "native" }
/** Verbatim parsed customer-360 lookup vocabulary; defaults belong to the host codec. */
export interface Customer360Lookup {
  query?: string; subjectId?: string; orderId?: string; subscriptionId?: string;
  email?: string; pageSize: number; mode?: "search" | "snapshot";
}
/** The supplied search/snapshot DTOs preserve owner coverage and omitted enrichments. */
export interface Customer360ReadPort<Search, Snapshot> {
  searchCustomerJourney(request: Customer360Lookup): Promise<Search>;
  getCustomerJourney(request: Customer360Lookup): Promise<Snapshot | null>;
}
