import { recordPromotionAcceptanceOutcome as record } from "@openlup/platform/promotions";
import { consoleOperationalEventRecorder, type OperationalEventRecorder } from "../../_lib/observability/operationalEvents.js";
import type { PromotionAcceptanceTelemetry } from "@openlup/platform/promotions";
export { PROMOTION_ACCEPTANCE_STAGES, PROMOTION_ACCEPTANCE_OUTCOMES, PROMOTION_ACCEPTANCE_REASONS, PROMOTION_ACCEPTANCE_KEY_SLOTS, PROMOTION_ACCEPTANCE_EXPIRY_BUCKETS } from "@openlup/platform/promotions";
export type { PromotionAcceptanceTelemetry } from "@openlup/platform/promotions";
export function recordPromotionAcceptanceOutcome(details: PromotionAcceptanceTelemetry, surface: "public" | "hidden", recorder: OperationalEventRecorder = consoleOperationalEventRecorder): void {
  record(details, surface, recorder);
}
