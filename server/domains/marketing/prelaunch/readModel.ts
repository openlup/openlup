import {
  MARKETING_PRELAUNCH_CONTRACT_VERSION,
  type AdminPrelaunchLeadDetailResponse,
  type AdminPrelaunchLeadsRequest,
  type AdminPrelaunchLeadsResponse,
  type PrelaunchFeedbackSummary,
  type PrelaunchLead,
  type PrelaunchLeadSourceRef,
  type PrelaunchLeadStage,
  type PrelaunchPetSnapshot,
} from "../../../../src/domains/marketing/prelaunch/contracts.js";

export interface PrelaunchTesterRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  status: string | null;
  created_at: string | null;
  delivered_at: string | null;
  dog_name: string | null;
  dog_breed: string | null;
  dog_age: string | null;
  dog_weight_kg: number | null;
  cat_name: string | null;
  cat_breed: string | null;
  cat_age: string | null;
  cat_weight_kg: number | null;
  pet_type: string | null;
  verification_consent: boolean;
  newsletter_consent: boolean | null;
  email_sequence_paused: boolean | null;
}

export interface PrelaunchWaitlistRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  created_at: string | null;
  dog_name: string | null;
  dog_breed: string | null;
  dog_age: string | null;
  dog_weight_kg: number | null;
  marketing_launch_offer_consent: boolean;
  source: string | null;
  locale: string | null;
}

export interface PrelaunchFeedbackRow {
  id: string;
  tester_id: string | null;
  submitted_at: string | null;
  section_b_submitted_at: string | null;
  section_c_submitted_at: string | null;
  overall_rating: number | null;
  nps_rating: number | null;
  photo_urls: string[] | null;
}

export interface PrelaunchClientRow {
  id: string;
  email: string;
  lifecycle_stage: string;
}

export function buildPrelaunchLeads(input: {
  testers: PrelaunchTesterRow[];
  waitlist: PrelaunchWaitlistRow[];
  feedback: PrelaunchFeedbackRow[];
  clients: PrelaunchClientRow[];
  request: AdminPrelaunchLeadsRequest;
}): AdminPrelaunchLeadsResponse {
  const leads = createLeads(input);
  const filtered = leads
    .filter((lead) => sourceMatches(lead, input.request.source))
    .filter((lead) => input.request.stage === "all" || lead.stage === input.request.stage)
    .filter((lead) => queryMatches(lead, input.request.query))
    .sort(compareLeads);
  const from = input.request.page * input.request.pageSize;

  return {
    contractVersion: MARKETING_PRELAUNCH_CONTRACT_VERSION,
    leads: filtered.slice(from, from + input.request.pageSize),
    totalCount: filtered.length,
    page: input.request.page,
    pageSize: input.request.pageSize,
  };
}

export function buildPrelaunchLeadDetail(input: {
  testers: PrelaunchTesterRow[];
  waitlist: PrelaunchWaitlistRow[];
  feedback: PrelaunchFeedbackRow[];
  clients: PrelaunchClientRow[];
  sourceRef: PrelaunchLeadSourceRef;
}): AdminPrelaunchLeadDetailResponse {
  const lead = createLeads(input).find((candidate) => candidate.sourceRefs.includes(input.sourceRef)) ?? null;

  return { contractVersion: MARKETING_PRELAUNCH_CONTRACT_VERSION, lead };
}

