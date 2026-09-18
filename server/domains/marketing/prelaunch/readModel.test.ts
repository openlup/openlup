import { describe, expect, it } from "vitest";
import { buildPrelaunchLeadDetail, buildPrelaunchLeads } from "./readModel.js";
import type {
  PrelaunchClientRow,
  PrelaunchFeedbackRow,
  PrelaunchTesterRow,
  PrelaunchWaitlistRow,
} from "./readModel.js";

describe("marketing prelaunch read model", () => {
  it("keeps tester and waitlist source refs while surfacing feedback and existing clients", () => {
    const response = buildPrelaunchLeads({
      testers: [tester({ status: "completed" })],
      waitlist: [waitlist()],
      feedback: [feedback({ submitted_at: "2026-07-06T10:00:00.000Z" })],
      clients: [{ id: "client-1", email: "jan@example.com", lifecycle_stage: "customer" }],
      request: { page: 0, pageSize: 50, source: "all", stage: "all" },
    });

    expect(response.totalCount).toBe(1);
    expect(response.leads[0]).toMatchObject({
      primarySourceRef: "testers:tester-1",
      sourceRefs: ["testers:tester-1", "waitlist:waitlist-1"],
      sources: ["tester", "waitlist"],
      stage: "feedback_completed",
      attributionSummary: {
        waitlistSource: "launch-popup",
        waitlistLocale: "pl",
      },
      conversionCandidate: {
        status: "already_client",
        reason: "existing_client",
        existingClientId: "client-1",
      },
    });
    expect(response.leads[0].feedbackSummary).toMatchObject({ status: "completed", photoCount: 2 });
  });

  it("classifies waitlist-only leads and rejected testers without creating customers", () => {
    const response = buildPrelaunchLeads({
      testers: [tester({ email: "rejected@example.com", id: "tester-rejected", status: "rejected" })],
      waitlist: [waitlist({ email: "wait@example.com" })],
      feedback: [],
      clients: [],
      request: { page: 0, pageSize: 50, source: "all", stage: "all" },
    });

    const waitlistLead = response.leads.find((lead) => lead.email === "wait@example.com");
    const rejectedLead = response.leads.find((lead) => lead.email === "rejected@example.com");

    expect(waitlistLead?.stage).toBe("conversion_ready");
    expect(waitlistLead?.conversionCandidate.status).toBe("ready");
    expect(rejectedLead?.stage).toBe("tester_signup");
    expect(rejectedLead?.conversionCandidate).toMatchObject({ status: "review_required", reason: "rejected_tester" });
  });

  it("returns details for either source ref and includes linked records by email", () => {
    const response = buildPrelaunchLeadDetail({
      testers: [tester()],
      waitlist: [waitlist()],
      feedback: [],
      clients: [],
      sourceRef: "waitlist:waitlist-1",
    });

    expect(response.lead?.sourceRefs).toEqual(["testers:tester-1", "waitlist:waitlist-1"]);
  });
});

function tester(overrides: Partial<PrelaunchTesterRow> = {}): PrelaunchTesterRow {
  return {
    id: "tester-1",
    email: "jan@example.com",
    first_name: "Jan",
    last_name: "Kowalski",
    phone: "123456789",
    status: "delivered",
    created_at: "2026-07-05T10:00:00.000Z",
    delivered_at: "2026-07-06T10:00:00.000Z",
    dog_name: "Figa",
    dog_breed: "mix",
    dog_age: "3",
    dog_weight_kg: 12,
    cat_name: null,
    cat_breed: null,
    cat_age: null,
    cat_weight_kg: null,
    pet_type: "dog",
    verification_consent: true,
    newsletter_consent: false,
    email_sequence_paused: false,
    ...overrides,
  };
}

function waitlist(overrides: Partial<PrelaunchWaitlistRow> = {}): PrelaunchWaitlistRow {
  return {
    id: "waitlist-1",
    email: "jan@example.com",
    first_name: "Jan",
    last_name: "Kowalski",
    created_at: "2026-07-04T10:00:00.000Z",
    dog_name: "Figa",
    dog_breed: "mix",
    dog_age: "3",
    dog_weight_kg: 12,
    marketing_launch_offer_consent: true,
    source: "launch-popup",
    locale: "pl",
    ...overrides,
  };
}

function feedback(overrides: Partial<PrelaunchFeedbackRow> = {}): PrelaunchFeedbackRow {
  return {
    id: "feedback-1",
    tester_id: "tester-1",
    submitted_at: null,
    section_b_submitted_at: null,
    section_c_submitted_at: null,
    overall_rating: 5,
    nps_rating: 10,
    photo_urls: ["a.jpg", "b.jpg"],
    ...overrides,
  };
}
