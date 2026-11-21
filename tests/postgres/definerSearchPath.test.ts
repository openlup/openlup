import { expect, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

// Preserve this baseline when removing settled entries from the pending list.
const ORIGINAL_PENDING: readonly string[] = Object.freeze([
  "public.acquisition_case_active_count_v1()",
  "public.acquisition_case_operator_get_v1(uuid,text)",
  "public.acquisition_case_operator_list_v1(uuid,timestamp with time zone,uuid,integer)",
  "public.acquisition_case_submit_v1(text,text,text,text,boolean,text,text,text,text,text,text,text,text,timestamp with time zone)",
  "public.acquisition_case_transition_v1(uuid,text,bigint,text,text,text,timestamp with time zone)",
  "public.acquisition_newsletter_consent_v1(text,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone)",
  "public.acquisition_survey_operator_list_v1(uuid,text,integer)",
  "public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamp with time zone)",
  "public.partner_acquisition_operator_list_v1(uuid,timestamp with time zone,uuid,integer)",
  "public.partner_acquisition_submit_v1(text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone)",
  "public.partner_acquisition_transition_v1(uuid,text,bigint,text,text,timestamp with time zone)",
]);

export const DEFINER_SEARCH_PATH_PENDING: readonly string[] = Object.freeze([
  "public.acquisition_case_active_count_v1()",
  "public.acquisition_case_operator_get_v1(uuid,text)",
  "public.acquisition_case_operator_list_v1(uuid,timestamp with time zone,uuid,integer)",
  "public.acquisition_case_submit_v1(text,text,text,text,boolean,text,text,text,text,text,text,text,text,timestamp with time zone)",
  "public.acquisition_case_transition_v1(uuid,text,bigint,text,text,text,timestamp with time zone)",
  "public.acquisition_newsletter_consent_v1(text,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone)",
  "public.acquisition_survey_operator_list_v1(uuid,text,integer)",
  "public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamp with time zone)",
  "public.partner_acquisition_operator_list_v1(uuid,timestamp with time zone,uuid,integer)",
  "public.partner_acquisition_submit_v1(text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone)",
  "public.partner_acquisition_transition_v1(uuid,text,bigint,text,text,timestamp with time zone)",
]);

// The qualified installations already pin these legacy pending entries.
const QUALIFIED_PINNED: readonly string[] = Object.freeze([
  "public.acquisition_case_active_count_v1()",
  "public.acquisition_case_operator_list_v1(uuid,timestamp with time zone,uuid,integer)",
  "public.acquisition_case_submit_v1(text,text,text,text,boolean,text,text,text,text,text,text,text,text,timestamp with time zone)",
  "public.acquisition_case_transition_v1(uuid,text,bigint,text,text,text,timestamp with time zone)",
]);

type Definer = { signature: string; search_path: string | null };

function searchPathFailures(definers: readonly Definer[], pending: readonly string[]): string[] {
  const failures: string[] = [];
  const awaitingPin = new Set(pending);
  for (const { signature, search_path: searchPath } of definers) {
    const lastSchema = searchPath?.split(",").at(-1)?.trim();
    const pinned = lastSchema === "pg_temp" || lastSchema === '"pg_temp"';
    if (awaitingPin.delete(signature)) {
      if (pinned) failures.push(`remove ${signature} from DEFINER_SEARCH_PATH_PENDING`);
    } else if (!pinned) {
      // Keep commas inside quoted schema names.
      const schemas = (searchPath?.match(/(?:[^",]|"(?:[^"]|"")*")+/g) ?? [])
        .map(schema => schema.trim())
        .filter(schema => schema && schema !== "pg_temp" && schema !== '"pg_temp"');
      const suggestedPath = [...schemas, "pg_temp"].join(", ");
      failures.push(`SECURITY DEFINER function ${signature}: pin pg_temp last: SET search_path = ${suggestedPath}`);
    }
  }
  for (const signature of awaitingPin) {
    failures.push(`remove ${signature} from DEFINER_SEARCH_PATH_PENDING: SECURITY DEFINER function is missing`);
  }
  return failures;
}

it("allows only removals from the original pending list", () => {
  const additions = DEFINER_SEARCH_PATH_PENDING.filter(signature => !ORIGINAL_PENDING.includes(signature));
  expect(additions, "DEFINER_SEARCH_PATH_PENDING may only shrink").toEqual([]);
});

it.each(["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "pins pg_temp last on all non-pending definers in the %s installation",
  async profile => {
    const { owner, close } = await installAccountMutations(profile, false, "definer-search-path");
    try {
      const { rows } = await owner.query<Definer>(`
        SELECT pg_catalog.format('%I.%I(%s)', n.nspname, p.proname,
                 pg_catalog.array_to_string(ARRAY(
                   SELECT pg_catalog.format_type(arg, NULL)
                   FROM pg_catalog.unnest(p.proargtypes) WITH ORDINALITY AS args(arg, position)
                   ORDER BY position
                 ), ',')) AS signature,
               (SELECT pg_catalog.substr(setting, 13)
                FROM pg_catalog.unnest(p.proconfig) AS setting
                WHERE pg_catalog.starts_with(setting, 'search_path=')) AS search_path
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        ORDER BY 1
      `);
      const pending = profile === "legacy" ? DEFINER_SEARCH_PATH_PENDING
        : DEFINER_SEARCH_PATH_PENDING.filter(signature => !QUALIFIED_PINNED.includes(signature));
      const failures = searchPathFailures(rows, pending);
      expect(failures, failures.join("\n")).toEqual([]);
    } finally {
      await close();
    }
  },
  postgresSetupTimeoutMs,
);

it("reports a pinned pending definer, an unpinned definer and a stale pending entry", () => {
  expect(searchPathFailures([
    { signature: "public.pending_pinned()", search_path: "pg_catalog, pg_temp" },
    { signature: "public.unpinned()", search_path: "pg_catalog, public" },
    { signature: "public.no_setting()", search_path: null },
    { signature: "public.empty_setting()", search_path: "" },
    { signature: "public.temp_first()", search_path: "pg_temp, public" },
    { signature: "public.temp_repeated()", search_path: 'pg_temp, "pg_temp", "schema, name", public' },
    { signature: "public.pinned()", search_path: 'pg_catalog, "pg_temp"' },
  ], ["public.pending_pinned()", "public.missing()"])).toEqual([
    "remove public.pending_pinned() from DEFINER_SEARCH_PATH_PENDING",
    "SECURITY DEFINER function public.unpinned(): pin pg_temp last: SET search_path = pg_catalog, public, pg_temp",
    "SECURITY DEFINER function public.no_setting(): pin pg_temp last: SET search_path = pg_temp",
    "SECURITY DEFINER function public.empty_setting(): pin pg_temp last: SET search_path = pg_temp",
    "SECURITY DEFINER function public.temp_first(): pin pg_temp last: SET search_path = public, pg_temp",
    'SECURITY DEFINER function public.temp_repeated(): pin pg_temp last: SET search_path = "schema, name", public, pg_temp',
    "remove public.missing() from DEFINER_SEARCH_PATH_PENDING: SECURITY DEFINER function is missing",
  ]);
});