function createLeads(input: {
  testers: PrelaunchTesterRow[];
  waitlist: PrelaunchWaitlistRow[];
  feedback: PrelaunchFeedbackRow[];
  clients: PrelaunchClientRow[];
}): PrelaunchLead[] {
  const feedbackByTester = new Map(input.feedback.flatMap((row) => row.tester_id ? [[row.tester_id, row]] : []));
  const clientByEmail = new Map(input.clients.map((row) => [normalizeEmail(row.email), row]));
  const byEmail = new Map<string, { tester?: PrelaunchTesterRow; waitlist?: PrelaunchWaitlistRow }>();

  for (const tester of input.testers) byEmail.set(normalizeEmail(tester.email), { ...byEmail.get(normalizeEmail(tester.email)), tester });
  for (const waitlist of input.waitlist) byEmail.set(normalizeEmail(waitlist.email), { ...byEmail.get(normalizeEmail(waitlist.email)), waitlist });

  return [...byEmail.values()].map(({ tester, waitlist }) => {
    const email = tester?.email ?? waitlist?.email ?? "";
    const testerRef = tester ? sourceRef("testers", tester.id) : null;
    const waitlistRef = waitlist ? sourceRef("waitlist", waitlist.id) : null;
    const sourceRefs = [testerRef, waitlistRef].filter((ref): ref is PrelaunchLeadSourceRef => ref !== null);
    const feedback = tester ? feedbackByTester.get(tester.id) ?? null : null;
    const client = clientByEmail.get(normalizeEmail(email)) ?? null;
    const reviewRequired = needsReview(tester, waitlist);
    const petSnapshots = [
      ...(tester && testerRef ? testerPetSnapshots(tester, testerRef) : []),
      ...(waitlist && waitlistRef ? [waitlistPetSnapshot(waitlist, waitlistRef)] : []),
    ];
    const feedbackSummary = tester ? summarizeFeedback(tester.id, feedback) : null;
    const displayName = clean([tester?.first_name ?? waitlist?.first_name, tester?.last_name ?? waitlist?.last_name].filter(Boolean).join(" "));

    return {
      contractVersion: MARKETING_PRELAUNCH_CONTRACT_VERSION,
      primarySourceRef: testerRef ?? waitlistRef ?? sourceRef("waitlist", "unknown"),
      sourceRefs,
      sources: [tester ? "tester" as const : null, waitlist ? "waitlist" as const : null].filter((entry): entry is "tester" | "waitlist" => entry !== null),
      stage: stageFor(tester, waitlist, feedbackSummary, client !== null, reviewRequired),
      displayName,
      email,
      phone: clean(tester?.phone ?? null),
      createdAt: latestDate([tester?.created_at ?? null, waitlist?.created_at ?? null]),
      testerStatus: clean(tester?.status ?? null),
      petSnapshots,
      feedbackSummary,
      consentSummary: {
        marketingLaunchOfferConsent: waitlist?.marketing_launch_offer_consent ?? null,
        testerProgramConsent: tester?.verification_consent ?? null,
        newsletterConsent: tester?.newsletter_consent ?? null,
        emailSequencePaused: tester?.email_sequence_paused ?? null,
      },
      attributionSummary: {
        waitlistSource: clean(waitlist?.source ?? null),
        waitlistLocale: waitlist?.locale === "pl" || waitlist?.locale === "en" ? waitlist.locale : null,
      },
      conversionCandidate: {
        status: client ? "already_client" : reviewRequired ? "review_required" : "ready",
        reason: client ? "existing_client" : tester?.status === "rejected" ? "rejected_tester" : reviewRequired ? "conflicting_sources" : "has_email",
        existingClientId: client?.id ?? null,
        existingLifecycleStage: client?.lifecycle_stage ?? null,
        prefill: {
          email,
          firstName: clean(tester?.first_name ?? waitlist?.first_name ?? null),
          lastName: clean(tester?.last_name ?? waitlist?.last_name ?? null),
          phone: clean(tester?.phone ?? null),
          pets: petSnapshots,
        },
      },
    };
  });
}

function sourceRef(table: "testers" | "waitlist", id: string): PrelaunchLeadSourceRef {
  return `${table}:${id}`;
}

function testerPetSnapshots(row: PrelaunchTesterRow, ref: PrelaunchLeadSourceRef): PrelaunchPetSnapshot[] {
  const snapshots: PrelaunchPetSnapshot[] = [];
  if (row.dog_name || row.dog_breed || row.pet_type !== "cat") {
    snapshots.push({ sourceRef: ref, petKind: "dog", name: clean(row.dog_name), breed: clean(row.dog_breed), age: clean(row.dog_age), weightKg: row.dog_weight_kg });
  }
  if (row.cat_name || row.cat_breed || row.pet_type === "cat") {
    snapshots.push({ sourceRef: ref, petKind: "cat", name: clean(row.cat_name), breed: clean(row.cat_breed), age: clean(row.cat_age), weightKg: row.cat_weight_kg });
  }
  return snapshots.length > 0 ? snapshots : [{ sourceRef: ref, petKind: "unknown", name: null, breed: null, age: null, weightKg: null }];
}

