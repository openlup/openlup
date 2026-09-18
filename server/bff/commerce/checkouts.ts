import { withObservedRoute } from "../../_lib/observability/route.js";
import { checkoutRiskBlockingEnabled, riskHashSecret } from "../../_lib/config/featureFlags.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { sendBffError } from "../../_lib/bff/response.js";
import {
  checkAndRecordCheckoutAttempt,
  extractClientIp,
  type PublicCheckoutRateLimitClient,
} from "../../_lib/rate-limit/publicCheckoutRateLimit.js";
import {
  createLocalReferenceCheckoutRuntimePort,
  localReferenceDemoProfileEnabled,
  localReferenceCommandMatchesProfile,
  localReferencePaymentProviderFor,
  createLocalReferenceRiskCheckoutBlocklistPort,
} from "../../adapters/localReferenceStoreAdapter.js";
import { createReferenceCheckoutHandler } from "../../domains/commerce/referenceCheckoutHandler.js";
import { riskSubjectHash } from "../../domains/risk/riskFingerprint.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";

async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  // This gate must remain above the gateway read so an inactive route cannot
  // construct a service-role client even when its process has credentials.
  if (!localReferenceDemoProfileEnabled()) {
    sendBffError(res, "NOT_FOUND", "Reference checkout not found");
    return;
  }

  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference checkout is not configured");
    return;
  }

  return gateway.asService((client) => {
    const runtimePort = createLocalReferenceCheckoutRuntimePort(client);
    return createReferenceCheckoutHandler({
      startCheckout: (command) => runtimePort.startCheckoutCommand({
        command,
        paymentProvider: localReferencePaymentProviderFor(command),
        metadata: { source: "reference_store.local.v1" },
      }),
      checkRateLimit: (request, command) => checkAndRecordCheckoutAttempt({
        client: client as PublicCheckoutRateLimitClient,
        ip: extractClientIp(request.headers),
        email: command.customer.email,
        journeyIdempotencyKey: command.idempotencyKey,
        paymentAttemptSequence: 0,
      }),
      checkRiskBlocklist: checkoutRiskBlockingEnabled()
        ? async (request, command) => createLocalReferenceRiskCheckoutBlocklistPort(client)
          .checkExactBlocklist({
            subjectRefs: [
              { subjectKind: "email", subjectHash: riskSubjectHash("email", command.customer.email, riskHashSecret()) },
              { subjectKind: "ip", subjectHash: riskSubjectHash("ip", extractClientIp(request.headers), riskHashSecret()) },
            ],
          })
        : undefined,
      admitProfile: localReferenceCommandMatchesProfile,
    })(req, res);
  });
}

export default withObservedRoute({
  route: "/api/bff/commerce/checkouts",
  domain: "commerce",
  surface: "public",
  risk: "mutation",
  featureFlags: [
    "COMMERCE_RISK_EVALUATION_ENABLED",
    "COMMERCE_RISK_CHECKOUT_BLOCKLIST_BLOCKING_ENABLED",
  ],
}, handler);
