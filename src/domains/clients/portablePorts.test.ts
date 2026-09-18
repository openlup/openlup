import { describe, expect, it } from "vitest";
import type { ClientsPortableAdminReadPort } from "./portablePorts.js";

describe("portable clients admin port", () => {
  it("keeps all three customer-index reads behind one named capability", async () => {
    const port: ClientsPortableAdminReadPort = {
      getPortableSummary: async () => ({
        contractVersion: "clients.customer_360.v2",
        summary: {
          totalSubjects: 0,
          byLifecycleStage: { lead: 0, waitlist: 0, tester: 0, customer: 0, inactive: 0 },
          openDunningCases: 0,
          recoverableCases: 0,
          lastActivityAt: null,
        },
      }),
      searchPortableClients: async (request) => ({
        contractVersion: "clients.customer_360.v2",
        candidates: [],
        totalCount: 0,
        page: request.page,
        pageSize: request.pageSize,
      }),
      getPortableClientDetail: async () => null,
    };

    const response = await port.searchPortableClients({
      query: "buyer@example.com",
      page: 0,
      pageSize: 10,
      lifecycleStage: "all",
    });

    expect(response.candidates).toEqual([]);
  });
});