function waitlistPetSnapshot(row: PrelaunchWaitlistRow, ref: PrelaunchLeadSourceRef): PrelaunchPetSnapshot {
  return { sourceRef: ref, petKind: "dog", name: clean(row.dog_name), breed: clean(row.dog_breed), age: clean(row.dog_age), weightKg: row.dog_weight_kg };
}

function summarizeFeedback(testerId: string, row: PrelaunchFeedbackRow | null): PrelaunchFeedbackSummary {
  if (!row) {
    return { testerId, feedbackId: null, status: "not_started", submittedAt: null, sectionBSubmittedAt: null, sectionCSubmittedAt: null, overallRating: null, npsRating: null, photoCount: 0 };
  }
  const completed = Boolean(row.submitted_at || row.section_c_submitted_at);
  const started = completed || Boolean(row.section_b_submitted_at || row.overall_rating || row.nps_rating || row.photo_urls?.length);
  return {
    testerId,
    feedbackId: row.id,
    status: completed ? "completed" : started ? "started" : "not_started",
    submittedAt: row.submitted_at,
    sectionBSubmittedAt: row.section_b_submitted_at,
    sectionCSubmittedAt: row.section_c_submitted_at,
    overallRating: row.overall_rating,
    npsRating: row.nps_rating,
    photoCount: row.photo_urls?.length ?? 0,
  };
}

function stageFor(
  tester: PrelaunchTesterRow | undefined,
  waitlist: PrelaunchWaitlistRow | undefined,
  feedback: PrelaunchFeedbackSummary | null,
  alreadyClient: boolean,
  reviewRequired: boolean,
): PrelaunchLeadStage {
  if (!alreadyClient && !reviewRequired && conversionConsentPresent(tester, waitlist)) return "conversion_ready";
  if (!tester) return "waitlist_only";
  if (feedback?.status === "completed" || tester.status === "completed") return "feedback_completed";
  if (feedback?.status === "started") return "feedback_started";
  if (tester.status === "delivered" || tester.status?.startsWith("feedback_")) return "delivered";
  if (tester.status === "shipped" || tester.status === "in_transit" || tester.status === "packing") return "shipped";
  if (tester.status === "approved") return "tester_approved";
  return "tester_signup";
}

function conversionConsentPresent(tester: PrelaunchTesterRow | undefined, waitlist: PrelaunchWaitlistRow | undefined): boolean {
  return waitlist?.marketing_launch_offer_consent === true || tester?.newsletter_consent === true;
}

function needsReview(tester: PrelaunchTesterRow | undefined, waitlist: PrelaunchWaitlistRow | undefined): boolean {
  if (tester?.status === "rejected") return true;
  if (!tester || !waitlist) return false;
  return conflict(tester.first_name, waitlist.first_name)
    || conflict(tester.last_name, waitlist.last_name)
    || conflict(tester.dog_name, waitlist.dog_name);
}

function sourceMatches(lead: PrelaunchLead, source: AdminPrelaunchLeadsRequest["source"]): boolean {
  return source === "all" || lead.sources.includes(source);
}

function queryMatches(lead: PrelaunchLead, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return true;
  return [
    lead.email,
    lead.displayName,
    lead.phone,
    lead.testerStatus,
    ...lead.sourceRefs,
    ...lead.petSnapshots.flatMap((pet) => [pet.name, pet.breed]),
  ].some((value) => value?.toLowerCase().includes(normalized));
}

function compareLeads(a: PrelaunchLead, b: PrelaunchLead): number {
  return Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "");
}

function latestDate(values: (string | null)[]): string | null {
  return values.filter(Boolean).sort((a, b) => Date.parse(b as string) - Date.parse(a as string))[0] ?? null;
}

function conflict(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(clean(left ?? null) && clean(right ?? null) && clean(left ?? null)?.toLowerCase() !== clean(right ?? null)?.toLowerCase());
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
