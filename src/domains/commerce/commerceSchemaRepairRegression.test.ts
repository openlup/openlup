import { createHash } from "node:crypto";
import type { z } from "zod";
import { expect, expectTypeOf, it } from "vitest";
import { PLATFORM_ACCEPTED_CURRENCIES } from "../../lib/currency/platformCurrency.js";
import { PAYMENT_EXECUTION_PROVIDERS } from "../payment/types.js";
import * as contracts from "./contracts.js";
import * as intent from "./configuratorIntentContracts.js";
import * as checkout from "./checkoutContracts.js";
import * as persistence from "./configuratorIntentPersistenceContracts.js";
import * as resume from "./checkoutResumeContracts.js";
import * as primitives from "./contractPrimitives.js";
import * as defaults from "./customerDefaultsSnapshotContracts.js";
import * as availability from "./offerAvailabilityContracts.js";
import * as outbox from "./outboxEventContracts.js";
import { admitCheckoutRequest } from "../../../server/domains/commerce/commerceCheckoutHandlerAdmission.js";
import type { VercelResponse as HttpResponse } from "../../../server/_lib/types/vercel.js";
import { vi } from "vitest";

const hostCountry = checkout.invoiceBuyerSnapshotAddressSchema.shape.country.value;
const [, , embeddedProvider, interactiveProvider] = PAYMENT_EXECUTION_PROVIDERS;
const baseIntent = {
  version: intent.CONFIGURATOR_INTENT_VERSION, idempotencyKey: "example-intent-1", mode: "one_time",
  sizeConstraint: { kind: "unit_count", value: 14 },
  petProfile: { name: "Example", ageBand: "adult", breed: "mixed", weightKg: 10, activityLevel: "normal", bcs: "ideal" },
  contact: { firstName: "Buyer", lastName: "Example", email: "buyer@example.test", phone: "123456789" },
  address: { street: "Example 1", postalCode: "00000", city: "Example", country: hostCountry },
  selectedDelivery: { kind: "courier" }, selectedFlavorSlugs: ["item-a"],
  selectedVariants: [{ variantId: "variant-a", sku: "ITEM-A", flavorSlug: "item-a", qty: 14 }],
  consents: { gdpr: true, terms: true }, paymentMethodIntent: { method: "card" },
};
const cases: Array<[string, { safeParse(value: unknown): unknown }, unknown]> = [
  ["cart empty", contracts.createCartRequestSchema, {}],
  ["cart multiple errors", contracts.createCartRequestSchema, { lines: [{ sku: 0, quantity: 0 }], locale: "xx" }],
  ["intent empty", intent.configuratorIntentSchema, {}],
  ["intent nested empty", intent.configuratorIntentSchema, { ...baseIntent, sizeConstraint: {}, petProfile: {}, contact: {}, address: {}, selectedDelivery: {}, selectedVariants: [{}], consents: {}, paymentMethodIntent: {} }],
  ["intent invalid core and host fields", intent.configuratorIntentSchema, { ...baseIntent, cadencePolicyVersion: "unknown", idempotencyKey: "!", locale: "xx", mode: "unknown", cadenceDays: 0, promoCodes: [0], visitorId: 0, sizeConstraint: {}, contact: {}, selectedVariants: [{}] }],
  ["checkout empty", checkout.checkoutRequestSchema, {}],
  ["checkout multiple errors", checkout.checkoutRequestSchema, { intent: {}, paymentProvider: "unknown", paymentAttemptSequence: -1, paymentExecution: {}, declaredBankId: "!", returnContext: "unknown", invoicePreference: { kind: "unknown" }, expectedQuote: {} }],
  ["checkout quote multiple errors", checkout.checkoutRequestSchema, { intent: baseIntent, expectedQuote: { totalGross: {}, pricingPolicy: {}, promotionAcceptanceToken: 0 } }],
  ["invoice address empty", checkout.invoiceBuyerSnapshotAddressSchema, {}],
  ["invoice address multiple errors", checkout.invoiceBuyerSnapshotAddressSchema, { line1: 0, line2: 0, city: 0, postalCode: 0, country: "AA", source: 0 }],
  ["persistence request empty", persistence.configuratorIntentPersistenceRequestSchema, {}],
  ["persistence response empty", persistence.configuratorIntentPersistenceResponseSchema, {}],
  ["persistence response multiple errors", persistence.configuratorIntentPersistenceResponseSchema, { contractVersion: 0, intentVersion: 0, idempotencyKey: 0, clientId: 0, petId: 0, addressId: 0, clientMatchReason: 0, replayed: 0 }],
  ["resume draft empty", resume.checkoutResumeDraftStateSchema, {}],
  ["resume completion multiple errors", resume.checkoutResumeDraftStateSchema, { version: resume.CHECKOUT_RESUME_CONTRACT_VERSION, completion: { petProfile: 0, productSelection: 0, cadence: 0, account: 0, shipping: 0, billing: 0, payment: 0, review: 0 } }],
  ["resume request empty", resume.checkoutResumeUpsertRequestSchema, {}],
];

it.each(cases)("preserves BASE validation issues and order: %s", (name, schema, input) => {
  const result = schema.safeParse(input) as { success: boolean; data?: unknown; error?: { issues: unknown[] } };
  expect(projectHostVocabulary(result.success ? { success: true, data: result.data } : { success: false, issues: result.error?.issues }))
    .toEqual(golden[name]);
});

it("preserves string SKU inputs in the exported reference requests", () => {
  expectTypeOf<checkout.CheckoutRequest["intent"]["selectedVariants"][number]["sku"]>().toEqualTypeOf<string>();
  expectTypeOf<persistence.ConfiguratorIntentPersistenceRequest["selectedVariants"][number]["sku"]>().toEqualTypeOf<string>();
});

// Captured using git show d2cda7d5:<path>, never from the repaired schemas.
const golden: Record<string, unknown> = {
  "cart empty": { success: false, issues: [
    {"expected": "array", "code": "invalid_type", "path": ["lines"], "message": "Invalid input: expected array, received undefined"},
  ] },
  "cart multiple errors": { success: false, issues: [
    {"expected": "string", "code": "invalid_type", "path": ["lines", 0, "sku"], "message": "Invalid input: expected string, received number"},
    {"origin": "number", "code": "too_small", "minimum": 1, "inclusive": true, "path": ["lines", 0, "quantity"], "message": "Too small: expected number to be >=1"},
    {"code": "invalid_value", "values": ["pl", "en"], "path": ["locale"], "message": "Invalid option: expected one of \"pl\"|\"en\""},
  ] },
  "intent empty": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.configurator_intent.v1"], "path": ["version"], "message": "Invalid input: expected \"commerce.configurator_intent.v1\""},
    {"expected": "string", "code": "invalid_type", "path": ["idempotencyKey"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["one_time", "subscription"], "path": ["mode"], "message": "Invalid option: expected one of \"one_time\"|\"subscription\""},
    {"expected": "object", "code": "invalid_type", "path": ["sizeConstraint"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["petProfile"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["contact"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["address"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["selectedDelivery"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "array", "code": "invalid_type", "path": ["selectedFlavorSlugs"], "message": "Invalid input: expected array, received undefined"},
    {"expected": "array", "code": "invalid_type", "path": ["selectedVariants"], "message": "Invalid input: expected array, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["consents"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["paymentMethodIntent"], "message": "Invalid input: expected object, received undefined"},
  ] },
  "intent nested empty": { success: false, issues: [
    {"code": "invalid_value", "values": ["unit_count", "total_weight_g", "feeding_days"], "path": ["sizeConstraint", "kind"], "message": "Invalid option: expected one of \"unit_count\"|\"total_weight_g\"|\"feeding_days\""},
    {"expected": "number", "code": "invalid_type", "path": ["sizeConstraint", "value"], "message": "Invalid input: expected number, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["petProfile", "name"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["puppy", "young", "adult", "senior"], "path": ["petProfile", "ageBand"], "message": "Invalid option: expected one of \"puppy\"|\"young\"|\"adult\"|\"senior\""},
    {"expected": "string", "code": "invalid_type", "path": ["petProfile", "breed"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "number", "code": "invalid_type", "path": ["petProfile", "weightKg"], "message": "Invalid input: expected number, received undefined"},
    {"code": "invalid_value", "values": ["low", "normal", "high"], "path": ["petProfile", "activityLevel"], "message": "Invalid option: expected one of \"low\"|\"normal\"|\"high\""},
    {"code": "invalid_value", "values": ["thin", "ideal", "overweight"], "path": ["petProfile", "bcs"], "message": "Invalid option: expected one of \"thin\"|\"ideal\"|\"overweight\""},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "firstName"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "lastName"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "email"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "phone"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["address", "street"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["address", "postalCode"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["address", "city"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["<host-country>"], "path": ["address", "country"], "message": "Invalid input: expected \"<host-country>\""},
    {"code": "invalid_value", "values": ["parcel-locker", "courier"], "path": ["selectedDelivery", "kind"], "message": "Invalid option: expected one of \"parcel-locker\"|\"courier\""},
    {"expected": "string", "code": "invalid_type", "path": ["selectedVariants", 0, "variantId"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["selectedVariants", 0, "sku"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["selectedVariants", 0, "flavorSlug"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "number", "code": "invalid_type", "path": ["selectedVariants", 0, "qty"], "message": "Invalid input: expected number, received undefined"},
    {"code": "invalid_value", "values": [true], "path": ["consents", "gdpr"], "message": "Invalid input: expected true"},
    {"code": "invalid_value", "values": [true], "path": ["consents", "terms"], "message": "Invalid input: expected true"},
    {"code": "invalid_value", "values": ["blik", "card", "transfer"], "path": ["paymentMethodIntent", "method"], "message": "Invalid option: expected one of \"blik\"|\"card\"|\"transfer\""},
  ] },
  "intent invalid core and host fields": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.configurator_fixed_cadence_14_21_28.v1"], "path": ["cadencePolicyVersion"], "message": "Invalid input: expected \"commerce.configurator_fixed_cadence_14_21_28.v1\""},
    {"origin": "string", "code": "too_small", "minimum": 8, "inclusive": true, "path": ["idempotencyKey"], "message": "Too small: expected string to have >=8 characters"},
    {"origin": "string", "code": "invalid_format", "format": "regex", "pattern": "/^[a-zA-Z0-9._:-]+$/", "path": ["idempotencyKey"], "message": "Invalid string: must match pattern /^[a-zA-Z0-9._:-]+$/"},
    {"code": "invalid_value", "values": ["pl", "en"], "path": ["locale"], "message": "Invalid option: expected one of \"pl\"|\"en\""},
    {"code": "invalid_value", "values": ["one_time", "subscription"], "path": ["mode"], "message": "Invalid option: expected one of \"one_time\"|\"subscription\""},
    {"origin": "number", "code": "too_small", "minimum": 0, "inclusive": false, "path": ["cadenceDays"], "message": "Too small: expected number to be >0"},
    {"expected": "string", "code": "invalid_type", "path": ["promoCodes", 0], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["visitorId"], "message": "Invalid input: expected string, received number"},
    {"code": "invalid_value", "values": ["unit_count", "total_weight_g", "feeding_days"], "path": ["sizeConstraint", "kind"], "message": "Invalid option: expected one of \"unit_count\"|\"total_weight_g\"|\"feeding_days\""},
    {"expected": "number", "code": "invalid_type", "path": ["sizeConstraint", "value"], "message": "Invalid input: expected number, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "firstName"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "lastName"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "email"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["contact", "phone"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["selectedVariants", 0, "variantId"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["selectedVariants", 0, "sku"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["selectedVariants", 0, "flavorSlug"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "number", "code": "invalid_type", "path": ["selectedVariants", 0, "qty"], "message": "Invalid input: expected number, received undefined"},
  ] },
  "checkout empty": { success: false, issues: [
    {"expected": "object", "code": "invalid_type", "path": ["intent"], "message": "Invalid input: expected object, received undefined"},
  ] },
  "checkout multiple errors": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.configurator_intent.v1"], "path": ["intent", "version"], "message": "Invalid input: expected \"commerce.configurator_intent.v1\""},
    {"expected": "string", "code": "invalid_type", "path": ["intent", "idempotencyKey"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["one_time", "subscription"], "path": ["intent", "mode"], "message": "Invalid option: expected one of \"one_time\"|\"subscription\""},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "sizeConstraint"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "petProfile"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "contact"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "address"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "selectedDelivery"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "array", "code": "invalid_type", "path": ["intent", "selectedFlavorSlugs"], "message": "Invalid input: expected array, received undefined"},
    {"expected": "array", "code": "invalid_type", "path": ["intent", "selectedVariants"], "message": "Invalid input: expected array, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "consents"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["intent", "paymentMethodIntent"], "message": "Invalid input: expected object, received undefined"},
    {"code": "invalid_value", "values": ["hidden_rehearsal", "noop_payment", "<embedded-provider>", "<interactive-provider>"], "path": ["paymentProvider"], "message": "Invalid option: expected one of \"hidden_rehearsal\"|\"noop_payment\"|\"<embedded-provider>\"|\"<interactive-provider>\""},
    {"origin": "number", "code": "too_small", "minimum": 0, "inclusive": true, "path": ["paymentAttemptSequence"], "message": "Too small: expected number to be >=0"},
    {"code": "invalid_union", "errors": [[{"code": "invalid_value", "values": ["hidden_rehearsal"], "path": ["provider"], "message": "Invalid input: expected \"hidden_rehearsal\""}], [{"code": "invalid_value", "values": ["noop_payment"], "path": ["provider"], "message": "Invalid input: expected \"noop_payment\""}], [{"code": "invalid_value", "values": ["<interactive-provider>"], "path": ["provider"], "message": "Invalid input: expected \"<interactive-provider>\""}, {"code": "invalid_value", "values": ["blik_one_time"], "path": ["flow"], "message": "Invalid input: expected \"blik_one_time\""}, {"expected": "string", "code": "invalid_type", "path": ["blikToken"], "message": "Invalid input: expected string, received undefined"}], [{"code": "invalid_value", "values": ["<interactive-provider>"], "path": ["provider"], "message": "Invalid input: expected \"<interactive-provider>\""}, {"code": "invalid_value", "values": ["blik_one_click"], "path": ["flow"], "message": "Invalid input: expected \"blik_one_click\""}, {"expected": "string", "code": "invalid_type", "path": ["savedMethodId"], "message": "Invalid input: expected string, received undefined"}], [{"code": "invalid_value", "values": ["<interactive-provider>"], "path": ["provider"], "message": "Invalid input: expected \"<interactive-provider>\""}, {"code": "invalid_value", "values": ["pbl_one_time"], "path": ["flow"], "message": "Invalid input: expected \"pbl_one_time\""}, {"expected": "string", "code": "invalid_type", "path": ["channelId"], "message": "Invalid input: expected string, received undefined"}], [{"code": "invalid_value", "values": ["<interactive-provider>"], "path": ["provider"], "message": "Invalid input: expected \"<interactive-provider>\""}, {"code": "invalid_value", "values": ["blik_recurring_activation"], "path": ["flow"], "message": "Invalid input: expected \"blik_recurring_activation\""}, {"expected": "string", "code": "invalid_type", "path": ["blikToken"], "message": "Invalid input: expected string, received undefined"}], [{"code": "invalid_value", "values": ["<interactive-provider>"], "path": ["provider"], "message": "Invalid input: expected \"<interactive-provider>\""}, {"code": "invalid_value", "values": ["blik_recurring_saved"], "path": ["flow"], "message": "Invalid input: expected \"blik_recurring_saved\""}, {"expected": "string", "code": "invalid_type", "path": ["savedMethodId"], "message": "Invalid input: expected string, received undefined"}]], "path": ["paymentExecution"], "message": "Invalid input"},
    {"origin": "string", "code": "invalid_format", "format": "regex", "pattern": "/^[A-Za-z0-9_-]+$/", "path": ["declaredBankId"], "message": "Invalid string: must match pattern /^[A-Za-z0-9_-]+$/"},
    {"code": "invalid_value", "values": ["public", "account"], "path": ["returnContext"], "message": "Invalid option: expected one of \"public\"|\"account\""},
    {"code": "invalid_union", "errors": [], "note": "No matching discriminator", "discriminator": "kind", "options": ["b2c_named", "b2b_vat"], "path": ["invoicePreference", "kind"], "message": "Invalid discriminator value. Expected 'b2c_named' | 'b2b_vat'"},
    {"expected": "object", "code": "invalid_type", "path": ["expectedQuote", "totalGross"], "message": "Invalid input: expected object, received undefined"},
  ] },
  "checkout quote multiple errors": { success: false, issues: [
    {"expected": "number", "code": "invalid_type", "path": ["expectedQuote", "totalGross", "amountMinor"], "message": "Invalid input: expected number, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["expectedQuote", "totalGross", "currency"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["commerce.offer-policy.v1", "commerce.offer-policy.v2"], "path": ["expectedQuote", "pricingPolicy", "offerPolicyVersion"], "message": "Invalid option: expected one of \"commerce.offer-policy.v1\"|\"commerce.offer-policy.v2\""},
    {"code": "invalid_value", "values": ["promotion-engine.v1", "promotion-engine.v2"], "path": ["expectedQuote", "pricingPolicy", "promotionEngineVersion"], "message": "Invalid option: expected one of \"promotion-engine.v1\"|\"promotion-engine.v2\""},
    {"expected": "string", "code": "invalid_type", "path": ["expectedQuote", "promotionAcceptanceToken"], "message": "Invalid input: expected string, received number"},
  ] },
  "invoice address empty": { success: false, issues: [
    {"expected": "string", "code": "invalid_type", "path": ["line1"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["city"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["postalCode"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["<host-country>"], "path": ["country"], "message": "Invalid input: expected \"<host-country>\""},
    {"expected": "string", "code": "invalid_type", "path": ["source"], "message": "Invalid input: expected string, received undefined"},
  ] },
  "invoice address multiple errors": { success: false, issues: [
    {"expected": "string", "code": "invalid_type", "path": ["line1"], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["line2"], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["city"], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["postalCode"], "message": "Invalid input: expected string, received number"},
    {"code": "invalid_value", "values": ["<host-country>"], "path": ["country"], "message": "Invalid input: expected \"<host-country>\""},
    {"expected": "string", "code": "invalid_type", "path": ["source"], "message": "Invalid input: expected string, received number"},
  ] },
  "persistence request empty": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.configurator_intent.v1"], "path": ["version"], "message": "Invalid input: expected \"commerce.configurator_intent.v1\""},
    {"expected": "string", "code": "invalid_type", "path": ["idempotencyKey"], "message": "Invalid input: expected string, received undefined"},
    {"code": "invalid_value", "values": ["one_time", "subscription"], "path": ["mode"], "message": "Invalid option: expected one of \"one_time\"|\"subscription\""},
    {"expected": "object", "code": "invalid_type", "path": ["sizeConstraint"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["petProfile"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["contact"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["address"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["selectedDelivery"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "array", "code": "invalid_type", "path": ["selectedFlavorSlugs"], "message": "Invalid input: expected array, received undefined"},
    {"expected": "array", "code": "invalid_type", "path": ["selectedVariants"], "message": "Invalid input: expected array, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["consents"], "message": "Invalid input: expected object, received undefined"},
    {"expected": "object", "code": "invalid_type", "path": ["paymentMethodIntent"], "message": "Invalid input: expected object, received undefined"},
  ] },
  "persistence response empty": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.configurator_intent_persistence.v1"], "path": ["contractVersion"], "message": "Invalid input: expected \"commerce.configurator_intent_persistence.v1\""},
    {"code": "invalid_value", "values": ["commerce.configurator_intent.v1"], "path": ["intentVersion"], "message": "Invalid input: expected \"commerce.configurator_intent.v1\""},
    {"expected": "string", "code": "invalid_type", "path": ["idempotencyKey"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["clientId"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["petId"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "string", "code": "invalid_type", "path": ["addressId"], "message": "Invalid input: expected string, received undefined"},
    {"expected": "boolean", "code": "invalid_type", "path": ["replayed"], "message": "Invalid input: expected boolean, received undefined"},
  ] },
  "persistence response multiple errors": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.configurator_intent_persistence.v1"], "path": ["contractVersion"], "message": "Invalid input: expected \"commerce.configurator_intent_persistence.v1\""},
    {"code": "invalid_value", "values": ["commerce.configurator_intent.v1"], "path": ["intentVersion"], "message": "Invalid input: expected \"commerce.configurator_intent.v1\""},
    {"expected": "string", "code": "invalid_type", "path": ["idempotencyKey"], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["clientId"], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["petId"], "message": "Invalid input: expected string, received number"},
    {"expected": "string", "code": "invalid_type", "path": ["addressId"], "message": "Invalid input: expected string, received number"},
    {"code": "invalid_value", "values": ["client_created", "client_match_exact_email", "client_match_plus_normalized_fallback"], "path": ["clientMatchReason"], "message": "Invalid option: expected one of \"client_created\"|\"client_match_exact_email\"|\"client_match_plus_normalized_fallback\""},
    {"expected": "boolean", "code": "invalid_type", "path": ["replayed"], "message": "Invalid input: expected boolean, received number"},
  ] },
  "resume draft empty": { success: false, issues: [
    {"code": "invalid_value", "values": ["commerce.checkout_resume.v1"], "path": ["version"], "message": "Invalid input: expected \"commerce.checkout_resume.v1\""},
  ] },
  "resume completion multiple errors": { success: false, issues: [
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "petProfile"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "productSelection"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "cadence"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "account"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "shipping"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "billing"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "payment"], "message": "Invalid input: expected boolean, received number"},
    {"expected": "boolean", "code": "invalid_type", "path": ["completion", "review"], "message": "Invalid input: expected boolean, received number"},
  ] },
  "resume request empty": { success: false, issues: [
    {"code": "invalid_value", "values": ["start", "pet_profile", "product_selection", "cadence", "account", "shipping", "billing", "payment", "review"], "path": ["lastSectionId"], "message": "Invalid option: expected one of \"start\"|\"pet_profile\"|\"product_selection\"|\"cadence\"|\"account\"|\"shipping\"|\"billing\"|\"payment\"|\"review\""},
    {"expected": "object", "code": "invalid_type", "path": ["draftState"], "message": "Invalid input: expected object, received undefined"},
  ] },
};

function projectHostVocabulary(value: unknown): unknown {
  if (typeof value === "string") return value.split(hostCountry).join("<host-country>")
    .replace(new RegExp(embeddedProvider, "gi"), "<embedded-provider>")
    .replace(new RegExp(interactiveProvider, "gi"), "<interactive-provider>");
  if (Array.isArray(value)) return value.map(projectHostVocabulary);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, nested]) => [key, projectHostVocabulary(nested)]));
  return value;
}

// BASE d2cda7d5: every exported schema in the K1 reference binding files,
// including nested invalid fields, all root-field pairs, rotations and reversals.
// Goldens hash complete ordered issues and parsed outputs, not just issue sets.
const auditFixtures: Array<[string, unknown[], number, string]> = [
  ["outbox.commerceOrderDraftCreatedEventSchema",[{"contractVersion":0,"id":0,"createdAt":0,"availableAt":0,"processedAt":0,"aggregateType":0,"aggregateId":0,"eventType":0,"idempotencyKey":0,"status":0,"attempts":"invalid","payload":{"orderId":0,"orderUuid":0,"quoteSnapshot":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}},"orderDraftSnapshot":{"contractVersion":0,"source":0,"status":0,"paymentStatus":0,"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"totals":{"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}},"error":0,"metadata":{"example":0}}],217,"4e5cdd0bf5df8e4e93a878c064a870ab91a969fce368d691f113b210ebd8d021"],
  ["outbox.commerceOrderDraftCreatedOutboxRecordSchema",[{"id":0,"created_at":0,"available_at":0,"processed_at":0,"aggregate_type":0,"aggregate_id":0,"event_type":0,"idempotency_key":0,"status":0,"attempts":"invalid","payload":{"orderId":0,"orderUuid":0,"quoteSnapshot":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}},"orderDraftSnapshot":{"contractVersion":0,"source":0,"status":0,"paymentStatus":0,"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"totals":{"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}},"error":0,"metadata":{"example":0}}],189,"096f6e1468d75e16fac538d809501b4fd1edb469f99575abd0da931c2cba6f83"],
  ["outbox.commerceOrderDraftCreatedPayloadSchema",[{"orderId":0,"orderUuid":0,"quoteSnapshot":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}},"orderDraftSnapshot":{"contractVersion":0,"source":0,"status":0,"paymentStatus":0,"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"totals":{"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}}],27,"5d1d9b4c76f6d9998a2dfb307969096b77c086a8634860ead9b79478f9a8bc89"],
  ["outbox.commerceOrderPaidOutboxRecordSchema",[{"id":0,"created_at":0,"available_at":0,"processed_at":0,"aggregate_type":0,"aggregate_id":0,"event_type":0,"idempotency_key":0,"status":0,"attempts":"invalid","payload":{"orderId":0,"orderUuid":0,"mode":0,"occurredAt":0},"error":0,"metadata":{"example":0}}],189,"0e11d20a707b447473c66e7da8ca3f5c9f4b8bb0db8edeaaf511361bd1df5480"],
  ["outbox.commerceOrderPaidPayloadSchema",[{"orderId":0,"orderUuid":0,"mode":0,"occurredAt":0}],27,"3e2af480aeb0e5a2afede9787ac1a864012be3c8a9d08988b8672f64f0729ae9"],
  ["outbox.commerceOrderReviewRequestPayloadSchema",[{"orderId":0,"orderUuid":0,"token":0}],19,"f29edce2093895723daa3e6a9e65ab47adcfa269f9d8069fc76a608f0deeec0b"],
  ["outbox.commerceProductBackInStockPayloadSchema",[{"sku":0,"email":0}],13,"1864ec7512f1e5ccc47a5967a8fc99e4468c56db7c4a4b838020382289fe45c8"],
  ["availability.commerceOfferAvailabilityRequestItemSchema", [{"sku":0,"productSlug":0,"variantId":0,"requestedQuantity":"invalid","checkoutMode":0}], 37, "fe58e880b4d3f654018a9a2a725ef117be1f36e5e45cedc13a0da21998843f6a"],
  ["availability.commerceOfferAvailabilitySchema", [{"sku":0,"productSlug":0,"variantId":0,"status":0,"visibleInConfigurator":0,"sellableNow":"invalid","reasonCode":0,"source":0}], 79, "8d81a5e2e85108919f9c97747ef5241bb48a80950ea87491368b1af4a7b37540"],
  ["availability.commerceOfferAvailabilitySourceSchema", [0], 7, "2e74f5d2746b2c811c5c8bb92ea6fcc8568f41b1febe7610346ea306e361b30a"],
  ["availability.commerceOfferAvailabilityStatusSchema", [0], 7, "4cec2739d15f248326138e3fbb73846146fa4a6dc2ee2c644a628759503576ce"],
  ["checkout.asyncCheckoutStatusSchema", [0], 7, "2e09cd1aa8d8cf141f83211e256b6fc236e9d0219842b5906c5dd0557bb44c07"],
  ["checkout.checkoutActivationStatusSchema", [0], 7, "ee2c1bf1f400466f308eb91e62bee8967094e83f69793e6bccb7a09abdc4efbe"],
  ["checkout.checkoutClientActionSchema", [{"kind":"none"},{"kind":"redirect","url":0},{"kind":"provider_embedded","provider":0,"clientSecret":0,"sessionRef":0},{"kind":"blik_code_prompt","provider":0}], 62, "517fcf7ed19151604e49bd851c28a057001363301d5f4afd5489e1e633a22d98"],
  ["checkout.checkoutInvoicePreferenceSchema", [{"kind":"b2c_named"},{"kind":"b2b_vat","companyName":0,"taxId":0,"address":{"line1":0,"line2":0,"city":0,"postalCode":0,"country":0},"email":0,"contactName":0}], 58, "3912071858527d913388380d07a49ba822681815957d5fd3f364911108ccda1b"],
  ["checkout.checkoutKindSchema", [0], 7, "760c5ff97ef7f25f432b6d8b2e5a29cc7a96de239e402cb5e498015a6129bae9"],
  ["checkout.checkoutRequestSchema", [{"intent":{"version":0,"cadencePolicyVersion":0,"idempotencyKey":0,"locale":0,"mode":0,"cadenceDays":"invalid","promoCodes":[0],"visitorId":0,"sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"petProfile":{"petId":0,"name":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"contact":{"firstName":0,"lastName":0,"email":0,"phone":0},"address":{"street":0,"postalCode":0,"city":0,"country":0},"selectedDelivery":{"kind":0,"deliveryKind":0,"providerKind":0,"providerRef":0,"carrierKind":0,"carrierCode":0,"service":0,"serviceCode":0,"pickupPoint":{"id":0,"provider":0,"name":0,"address":{"line1":0,"postalCode":0,"city":0,"country":0}}},"selectedFlavorSlugs":[0],"selectedVariants":[{"variantId":0,"sku":0,"flavorSlug":0,"qty":"invalid"}],"recommendationSnapshot":{"version":0,"status":0,"reasonCodes":[0],"energy":{"policyVersion":0,"source":0,"ageBand":0,"activityLevel":0,"bcs":0,"kcalPerKgBodyWeight075":"invalid","dailyKcal":"invalid","dailyGrams":"invalid"},"dailyKcal":"invalid","dailyGrams":"invalid","totalWeightG":"invalid","feedingDays":"invalid","desiredSizeKind":0,"cadenceDays":"invalid","lines":[{"variantId":0,"sku":0,"slug":0,"qty":"invalid","netWeightG":"invalid","kcalPerUnit":"invalid","allergenSlugs":[0],"purchaseAvailability":0,"sellableNow":"invalid"}],"allergenConflicts":[{"variantId":0,"sku":0,"allergenSlugs":[0]}],"excludedProducts":[{"variantId":0,"sku":0,"allergenSlugs":[0],"slug":0,"reason":0}],"suggestedVariants":[{"variantId":0,"sku":0,"slug":0,"purchaseAvailability":0,"sellableNow":"invalid"}],"allergenOverrideRecorded":0},"starterOffer":{"capability":0,"intervalDays":"invalid","delivery2DiscountBps":"invalid","steady":{"cadenceDays":0,"cans":"invalid"}},"consents":{"gdpr":0,"marketing":0,"terms":0},"paymentMethodIntent":{"method":0,"saveForSubscription":0},"consciousAllergenOverride":0},"paymentProvider":0,"paymentAttemptSequence":"invalid","paymentExecution":{"provider":0},"declaredBankId":0,"returnContext":0,"invoicePreference":{"kind":"b2c_named"},"expectedQuote":{"totalGross":{"amountMinor":"invalid","currency":0},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"promotionAcceptanceToken":0}}], 79, "a0921da2ddeaf9c3828b982af35f15ce47df720dfb5322a14f3411f39205b128"],
  ["checkout.checkoutResponseSchema", [{"contractVersion":0,"checkoutKind":0,"orderRef":0,"orderId":0,"status":0,"paymentIntentId":0,"paymentAttemptId":0,"providerPaymentId":0,"clientId":0,"clientAction":{"kind":"none"},"returnUrl":0,"statusUrl":0,"subscription":{"requested":0,"cadenceDays":"invalid","activationStatus":0},"payment":{"requiresReusablePaymentMethod":0},"authoritativeQuote":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}},{"contractVersion":0,"checkoutKind":0,"status":"price_changed","priceChanged":0,"expectedQuote":{"totalGross":{"amountMinor":"invalid","currency":0},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0}},"authoritativeQuote":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}}], 296, "5d605d1176c1987f957a1c8e3883df0789b50b9a5d05407498f49786f4f54ff3"],
  ["checkout.invoiceBuyerSnapshotAddressSchema", [{"line1":0,"line2":0,"city":0,"postalCode":0,"country":0,"source":0}], 49, "b8406868512773ff0cf6367180b8c91bafacddc6310445b5fdb2a2570ca4c9c1"],
  ["checkout.invoiceBuyerSnapshotSchema", [{"name":0,"email":0,"taxId":0,"companyName":0,"source":0,"address":{"line1":0,"line2":0,"city":0,"postalCode":0,"country":0,"source":0}}], 49, "b92a8501bd2ff3e07adfac8c92c6fed4c60ceae5be4f628dc4ac9c87ff3cc6af"],
  ["checkout.paymentStatusRequestSchema", [{"orderId":0,"paymentIntentId":0,"clientId":0}], 19, "887ccffda4ea675cf3e8d210912a24255d102801710480c0fe9a6267a3a18e1e"],
  ["checkout.paymentStatusResponseSchema", [{"contractVersion":0,"orderId":0,"paymentIntentId":0,"status":0,"orderStatus":0,"payment":{"intentStatus":0,"attemptStatus":0,"paymentAttemptId":0,"provider":0,"providerPaymentId":0,"updatedAt":0},"failureReason":0,"failureDisplay":0,"subscriptionActivation":{"status":0,"subscriptionId":0},"nextAction":{"kind":"none"}}], 117, "53f1a288e8daf744a6ab4c66b8cd53fb404261fa1d2b0a0da9b8b6f968726403"],
  ["checkout.subscriptionActivationStatusSchema", [0], 7, "731c929b956ed2b570b54f7960035119a8d82bc836264d73a570021b4c9d1717"],
  ["contracts.cartDraftSchema", [{"id":0,"status":0,"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}],"currency":0}], 27, "374a7a68b0a15dacd6e127712a25caf5945d7a5e8d744f11aa9a7b964d410f33"],
  ["contracts.cartLineInputSchema", [{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}], 37, "dbf556f6198e3d51fbcb3db292c1ea7cac7021ed967b0cdc805b973da07a3fd1"],
  ["contracts.cartStatusSchema", [0], 7, "7dd6bbd209653c60ac7f501c8f971f5b8b06faf19b51a0c7e28d1babecb36767"],
  ["contracts.checkoutStatusSchema", [0], 7, "d18d510f9b269ebeacd9e42ad6cb5427b2fef111dd07c436ef4673ee16ae9063"],
  ["contracts.commerceCurrencySchema", [0], 7, "1a88fb3f401bcdb791664c86d0541eecb5bd08dc0af51a10b72295e9fe8215aa"],
  ["contracts.commerceIdempotencyKeySchema", [0], 7, "7cc905098eb20876cc470cc87650e97ebe8d8d286ab618c3106b1ce9751e1e63"],
  ["contracts.commerceMoneySchema", [{"amountMinor":"invalid","currency":0}], 13, "5c9bf12b23b412850e41a8049b13e8c5919ae10d659020b78928b4d99f733f3f"],
  ["contracts.commerceProductSlugSchema", [0], 7, "6b87673e5186ec2677a591318965a345efab15076e895b7cfd1ffba2e2d7cff8"],
  ["contracts.commerceQuoteSchema", [{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}], 247, "7910bb5436e1c9b903bab7595995a89cb5612608a69b038b41aa288f7e089f65"],
  ["contracts.commerceSkuSchema", [0], 7, "a46294ee882b006ff7ef3a91ffb776901f47ec0da2f83c44bfc306a4a48dfebe"],
  ["contracts.commerceTaxBreakdownSchema", [{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}}], 79, "fe1682bd8247f044c2ad0bc7aaaa8309614d19101e0db7ee7221b6525de3e634"],
  ["contracts.commerceTaxCategorySchema", [0], 7, "d6ba3a4c67831df4bbb490094e37677d1483426785dead38e9df111952c3f68b"],
  ["contracts.commerceTaxCountrySchema", [0], 7, "898f86763561953c87f68cc8b01d05458df14078ed31fa5efcd93f4901850b86"],
  ["contracts.commerceTaxLegalBasisSchema", [0], 7, "2e74f5d2746b2c811c5c8bb92ea6fcc8568f41b1febe7610346ea306e361b30a"],
  ["contracts.createCartRequestSchema", [{"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}],"locale":0,"clientId":0}], 19, "dce473dd2d63c0e5df242f0cda1ef84da89c49805468b2ac28ef0fa4d7a8b643"],
  ["contracts.createCartResponseSchema", [{"contractVersion":0,"cart":{"id":0,"status":0,"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}],"currency":0}}], 13, "4f8885fd0eb1487ff83ea12f64e414866dea87264f5807347c6077609f22fec3"],
  ["contracts.createCheckoutRequestSchema", [{"cartId":0,"successUrl":0,"cancelUrl":0,"idempotencyKey":0}], 27, "c88f79cd1d6db9c835aed74e18cdc5b0054133e33c123c9caceb88245a04ae3f"],
  ["contracts.createCheckoutResponseSchema", [{"contractVersion":0,"checkout":{"id":0,"cartId":0,"status":0,"redirectUrl":0,"paymentProviderSessionId":0}}], 13, "66942a1dd438e5150f9d5e8445d82948a90b17e781affa1292abaa17b908d34b"],
  ["contracts.createOrderDraftRequestSchema", [{"idempotencyKey":0,"quoteSnapshot":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}}], 13, "a759ec14023e9447dcf39a6b656923c760a3f53d503f4dabe1ef58248a043048"],
  ["contracts.createOrderDraftResponseSchema", [{"contractVersion":0,"orderDraft":{"orderId":0,"status":0,"paymentStatus":0,"idempotencyKey":0,"quoteSnapshot":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}},"replayed":0}}], 13, "bf1a12df53d46ee56cc43ab1943b168b9c0fdee14111619b2b39cda5bfe25915"],
  ["contracts.createQuoteBatchRequestSchema", [{"quotes":[{"mode":0,"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}],"sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"cadenceDays":"invalid","promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"locale":0,"visitorId":0,"customerEligibilityContext":{"email":0,"contactEmail":0,"visitorId":0},"pricingPolicy":{"capability":0,"token":0}}]}], 9, "73adc34950e95d49e557eb160a243dcdaabf17c6dc34f0644bf0776c1f6f6279"],
  ["contracts.createQuoteBatchResponseSchema", [{"contractVersion":0,"quotes":[{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}]}], 13, "36140263f5bbd23d9e44f7e8c67bb0ab59e823e8a36f39e3e95e6410631ab2be"],
  ["contracts.createQuoteRequestSchema", [{"mode":0,"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}],"sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"cadenceDays":"invalid","promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"locale":0,"visitorId":0,"customerEligibilityContext":{"email":0,"contactEmail":0,"visitorId":0},"pricingPolicy":{"capability":0,"token":0}}], 139, "7ece74af8efc10874e0deaa6a27ec85fe94b35ccdb82eb51469ddc4bbe42c123"],
  ["contracts.createQuoteResponseSchema", [{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}}], 13, "234564885853904ef4491d4788a92cea7631ccd32f0a7f26c2343529f1bac5d3"],
  ["contracts.orderDraftStatusSchema", [0], 7, "7dd6bbd209653c60ac7f501c8f971f5b8b06faf19b51a0c7e28d1babecb36767"],
  ["contracts.orderDraftSummarySchema", [{"orderId":0,"status":0,"paymentStatus":0,"idempotencyKey":0,"quoteSnapshot":{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}},"replayed":0}], 49, "5625db364f01056d4aacf3cac353cac6dd7523a3ad309c108de935b34c344c0c"],
  ["contracts.orderReadResponseSchema", [{"contractVersion":0,"order":{"id":0,"status":0,"paymentStatus":0,"total":{"amountMinor":"invalid","currency":0},"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}]}}], 13, "a611ac9b6a345bec02acc0543066a6374ea7792e71d62c6ac16204bb7d7155fe"],
  ["contracts.orderStatusSchema", [0], 7, "ff307407ab622e224687804604723af9a748bef1433904fd94c55f784f047d01"],
  ["contracts.orderSummarySchema", [{"id":0,"status":0,"paymentStatus":0,"total":{"amountMinor":"invalid","currency":0},"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}]}], 37, "35795a4bd6ed857c9e67af531cde1a5fc7d25e2ce6ca08b776d6b04df39e874f"],
  ["contracts.paymentStatusReadResponseSchema", [{"contractVersion":0,"payment":{"id":0,"orderId":0,"status":0,"amount":{"amountMinor":"invalid","currency":0},"providerReference":0}}], 13, "e86758cdd373079d3aefb15264d936fcd6eb1851b86dcfbaa2a0970bd8e6dd7e"],
  ["contracts.paymentStatusSchema", [0], 7, "c5eb205821600473888e49e1b5018a14f32449ac810fe297353f8417475f1ef6"],
  ["contracts.paymentSummarySchema", [{"id":0,"orderId":0,"status":0,"amount":{"amountMinor":"invalid","currency":0},"providerReference":0}], 37, "aadae2dd470ffeae2f2496ce64aee6e496eb1ba0599292012b09431c6a9d97f6"],
  ["contracts.publicCreateQuoteBatchResponseSchema", [{"contractVersion":0,"quotes":[{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}}]}], 13, "36140263f5bbd23d9e44f7e8c67bb0ab59e823e8a36f39e3e95e6410631ab2be"],
  ["contracts.publicCreateQuoteRequestSchema", [{"mode":0,"lines":[{"sku":0,"quantity":"invalid","variantId":0,"modeAtLine":0,"isAddon":0}],"sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"cadenceDays":"invalid","promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"locale":0,"visitorId":0,"customerEligibilityContext":{"email":0,"contactEmail":0,"visitorId":0},"pricingPolicy":{"capability":0,"token":0},"promotionAcceptanceToken":0}], 163, "b4dc0b1e151fe022de171061a3c2f895082d7eb44a1a8fc6cced3d5cac5ae18a"],
  ["contracts.publicCreateQuoteResponseSchema", [{"contractVersion":0,"quote":{"currency":0,"taxIncluded":0,"lines":[{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}],"discounts":[{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}],"codeRejections":[{"code":0,"reason":0}],"codeRejectionDetails":[{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]}],"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"context":{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}},"subtotalGross":{"amountMinor":"invalid","currency":0},"discountTotalGross":{"amountMinor":"invalid","currency":0},"shippingGross":{"amountMinor":"invalid","currency":0},"shippingDiscountGross":{"amountMinor":"invalid","currency":0},"totalGross":{"amountMinor":"invalid","currency":0},"netTotal":{"amountMinor":"invalid","currency":0},"taxTotal":{"amountMinor":"invalid","currency":0}},"promotionAcceptanceToken":0}], 19, "05c9917803dea88ca5ec364e9e45e62aa6be025c59fc3f2a980e77a143e059ad"],
  ["contracts.quoteCodeRejectionDetailSchema", [{"code":0,"reason":"scope_not_applicable","allowedScopes":[0]},{"code":0,"reason":"minimum_not_met","minimumReferenceMinor":"invalid"},{"code":0,"reason":"not_yet_active","validFrom":0},{"code":0,"reason":"global_limit_reached"}], 70, "631dc9337cdd93d33b9fdf3b3575fc54865015bec486b1d1f120d63c7eea4ce3"],
  ["contracts.quoteContextSchema", [{"mode":0,"cadenceDays":"invalid","feedingCoverageDays":"invalid","sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"promoCodes":[0],"petId":0,"petProfileContext":{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"pricingPolicy":{"offerPolicyVersion":0,"promotionEngineVersion":0,"pricingPolicyToken":0},"starterPack":{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}}], 97, "3bb4eddeb6d69026ea783b574faf61e445cc55a0dd47717a8dea9c848f3cdd66"],
  ["contracts.quoteCustomerEligibilityContextSchema", [{"email":0,"contactEmail":0,"visitorId":0}], 19, "43b5ee60bd3fc360f53d9ece2e9325f954752e304658ed360f075ffdb218ebdb"],
  ["contracts.quoteDiscountSchema", [{"promotionId":0,"code":0,"label":0,"appliesTo":0,"amountOffMinor":"invalid","reasonCode":0,"customerSemantic":0,"promotionEngineVersion":0,"promotionCodeId":0,"promotionCodeRevision":"invalid","promotionDefinitionFingerprint":0,"promotionCodeScopes":[0],"promotionMinimumReferenceMinor":"invalid","promotionCodeValidTo":0,"promotionBenefitKind":0,"promotionBenefitValueBps":"invalid","promotionBenefitValueMinor":"invalid","floorApplied":0}], 349, "b821e503b71ef7bab8e7c8c5164d0921e1fc34a4251c5710ed638d99ea436970"],
  ["contracts.quoteLineSchema", [{"sku":0,"productSlug":0,"quantity":"invalid","unitPriceGross":{"amountMinor":"invalid","currency":0},"lineSubtotalGross":{"amountMinor":"invalid","currency":0},"tax":{"included":0,"country":0,"category":0,"vatRateBps":"invalid","legalBasis":0,"netAmount":{"amountMinor":"invalid","currency":0},"vatAmount":{"amountMinor":"invalid","currency":0},"grossAmount":{"amountMinor":"invalid","currency":0}},"pricingComponents":[{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}],"catalogFacts":{"version":0,"resolvedPriceEntryId":0,"mode":0,"skuId":0,"documentRevisionId":0,"documentDigest":0,"basePriceEntryId":0,"atTime":0,"currency":0,"resolvedUnitAmountMinor":"invalid","resolvedLineAmountMinor":"invalid","baseUnitAmountMinor":"invalid"}}], 79, "010e78a6781c368dc8d7a6931960aaf856f0df68568ee7575425664ad8876619"],
  ["contracts.quotePetProfileContextSchema", [{"petId":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"}], 79, "6ad96bc7d1b7341cdf5c27040a52e4a663e16ea5567f399abe9fcd61a33862bf"],
  ["contracts.quotePricingComponentSchema", [{"scope":0,"componentType":0,"amountMinor":"invalid","reasonCode":0,"reasonPayload":{"example":0}}], 37, "8d035c39591bf29fe995902cd70944b376286cf7ed9448d670f6d805447760ef"],
  ["contracts.quoteSizeConstraintSchema", [{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"}], 27, "f871a10f18b1a4bb4f58830ae615621f2d8f2077eb6baad8022f801b0acf0bd8"],
  ["contracts.starterPackPlanSchema", [{"schemaVersion":0,"starterIntervalDays":"invalid","basisTemplateVersion":"invalid","delivery2":{"discountBps":"invalid","discountMinor":"invalid","basisSubtotalMinor":"invalid"},"graduation":{"cadenceDays":0,"sizeConstraint":{"example":0},"lines":[{"sku":0,"qty":"invalid","sortOrder":"invalid","isAddon":0,"quoteLine":{"example":0}}]}}], 37, "9ba79ebb77565e3a97871faf8c00aa2e30dc523de88c8a092b7d06093e47531f"],
  ["defaults.commerceCustomerDefaultsRedactedFieldSchema", [0], 7, "7144993705b4276d96d3965131001455342ab20756fb091d9d7ac88d86d0429a"],
  ["defaults.commerceCustomerDefaultsSnapshotSchema", [{"version":0,"clientId":0,"payment":{"available":0,"scope":0,"methodKind":0,"source":0,"applied":0},"addresses":{"hasDefaultShippingAddress":0,"defaultShippingAddressId":0,"hasDefaultBillingAddress":0,"defaultBillingAddressId":0,"hasDefaultOrdererProfile":0,"defaultOrdererProfileId":0,"hasDeliveryNotes":0,"hasCourierInstructions":0,"source":0,"applied":0},"redactedFields":[0]}], 37, "81ebebe53583ab0d21bad6c494299f8413673ac2e1ed6fdaa688ac706939f52b"],
  ["intent.configuratorActivityLevelSchema", [0], 7, "e3ace2ac322415f680cff1fddcf407acfb65863adc1ff3bb5bfe9a3a99905922"],
  ["intent.configuratorAllergenSlugSchema", [0], 7, "6b87673e5186ec2677a591318965a345efab15076e895b7cfd1ffba2e2d7cff8"],
  ["intent.configuratorBcsSchema", [0], 7, "d027b09969337f636f77d0c696d887a97973331adbcfd0220790d061f81d08a5"],
  ["intent.configuratorCadenceDaysSchema", [0,0,0], 21, "b7321b3a9e8610ef23261866c3e0e368eed9cf74b431b8aaa150ce718bab6dd7"],
  ["intent.configuratorDeliveryKindSchema", [0], 7, "753b823be7736326665f3773456241bacb93dc70fe05e58c0f5f461d940be8de"],
  ["intent.configuratorIntentSchema", [{"version":0,"cadencePolicyVersion":0,"idempotencyKey":0,"locale":0,"mode":0,"cadenceDays":"invalid","promoCodes":[0],"visitorId":0,"sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"petProfile":{"petId":0,"name":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"contact":{"firstName":0,"lastName":0,"email":0,"phone":0},"address":{"street":0,"postalCode":0,"city":0,"country":0},"selectedDelivery":{"kind":0,"deliveryKind":0,"providerKind":0,"providerRef":0,"carrierKind":0,"carrierCode":0,"service":0,"serviceCode":0,"pickupPoint":{"id":0,"provider":0,"name":0,"address":{"line1":0,"postalCode":0,"city":0,"country":0}}},"selectedFlavorSlugs":[0],"selectedVariants":[{"variantId":0,"sku":0,"flavorSlug":0,"qty":"invalid"}],"recommendationSnapshot":{"version":0,"status":0,"reasonCodes":[0],"energy":{"policyVersion":0,"source":0,"ageBand":0,"activityLevel":0,"bcs":0,"kcalPerKgBodyWeight075":"invalid","dailyKcal":"invalid","dailyGrams":"invalid"},"dailyKcal":"invalid","dailyGrams":"invalid","totalWeightG":"invalid","feedingDays":"invalid","desiredSizeKind":0,"cadenceDays":"invalid","lines":[{"variantId":0,"sku":0,"slug":0,"qty":"invalid","netWeightG":"invalid","kcalPerUnit":"invalid","allergenSlugs":[0],"purchaseAvailability":0,"sellableNow":"invalid"}],"allergenConflicts":[{"variantId":0,"sku":0,"allergenSlugs":[0]}],"excludedProducts":[{"variantId":0,"sku":0,"allergenSlugs":[0],"slug":0,"reason":0}],"suggestedVariants":[{"variantId":0,"sku":0,"slug":0,"purchaseAvailability":0,"sellableNow":"invalid"}],"allergenOverrideRecorded":0},"starterOffer":{"capability":0,"intervalDays":"invalid","delivery2DiscountBps":"invalid","steady":{"cadenceDays":0,"cans":"invalid"}},"consents":{"gdpr":0,"marketing":0,"terms":0},"paymentMethodIntent":{"method":0,"saveForSubscription":0},"consciousAllergenOverride":0}], 427, "876e72f49c4a4dd4ef84d321a0404d770a708ace3fdbf889f17461a3acb5c290"],
  ["intent.configuratorModeSchema", [0], 7, "355bbde7fd8549c69965f4467d4cb6b1999829c3d9469d07c3f18800a460102c"],
  ["intent.configuratorPaymentMethodSchema", [0], 7, "9680aaf7cd7558d3c6f39a7bdb440cff5068aff3e678b3f3918d48a28b26ed46"],
  ["intent.configuratorPetAgeBandSchema", [0], 7, "211522160ba1fadc279f9e442da2f24fa0f948b92592e45a9c05e2803ff7a25d"],
  ["intent.configuratorSizeConstraintSchema", [{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"}], 27, "f871a10f18b1a4bb4f58830ae615621f2d8f2077eb6baad8022f801b0acf0bd8"],
  ["persistence.configuratorIntentClientMatchReasonSchema", [0], 7, "deb7e87632efbda6ba916fc1dd53b1e267a9eaed8a3142577b34839036f456f5"],
  ["persistence.configuratorIntentPersistenceRequestSchema", [{"version":0,"cadencePolicyVersion":0,"idempotencyKey":0,"locale":0,"mode":0,"cadenceDays":"invalid","promoCodes":[0],"visitorId":0,"sizeConstraint":{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"},"petProfile":{"petId":0,"name":0,"ageBand":0,"breed":0,"weightKg":"invalid","activityLevel":0,"bcs":0,"allergenSlugs":[0],"dailyKcalOverride":"invalid"},"contact":{"firstName":0,"lastName":0,"email":0,"phone":0},"address":{"street":0,"postalCode":0,"city":0,"country":0},"selectedDelivery":{"kind":0,"deliveryKind":0,"providerKind":0,"providerRef":0,"carrierKind":0,"carrierCode":0,"service":0,"serviceCode":0,"pickupPoint":{"id":0,"provider":0,"name":0,"address":{"line1":0,"postalCode":0,"city":0,"country":0}}},"selectedFlavorSlugs":[0],"selectedVariants":[{"variantId":0,"sku":0,"flavorSlug":0,"qty":"invalid"}],"recommendationSnapshot":{"version":0,"status":0,"reasonCodes":[0],"energy":{"policyVersion":0,"source":0,"ageBand":0,"activityLevel":0,"bcs":0,"kcalPerKgBodyWeight075":"invalid","dailyKcal":"invalid","dailyGrams":"invalid"},"dailyKcal":"invalid","dailyGrams":"invalid","totalWeightG":"invalid","feedingDays":"invalid","desiredSizeKind":0,"cadenceDays":"invalid","lines":[{"variantId":0,"sku":0,"slug":0,"qty":"invalid","netWeightG":"invalid","kcalPerUnit":"invalid","allergenSlugs":[0],"purchaseAvailability":0,"sellableNow":"invalid"}],"allergenConflicts":[{"variantId":0,"sku":0,"allergenSlugs":[0]}],"excludedProducts":[{"variantId":0,"sku":0,"allergenSlugs":[0],"slug":0,"reason":0}],"suggestedVariants":[{"variantId":0,"sku":0,"slug":0,"purchaseAvailability":0,"sellableNow":"invalid"}],"allergenOverrideRecorded":0},"starterOffer":{"capability":0,"intervalDays":"invalid","delivery2DiscountBps":"invalid","steady":{"cadenceDays":0,"cans":"invalid"}},"consents":{"gdpr":0,"marketing":0,"terms":0},"paymentMethodIntent":{"method":0,"saveForSubscription":0},"consciousAllergenOverride":0}], 427, "876e72f49c4a4dd4ef84d321a0404d770a708ace3fdbf889f17461a3acb5c290"],
  ["persistence.configuratorIntentPersistenceResponseSchema", [{"contractVersion":0,"intentVersion":0,"idempotencyKey":0,"clientId":0,"petId":0,"addressId":0,"clientMatchReason":0,"replayed":0}], 79, "335298ba9c4370c9ad5e39e8a087f6d58507f8b0f100ae34a78aa435ba94b3f4"],
  ["primitives.cartStatusSchema", [0], 7, "7dd6bbd209653c60ac7f501c8f971f5b8b06faf19b51a0c7e28d1babecb36767"],
  ["primitives.checkoutStatusSchema", [0], 7, "d18d510f9b269ebeacd9e42ad6cb5427b2fef111dd07c436ef4673ee16ae9063"],
  ["primitives.commerceCurrencySchema", [0], 7, "1a88fb3f401bcdb791664c86d0541eecb5bd08dc0af51a10b72295e9fe8215aa"],
  ["primitives.commerceIdempotencyKeySchema", [0], 7, "7cc905098eb20876cc470cc87650e97ebe8d8d286ab618c3106b1ce9751e1e63"],
  ["primitives.commerceMoneySchema", [{"amountMinor":"invalid","currency":0}], 13, "5c9bf12b23b412850e41a8049b13e8c5919ae10d659020b78928b4d99f733f3f"],
  ["primitives.commerceProductSlugSchema", [0], 7, "6b87673e5186ec2677a591318965a345efab15076e895b7cfd1ffba2e2d7cff8"],
  ["primitives.commerceSizeConstraintSchema", [{"kind":0,"value":"invalid","petId":0,"dailyKcalOverride":"invalid"}], 27, "f871a10f18b1a4bb4f58830ae615621f2d8f2077eb6baad8022f801b0acf0bd8"],
  ["primitives.commerceSkuSchema", [0], 7, "a46294ee882b006ff7ef3a91ffb776901f47ec0da2f83c44bfc306a4a48dfebe"],
  ["primitives.commerceTaxCategorySchema", [0], 7, "d6ba3a4c67831df4bbb490094e37677d1483426785dead38e9df111952c3f68b"],
  ["primitives.commerceTaxCountrySchema", [0], 7, "898f86763561953c87f68cc8b01d05458df14078ed31fa5efcd93f4901850b86"],
  ["primitives.commerceTaxLegalBasisSchema", [0], 7, "2e74f5d2746b2c811c5c8bb92ea6fcc8568f41b1febe7610346ea306e361b30a"],
  ["primitives.orderDraftStatusSchema", [0], 7, "7dd6bbd209653c60ac7f501c8f971f5b8b06faf19b51a0c7e28d1babecb36767"],
  ["primitives.orderStatusSchema", [0], 7, "ff307407ab622e224687804604723af9a748bef1433904fd94c55f784f047d01"],
  ["primitives.paymentStatusSchema", [0], 7, "c5eb205821600473888e49e1b5018a14f32449ac810fe297353f8417475f1ef6"],
  ["resume.checkoutResumeDraftSchema", [{"id":0,"contractVersion":0,"lastSectionId":0,"draftState":{"version":0,"mode":0,"cadenceDays":"invalid","cart":{"items":[{"sku":0,"productSlug":0,"variantId":0,"quantity":"invalid"}]},"completion":{"petProfile":0,"productSelection":0,"cadence":0,"account":0,"shipping":0,"billing":0,"payment":0,"review":0},"redactedFields":[0]},"expiresAt":0,"createdAt":0,"updatedAt":0,"replayed":0}], 79, "705dc8fc71355ece3fc4dea6a43413a1e9bff9d67bed4eb1a124aeb7909e52eb"],
  ["resume.checkoutResumeDraftStateSchema", [{"version":0,"mode":0,"cadenceDays":"invalid","cart":{"items":[{"sku":0,"productSlug":0,"variantId":0,"quantity":"invalid"}]},"completion":{"petProfile":0,"productSelection":0,"cadence":0,"account":0,"shipping":0,"billing":0,"payment":0,"review":0},"redactedFields":[0]}], 49, "8aa3013b98b9a3e06a958f28d292cb5c04cf1abca7e5dd2a945d39e1ee0fb8f9"],
  ["resume.checkoutResumeModeSchema", [0], 7, "355bbde7fd8549c69965f4467d4cb6b1999829c3d9469d07c3f18800a460102c"],
  ["resume.checkoutResumeReadRequestSchema", [{"resumeToken":0}], 9, "f3acd3af7484f16faed5e31ce41438192526d7ddbca76ececec44a1564d44e73"],
  ["resume.checkoutResumeReadResponseSchema", [{"contractVersion":0,"draft":{"id":0,"contractVersion":0,"lastSectionId":0,"draftState":{"version":0,"mode":0,"cadenceDays":"invalid","cart":{"items":[{"sku":0,"productSlug":0,"variantId":0,"quantity":"invalid"}]},"completion":{"petProfile":0,"productSelection":0,"cadence":0,"account":0,"shipping":0,"billing":0,"payment":0,"review":0},"redactedFields":[0]},"expiresAt":0,"createdAt":0,"updatedAt":0,"replayed":0}}], 13, "0f9053d549ba0f3754b7ea0f2c8335fbd55d87a2b6476c66d8e19e3d6b7b1999"],
  ["resume.checkoutResumeRedactedFieldSchema", [0], 7, "04290b6401c84b73a6ef0aa6d2ea005b55dcf07dd5d63fee49de36ee48c5a5cf"],
  ["resume.checkoutResumeSectionIdSchema", [0], 7, "773cc6821c44fccc7843ee905f13d2c9560a9fd411106373fcddd2ec12f501a4"],
  ["resume.checkoutResumeTokenSchema", [0], 7, "cea7f1870570e1e0330abe191f6c7398ddfb6d2c13690a2f72bbfa1dfd8db45c"],
  ["resume.checkoutResumeUpsertRequestSchema", [{"resumeToken":0,"idempotencyKey":0,"lastSectionId":0,"draftState":{"version":0,"mode":0,"cadenceDays":"invalid","cart":{"items":[{"sku":0,"productSlug":0,"variantId":0,"quantity":"invalid"}]},"completion":{"petProfile":0,"productSelection":0,"cadence":0,"account":0,"shipping":0,"billing":0,"payment":0,"review":0},"redactedFields":[0]},"ttlMinutes":"invalid"}], 37, "eea6116f3bc7d01f57ecabba25d84faabb401d862c4b0bb586da5367c8cdacf3"],
  ["resume.checkoutResumeUpsertResponseSchema", [{"contractVersion":0,"resumeToken":0,"draft":{"id":0,"contractVersion":0,"lastSectionId":0,"draftState":{"version":0,"mode":0,"cadenceDays":"invalid","cart":{"items":[{"sku":0,"productSlug":0,"variantId":0,"quantity":"invalid"}]},"completion":{"petProfile":0,"productSelection":0,"cadence":0,"account":0,"shipping":0,"billing":0,"payment":0,"review":0},"redactedFields":[0]},"expiresAt":0,"createdAt":0,"updatedAt":0,"replayed":0}}], 19, "901e0b25d1f8196b8b7e3ce9cee365f2f38982aeca7a80345d52c6baadce798d"],
];
const auditModules = { contracts, primitives, intent, checkout, persistence, resume, defaults, availability, outbox };
it.each(auditFixtures)("preserves generated BASE multi-error transcripts: %s", (name, seeds, count, goldenDigest) => {
  const [moduleName, schemaName] = name.split(".");
  const schema = (auditModules[moduleName as keyof typeof auditModules] as Record<string, z.ZodType>)[schemaName];
  const digest = createHash("sha256");
  let cases = 0;
  for (const seed of seeds) for (const input of invalidCases(seed)) {
    const result = schema.safeParse(input);
    digest.update(JSON.stringify(result.success ? { success: true, data: result.data } : { success: false, issues: result.error.issues }) + "\n");
    cases++;
  }
  expect(cases).toBe(count);
  expect(digest.digest("hex")).toBe(goldenDigest);
});

function* invalidCases(seed: unknown): Generator<unknown> {
 yield undefined; yield null; yield 0; yield ''; yield []; yield {};
 yield seed;
 if(!seed || typeof seed!=='object' || Array.isArray(seed))return;
 const entries=Object.entries(seed);
 // Every pair, full-field rotations, and reversed insertion order. Input order
 // must never determine the order Zod reports the schema's field failures.
 for(let i=0;i<entries.length;i++){
  const rotated=[...entries.slice(i),...entries.slice(0,i)];
  yield Object.fromEntries(rotated); yield Object.fromEntries([...rotated].reverse());
  for(let j=i+1;j<entries.length;j++){
   yield Object.fromEntries([entries[i],entries[j]]);
   yield Object.fromEntries([entries[j],entries[i]]);
  }
 }
}

it.each([{}, { minimumUnits: 1 }, { minimumUnits: 1, offerVersion: "offer-a.v2" }])("rejects a one-unit checkout with unbound offer fields as BASE did: %j", async (offerFields) => {
  const oneUnitIntent = { ...baseIntent, ...offerFields,
    selectedVariants: [{ ...baseIntent.selectedVariants[0], qty: 1 }] };
  // D6 still admits the untrusted ask outside checkout.
  expect(intent.configuratorIntentSchema.safeParse(oneUnitIntent).success).toBe("minimumUnits" in offerFields);
  const status = vi.fn();
  const json = vi.fn();
  const res = { setHeader: vi.fn(), status, json } as unknown as HttpResponse;
  status.mockReturnValue(res);
  const checkRateLimit = vi.fn(async () => ({ allowed: true }));
  const result = await admitCheckoutRequest({ req: { method: "POST", headers: {}, body: { intent: oneUnitIntent } },
    res, deps: { checkRateLimit, rateLimitMessage: () => "limited" }, record: async (_stage, operation) => operation() });
  expect(result).toEqual({ kind: "responded", outcome: "rejected" });
  expect(status).toHaveBeenCalledWith(400);
  // Exact BASE refusal for the same under-minimum basket. K1's additive fields
  // no longer produce unknown-key issues, but cannot waive the server floor.
  expect(json).toHaveBeenCalledWith({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid checkout request",
    details: { formErrors: [], fieldErrors: { intent: ["selected variants require at least 14 total units"] } } } });
  expect(checkRateLimit).not.toHaveBeenCalled();
});

// Representative fields of every BASE-exported reference schema, in both
// directions. These goldens were read by TypeScript from git show BASE sources.
// Include every nested SKU/currency/product slug and the injected vocabularies.
type ReferenceSchemaTypes = {
  "contracts.cartStatusSchema": { input: z.input<typeof contracts.cartStatusSchema>; output: z.output<typeof contracts.cartStatusSchema> };
  "contracts.checkoutStatusSchema": { input: z.input<typeof contracts.checkoutStatusSchema>; output: z.output<typeof contracts.checkoutStatusSchema> };
  "contracts.commerceCurrencySchema": { input: z.input<typeof contracts.commerceCurrencySchema>; output: z.output<typeof contracts.commerceCurrencySchema> };
  "contracts.commerceIdempotencyKeySchema": { input: z.input<typeof contracts.commerceIdempotencyKeySchema>; output: z.output<typeof contracts.commerceIdempotencyKeySchema> };
  "contracts.commerceMoneySchema": { input: z.input<typeof contracts.commerceMoneySchema>; output: z.output<typeof contracts.commerceMoneySchema> };
  "contracts.commerceProductSlugSchema": { input: z.input<typeof contracts.commerceProductSlugSchema>; output: z.output<typeof contracts.commerceProductSlugSchema> };
  "contracts.commerceSkuSchema": { input: z.input<typeof contracts.commerceSkuSchema>; output: z.output<typeof contracts.commerceSkuSchema> };
  "contracts.commerceTaxCategorySchema": { input: z.input<typeof contracts.commerceTaxCategorySchema>; output: z.output<typeof contracts.commerceTaxCategorySchema> };
  "contracts.commerceTaxCountrySchema": { input: z.input<typeof contracts.commerceTaxCountrySchema>; output: z.output<typeof contracts.commerceTaxCountrySchema> };
  "contracts.commerceTaxLegalBasisSchema": { input: z.input<typeof contracts.commerceTaxLegalBasisSchema>; output: z.output<typeof contracts.commerceTaxLegalBasisSchema> };
  "contracts.orderDraftStatusSchema": { input: z.input<typeof contracts.orderDraftStatusSchema>; output: z.output<typeof contracts.orderDraftStatusSchema> };
  "contracts.orderStatusSchema": { input: z.input<typeof contracts.orderStatusSchema>; output: z.output<typeof contracts.orderStatusSchema> };
  "contracts.paymentStatusSchema": { input: z.input<typeof contracts.paymentStatusSchema>; output: z.output<typeof contracts.paymentStatusSchema> };
  "contracts.cartLineInputSchema": { input: z.input<typeof contracts.cartLineInputSchema>; output: z.output<typeof contracts.cartLineInputSchema> };
  "contracts.commerceQuoteSchema": { input: z.input<typeof contracts.commerceQuoteSchema>; output: z.output<typeof contracts.commerceQuoteSchema> };
  "contracts.commerceTaxBreakdownSchema": { input: z.input<typeof contracts.commerceTaxBreakdownSchema>; output: z.output<typeof contracts.commerceTaxBreakdownSchema> };
  "contracts.createQuoteBatchRequestSchema": { input: z.input<typeof contracts.createQuoteBatchRequestSchema>; output: z.output<typeof contracts.createQuoteBatchRequestSchema> };
  "contracts.createQuoteBatchResponseSchema": { input: z.input<typeof contracts.createQuoteBatchResponseSchema>; output: z.output<typeof contracts.createQuoteBatchResponseSchema> };
  "contracts.publicCreateQuoteBatchResponseSchema": { input: z.input<typeof contracts.publicCreateQuoteBatchResponseSchema>; output: z.output<typeof contracts.publicCreateQuoteBatchResponseSchema> };
  "contracts.createQuoteRequestSchema": { input: z.input<typeof contracts.createQuoteRequestSchema>; output: z.output<typeof contracts.createQuoteRequestSchema> };
  "contracts.createQuoteResponseSchema": { input: z.input<typeof contracts.createQuoteResponseSchema>; output: z.output<typeof contracts.createQuoteResponseSchema> };
  "contracts.publicCreateQuoteRequestSchema": { input: z.input<typeof contracts.publicCreateQuoteRequestSchema>; output: z.output<typeof contracts.publicCreateQuoteRequestSchema> };
  "contracts.publicCreateQuoteResponseSchema": { input: z.input<typeof contracts.publicCreateQuoteResponseSchema>; output: z.output<typeof contracts.publicCreateQuoteResponseSchema> };
  "contracts.quoteContextSchema": { input: z.input<typeof contracts.quoteContextSchema>; output: z.output<typeof contracts.quoteContextSchema> };
  "contracts.quoteCustomerEligibilityContextSchema": { input: z.input<typeof contracts.quoteCustomerEligibilityContextSchema>; output: z.output<typeof contracts.quoteCustomerEligibilityContextSchema> };
  "contracts.quoteCodeRejectionDetailSchema": { input: z.input<typeof contracts.quoteCodeRejectionDetailSchema>; output: z.output<typeof contracts.quoteCodeRejectionDetailSchema> };
  "contracts.quoteDiscountSchema": { input: z.input<typeof contracts.quoteDiscountSchema>; output: z.output<typeof contracts.quoteDiscountSchema> };
  "contracts.quoteLineSchema": { input: z.input<typeof contracts.quoteLineSchema>; output: z.output<typeof contracts.quoteLineSchema> };
  "contracts.quotePetProfileContextSchema": { input: z.input<typeof contracts.quotePetProfileContextSchema>; output: z.output<typeof contracts.quotePetProfileContextSchema> };
  "contracts.quotePricingComponentSchema": { input: z.input<typeof contracts.quotePricingComponentSchema>; output: z.output<typeof contracts.quotePricingComponentSchema> };
  "contracts.quoteSizeConstraintSchema": { input: z.input<typeof contracts.quoteSizeConstraintSchema>; output: z.output<typeof contracts.quoteSizeConstraintSchema> };
  "contracts.starterPackPlanSchema": { input: z.input<typeof contracts.starterPackPlanSchema>; output: z.output<typeof contracts.starterPackPlanSchema> };
  "contracts.createCartRequestSchema": { input: z.input<typeof contracts.createCartRequestSchema>; output: z.output<typeof contracts.createCartRequestSchema> };
  "contracts.cartDraftSchema": { input: z.input<typeof contracts.cartDraftSchema>; output: z.output<typeof contracts.cartDraftSchema> };
  "contracts.createCartResponseSchema": { input: z.input<typeof contracts.createCartResponseSchema>; output: z.output<typeof contracts.createCartResponseSchema> };
  "contracts.createCheckoutRequestSchema": { input: z.input<typeof contracts.createCheckoutRequestSchema>; output: z.output<typeof contracts.createCheckoutRequestSchema> };
  "contracts.createCheckoutResponseSchema": { input: z.input<typeof contracts.createCheckoutResponseSchema>; output: z.output<typeof contracts.createCheckoutResponseSchema> };
  "contracts.orderDraftSummarySchema": { input: z.input<typeof contracts.orderDraftSummarySchema>; output: z.output<typeof contracts.orderDraftSummarySchema> };
  "contracts.createOrderDraftRequestSchema": { input: z.input<typeof contracts.createOrderDraftRequestSchema>; output: z.output<typeof contracts.createOrderDraftRequestSchema> };
  "contracts.createOrderDraftResponseSchema": { input: z.input<typeof contracts.createOrderDraftResponseSchema>; output: z.output<typeof contracts.createOrderDraftResponseSchema> };
  "contracts.orderSummarySchema": { input: z.input<typeof contracts.orderSummarySchema>; output: z.output<typeof contracts.orderSummarySchema> };
  "contracts.orderReadResponseSchema": { input: z.input<typeof contracts.orderReadResponseSchema>; output: z.output<typeof contracts.orderReadResponseSchema> };
  "contracts.paymentSummarySchema": { input: z.input<typeof contracts.paymentSummarySchema>; output: z.output<typeof contracts.paymentSummarySchema> };
  "contracts.paymentStatusReadResponseSchema": { input: z.input<typeof contracts.paymentStatusReadResponseSchema>; output: z.output<typeof contracts.paymentStatusReadResponseSchema> };
  "checkout.checkoutKindSchema": { input: z.input<typeof checkout.checkoutKindSchema>; output: z.output<typeof checkout.checkoutKindSchema> };
  "checkout.checkoutActivationStatusSchema": { input: z.input<typeof checkout.checkoutActivationStatusSchema>; output: z.output<typeof checkout.checkoutActivationStatusSchema> };
  "checkout.asyncCheckoutStatusSchema": { input: z.input<typeof checkout.asyncCheckoutStatusSchema>; output: z.output<typeof checkout.asyncCheckoutStatusSchema> };
  "checkout.subscriptionActivationStatusSchema": { input: z.input<typeof checkout.subscriptionActivationStatusSchema>; output: z.output<typeof checkout.subscriptionActivationStatusSchema> };
  "checkout.invoiceBuyerSnapshotAddressSchema": { input: z.input<typeof checkout.invoiceBuyerSnapshotAddressSchema>; output: z.output<typeof checkout.invoiceBuyerSnapshotAddressSchema> };
  "checkout.checkoutInvoicePreferenceSchema": { input: z.input<typeof checkout.checkoutInvoicePreferenceSchema>; output: z.output<typeof checkout.checkoutInvoicePreferenceSchema> };
  "checkout.invoiceBuyerSnapshotSchema": { input: z.input<typeof checkout.invoiceBuyerSnapshotSchema>; output: z.output<typeof checkout.invoiceBuyerSnapshotSchema> };
  "checkout.checkoutClientActionSchema": { input: z.input<typeof checkout.checkoutClientActionSchema>; output: z.output<typeof checkout.checkoutClientActionSchema> };
  "checkout.checkoutRequestSchema": { input: z.input<typeof checkout.checkoutRequestSchema>; output: z.output<typeof checkout.checkoutRequestSchema> };
  "checkout.checkoutResponseSchema": { input: z.input<typeof checkout.checkoutResponseSchema>; output: z.output<typeof checkout.checkoutResponseSchema> };
  "checkout.paymentStatusRequestSchema": { input: z.input<typeof checkout.paymentStatusRequestSchema>; output: z.output<typeof checkout.paymentStatusRequestSchema> };
  "checkout.paymentStatusResponseSchema": { input: z.input<typeof checkout.paymentStatusResponseSchema>; output: z.output<typeof checkout.paymentStatusResponseSchema> };
  "resume.checkoutResumeTokenSchema": { input: z.input<typeof resume.checkoutResumeTokenSchema>; output: z.output<typeof resume.checkoutResumeTokenSchema> };
  "resume.checkoutResumeSectionIdSchema": { input: z.input<typeof resume.checkoutResumeSectionIdSchema>; output: z.output<typeof resume.checkoutResumeSectionIdSchema> };
  "resume.checkoutResumeRedactedFieldSchema": { input: z.input<typeof resume.checkoutResumeRedactedFieldSchema>; output: z.output<typeof resume.checkoutResumeRedactedFieldSchema> };
  "resume.checkoutResumeModeSchema": { input: z.input<typeof resume.checkoutResumeModeSchema>; output: z.output<typeof resume.checkoutResumeModeSchema> };
  "resume.checkoutResumeDraftStateSchema": { input: z.input<typeof resume.checkoutResumeDraftStateSchema>; output: z.output<typeof resume.checkoutResumeDraftStateSchema> };
  "resume.checkoutResumeUpsertRequestSchema": { input: z.input<typeof resume.checkoutResumeUpsertRequestSchema>; output: z.output<typeof resume.checkoutResumeUpsertRequestSchema> };
  "resume.checkoutResumeReadRequestSchema": { input: z.input<typeof resume.checkoutResumeReadRequestSchema>; output: z.output<typeof resume.checkoutResumeReadRequestSchema> };
  "resume.checkoutResumeDraftSchema": { input: z.input<typeof resume.checkoutResumeDraftSchema>; output: z.output<typeof resume.checkoutResumeDraftSchema> };
  "resume.checkoutResumeUpsertResponseSchema": { input: z.input<typeof resume.checkoutResumeUpsertResponseSchema>; output: z.output<typeof resume.checkoutResumeUpsertResponseSchema> };
  "resume.checkoutResumeReadResponseSchema": { input: z.input<typeof resume.checkoutResumeReadResponseSchema>; output: z.output<typeof resume.checkoutResumeReadResponseSchema> };
  "persistence.configuratorIntentPersistenceRequestSchema": { input: z.input<typeof persistence.configuratorIntentPersistenceRequestSchema>; output: z.output<typeof persistence.configuratorIntentPersistenceRequestSchema> };
  "persistence.configuratorIntentClientMatchReasonSchema": { input: z.input<typeof persistence.configuratorIntentClientMatchReasonSchema>; output: z.output<typeof persistence.configuratorIntentClientMatchReasonSchema> };
  "persistence.configuratorIntentPersistenceResponseSchema": { input: z.input<typeof persistence.configuratorIntentPersistenceResponseSchema>; output: z.output<typeof persistence.configuratorIntentPersistenceResponseSchema> };
  "defaults.commerceCustomerDefaultsRedactedFieldSchema": { input: z.input<typeof defaults.commerceCustomerDefaultsRedactedFieldSchema>; output: z.output<typeof defaults.commerceCustomerDefaultsRedactedFieldSchema> };
  "defaults.commerceCustomerDefaultsSnapshotSchema": { input: z.input<typeof defaults.commerceCustomerDefaultsSnapshotSchema>; output: z.output<typeof defaults.commerceCustomerDefaultsSnapshotSchema> };
  "availability.commerceOfferAvailabilityStatusSchema": { input: z.input<typeof availability.commerceOfferAvailabilityStatusSchema>; output: z.output<typeof availability.commerceOfferAvailabilityStatusSchema> };
  "availability.commerceOfferAvailabilitySourceSchema": { input: z.input<typeof availability.commerceOfferAvailabilitySourceSchema>; output: z.output<typeof availability.commerceOfferAvailabilitySourceSchema> };
  "availability.commerceOfferAvailabilityRequestItemSchema": { input: z.input<typeof availability.commerceOfferAvailabilityRequestItemSchema>; output: z.output<typeof availability.commerceOfferAvailabilityRequestItemSchema> };
  "availability.commerceOfferAvailabilitySchema": { input: z.input<typeof availability.commerceOfferAvailabilitySchema>; output: z.output<typeof availability.commerceOfferAvailabilitySchema> };
  "intent.configuratorPetAgeBandSchema": { input: z.input<typeof intent.configuratorPetAgeBandSchema>; output: z.output<typeof intent.configuratorPetAgeBandSchema> };
  "intent.configuratorActivityLevelSchema": { input: z.input<typeof intent.configuratorActivityLevelSchema>; output: z.output<typeof intent.configuratorActivityLevelSchema> };
  "intent.configuratorBcsSchema": { input: z.input<typeof intent.configuratorBcsSchema>; output: z.output<typeof intent.configuratorBcsSchema> };
  "intent.configuratorModeSchema": { input: z.input<typeof intent.configuratorModeSchema>; output: z.output<typeof intent.configuratorModeSchema> };
  "intent.configuratorCadenceDaysSchema": { input: z.input<typeof intent.configuratorCadenceDaysSchema>; output: z.output<typeof intent.configuratorCadenceDaysSchema> };
  "intent.configuratorDeliveryKindSchema": { input: z.input<typeof intent.configuratorDeliveryKindSchema>; output: z.output<typeof intent.configuratorDeliveryKindSchema> };
  "intent.configuratorPaymentMethodSchema": { input: z.input<typeof intent.configuratorPaymentMethodSchema>; output: z.output<typeof intent.configuratorPaymentMethodSchema> };
  "intent.configuratorAllergenSlugSchema": { input: z.input<typeof intent.configuratorAllergenSlugSchema>; output: z.output<typeof intent.configuratorAllergenSlugSchema> };
  "intent.configuratorSizeConstraintSchema": { input: z.input<typeof intent.configuratorSizeConstraintSchema>; output: z.output<typeof intent.configuratorSizeConstraintSchema> };
  "intent.configuratorIntentSchema": { input: z.input<typeof intent.configuratorIntentSchema>; output: z.output<typeof intent.configuratorIntentSchema> };
  "primitives.commerceCurrencySchema": { input: z.input<typeof primitives.commerceCurrencySchema>; output: z.output<typeof primitives.commerceCurrencySchema> };
  "primitives.commerceTaxCountrySchema": { input: z.input<typeof primitives.commerceTaxCountrySchema>; output: z.output<typeof primitives.commerceTaxCountrySchema> };
  "primitives.commerceTaxCategorySchema": { input: z.input<typeof primitives.commerceTaxCategorySchema>; output: z.output<typeof primitives.commerceTaxCategorySchema> };
  "primitives.commerceTaxLegalBasisSchema": { input: z.input<typeof primitives.commerceTaxLegalBasisSchema>; output: z.output<typeof primitives.commerceTaxLegalBasisSchema> };
  "primitives.cartStatusSchema": { input: z.input<typeof primitives.cartStatusSchema>; output: z.output<typeof primitives.cartStatusSchema> };
  "primitives.checkoutStatusSchema": { input: z.input<typeof primitives.checkoutStatusSchema>; output: z.output<typeof primitives.checkoutStatusSchema> };
  "primitives.orderDraftStatusSchema": { input: z.input<typeof primitives.orderDraftStatusSchema>; output: z.output<typeof primitives.orderDraftStatusSchema> };
  "primitives.orderStatusSchema": { input: z.input<typeof primitives.orderStatusSchema>; output: z.output<typeof primitives.orderStatusSchema> };
  "primitives.paymentStatusSchema": { input: z.input<typeof primitives.paymentStatusSchema>; output: z.output<typeof primitives.paymentStatusSchema> };
  "primitives.commerceProductSlugSchema": { input: z.input<typeof primitives.commerceProductSlugSchema>; output: z.output<typeof primitives.commerceProductSlugSchema> };
  "primitives.commerceIdempotencyKeySchema": { input: z.input<typeof primitives.commerceIdempotencyKeySchema>; output: z.output<typeof primitives.commerceIdempotencyKeySchema> };
  "primitives.commerceSkuSchema": { input: z.input<typeof primitives.commerceSkuSchema>; output: z.output<typeof primitives.commerceSkuSchema> };
  "primitives.commerceMoneySchema": { input: z.input<typeof primitives.commerceMoneySchema>; output: z.output<typeof primitives.commerceMoneySchema> };
  "primitives.commerceSizeConstraintSchema": { input: z.input<typeof primitives.commerceSizeConstraintSchema>; output: z.output<typeof primitives.commerceSizeConstraintSchema> };
};
type ReferenceField<T, Path extends PropertyKey[]> = Path extends [infer Key extends PropertyKey, ...infer Rest extends PropertyKey[]]
  ? T extends null | undefined ? T : Key extends keyof T ? ReferenceField<T[Key], Rest> : never
  : T;
it("preserves BASE input and output field types across all exported reference schemas", () => {
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartStatusSchema"]["input"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartStatusSchema"]["output"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.checkoutStatusSchema"]["input"], []>>().toEqualTypeOf<"not_configured" | "created" | "expired">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.checkoutStatusSchema"]["output"], []>>().toEqualTypeOf<"not_configured" | "created" | "expired">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceCurrencySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceCurrencySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceIdempotencyKeySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceIdempotencyKeySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceMoneySchema"]["input"], ["amountMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceMoneySchema"]["input"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceMoneySchema"]["output"], ["amountMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceMoneySchema"]["output"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceProductSlugSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceProductSlugSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceSkuSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceSkuSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxCategorySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxCategorySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxCountrySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxCountrySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxLegalBasisSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxLegalBasisSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftStatusSchema"]["input"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftStatusSchema"]["output"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderStatusSchema"]["input"], []>>().toEqualTypeOf<"draft" | "expired" | "pending_payment" | "paid" | "failed" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderStatusSchema"]["output"], []>>().toEqualTypeOf<"draft" | "expired" | "pending_payment" | "paid" | "failed" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentStatusSchema"]["input"], []>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentStatusSchema"]["output"], []>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["input"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["input"], ["quantity"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["input"], ["variantId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["input"], ["modeAtLine"]>>().toEqualTypeOf<"one_time" | "subscription" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["input"], ["isAddon"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["output"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["output"], ["quantity"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["output"], ["variantId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["output"], ["modeAtLine"]>>().toEqualTypeOf<"one_time" | "subscription" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartLineInputSchema"]["output"], ["isAddon"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["taxIncluded"]>>().toEqualTypeOf<true>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["input"], ["shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["taxIncluded"]>>().toEqualTypeOf<true>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceQuoteSchema"]["output"], ["shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["included"]>>().toEqualTypeOf<true>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["country"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["category"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["vatRateBps"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["legalBasis"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["input"], ["grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["included"]>>().toEqualTypeOf<true>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["country"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["category"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["vatRateBps"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["legalBasis"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.commerceTaxBreakdownSchema"]["output"], ["grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchRequestSchema"]["input"], ["quotes",0,"lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchRequestSchema"]["output"], ["quotes",0,"mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchRequestSchema"]["output"], ["quotes",0,"lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["input"], ["quotes",0,"shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteBatchResponseSchema"]["output"], ["quotes",0,"shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["input"], ["quotes",0,"shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteBatchResponseSchema"]["output"], ["quotes",0,"shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["input"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["input"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["input"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["input"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["input"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["output"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["output"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["output"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["output"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteRequestSchema"]["output"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["input"], ["quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createQuoteResponseSchema"]["output"], ["quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["promotionAcceptanceToken"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["input"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["promotionAcceptanceToken"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteRequestSchema"]["output"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["input"], ["promotionAcceptanceToken"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.publicCreateQuoteResponseSchema"]["output"], ["promotionAcceptanceToken"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["input"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["input"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["input"], ["feedingCoverageDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["input"], ["starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["output"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["output"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["output"], ["feedingCoverageDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteContextSchema"]["output"], ["starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCustomerEligibilityContextSchema"]["input"], ["email"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCustomerEligibilityContextSchema"]["input"], ["contactEmail"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCustomerEligibilityContextSchema"]["input"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCustomerEligibilityContextSchema"]["output"], ["email"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCustomerEligibilityContextSchema"]["output"], ["contactEmail"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCustomerEligibilityContextSchema"]["output"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["input"], ["code"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["input"], ["reason"]>>().toEqualTypeOf<"scope_not_applicable" | "minimum_not_met" | "not_yet_active" | "global_limit_reached">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["input"], ["minimumReferenceMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["input"], ["validFrom"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["output"], ["code"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["output"], ["reason"]>>().toEqualTypeOf<"scope_not_applicable" | "minimum_not_met" | "not_yet_active" | "global_limit_reached">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["output"], ["minimumReferenceMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteCodeRejectionDetailSchema"]["output"], ["validFrom"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["appliesTo"]>>().toEqualTypeOf<"line" | "shipping" | "order_total">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["amountOffMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["reasonCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["code"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["label"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["customerSemantic"]>>().toEqualTypeOf<"first_purchase_10" | "first_subscription_50" | "bundle_5" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionEngineVersion"]>>().toEqualTypeOf<"promotion-engine.v2" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionCodeId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionCodeRevision"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionDefinitionFingerprint"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionMinimumReferenceMinor"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionCodeValidTo"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionBenefitKind"]>>().toEqualTypeOf<"target_percentage" | "percentage" | "fixed_amount" | "free_shipping" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionBenefitValueBps"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["promotionBenefitValueMinor"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["input"], ["floorApplied"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["appliesTo"]>>().toEqualTypeOf<"line" | "shipping" | "order_total">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["amountOffMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["reasonCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["code"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["label"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["customerSemantic"]>>().toEqualTypeOf<"first_purchase_10" | "first_subscription_50" | "bundle_5" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionEngineVersion"]>>().toEqualTypeOf<"promotion-engine.v2" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionCodeId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionCodeRevision"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionDefinitionFingerprint"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionMinimumReferenceMinor"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionCodeValidTo"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionBenefitKind"]>>().toEqualTypeOf<"target_percentage" | "percentage" | "fixed_amount" | "free_shipping" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionBenefitValueBps"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["promotionBenefitValueMinor"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteDiscountSchema"]["output"], ["floorApplied"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["quantity"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["input"], ["catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["quantity"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteLineSchema"]["output"], ["catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["ageBand"]>>().toEqualTypeOf<"puppy" | "young" | "adult" | "senior" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["breed"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["weightKg"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["activityLevel"]>>().toEqualTypeOf<"low" | "normal" | "high" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["bcs"]>>().toEqualTypeOf<"thin" | "ideal" | "overweight" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["input"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["ageBand"]>>().toEqualTypeOf<"puppy" | "young" | "adult" | "senior" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["breed"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["weightKg"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["activityLevel"]>>().toEqualTypeOf<"low" | "normal" | "high" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["bcs"]>>().toEqualTypeOf<"thin" | "ideal" | "overweight" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePetProfileContextSchema"]["output"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["input"], ["scope"]>>().toEqualTypeOf<"line" | "order">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["input"], ["componentType"]>>().toEqualTypeOf<"base_unit" | "mode_discount" | "qty_tier" | "promo" | "loyalty" | "shipping" | "bundle">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["input"], ["amountMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["input"], ["reasonCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["input"], ["reasonPayload"]>>().toEqualTypeOf<Record<string, unknown> | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["output"], ["scope"]>>().toEqualTypeOf<"line" | "order">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["output"], ["componentType"]>>().toEqualTypeOf<"base_unit" | "mode_discount" | "qty_tier" | "promo" | "loyalty" | "shipping" | "bundle">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["output"], ["amountMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["output"], ["reasonCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quotePricingComponentSchema"]["output"], ["reasonPayload"]>>().toEqualTypeOf<{ [x: string]: unknown; }>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["input"], ["kind"]>>().toEqualTypeOf<"unit_count" | "total_weight_g" | "feeding_days">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["input"], ["value"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["input"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["output"], ["kind"]>>().toEqualTypeOf<"unit_count" | "total_weight_g" | "feeding_days">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["output"], ["value"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.quoteSizeConstraintSchema"]["output"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["input"], ["schemaVersion"]>>().toEqualTypeOf<"1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["input"], ["starterIntervalDays"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["input"], ["basisTemplateVersion"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["input"], ["graduation","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["output"], ["schemaVersion"]>>().toEqualTypeOf<"1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["output"], ["starterIntervalDays"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["output"], ["basisTemplateVersion"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.starterPackPlanSchema"]["output"], ["graduation","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartRequestSchema"]["input"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartRequestSchema"]["input"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartRequestSchema"]["input"], ["clientId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartRequestSchema"]["output"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartRequestSchema"]["output"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartRequestSchema"]["output"], ["clientId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["input"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["input"], ["status"]>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["input"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["input"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["output"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["output"], ["status"]>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["output"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.cartDraftSchema"]["output"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartResponseSchema"]["input"], ["cart","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartResponseSchema"]["input"], ["cart","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartResponseSchema"]["output"], ["cart","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCartResponseSchema"]["output"], ["cart","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["input"], ["cartId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["input"], ["successUrl"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["input"], ["cancelUrl"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["output"], ["cartId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["output"], ["successUrl"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["output"], ["cancelUrl"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutRequestSchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createCheckoutResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["status"]>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["paymentStatus"]>>().toEqualTypeOf<"not_started">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["quoteSnapshot","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["input"], ["replayed"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["status"]>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["paymentStatus"]>>().toEqualTypeOf<"not_started">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["quoteSnapshot","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderDraftSummarySchema"]["output"], ["replayed"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["input"], ["quoteSnapshot","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftRequestSchema"]["output"], ["quoteSnapshot","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["input"], ["orderDraft","quoteSnapshot","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","subtotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","netTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","taxTotal","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.createOrderDraftResponseSchema"]["output"], ["orderDraft","quoteSnapshot","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["input"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["input"], ["status"]>>().toEqualTypeOf<"draft" | "expired" | "pending_payment" | "paid" | "failed" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["input"], ["paymentStatus"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["input"], ["total","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["input"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["output"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["output"], ["status"]>>().toEqualTypeOf<"draft" | "expired" | "pending_payment" | "paid" | "failed" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["output"], ["paymentStatus"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["output"], ["total","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderSummarySchema"]["output"], ["lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderReadResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderReadResponseSchema"]["input"], ["order","total","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderReadResponseSchema"]["input"], ["order","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderReadResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderReadResponseSchema"]["output"], ["order","total","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.orderReadResponseSchema"]["output"], ["order","lines",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["input"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["input"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["input"], ["status"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["input"], ["amount","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["input"], ["providerReference"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["output"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["output"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["output"], ["status"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["output"], ["amount","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentSummarySchema"]["output"], ["providerReference"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentStatusReadResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentStatusReadResponseSchema"]["input"], ["payment","amount","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentStatusReadResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.v0">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["contracts.paymentStatusReadResponseSchema"]["output"], ["payment","amount","currency"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutKindSchema"]["input"], []>>().toEqualTypeOf<"one_time" | "subscription_initial">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutKindSchema"]["output"], []>>().toEqualTypeOf<"one_time" | "subscription_initial">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutActivationStatusSchema"]["input"], []>>().toEqualTypeOf<"not_applicable" | "pending_payment_success" | "activated" | "blocked_missing_payment_method">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutActivationStatusSchema"]["output"], []>>().toEqualTypeOf<"not_applicable" | "pending_payment_success" | "activated" | "blocked_missing_payment_method">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.asyncCheckoutStatusSchema"]["input"], []>>().toEqualTypeOf<"expired" | "paid" | "failed" | "requires_action" | "processing" | "pending_provider_action">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.asyncCheckoutStatusSchema"]["output"], []>>().toEqualTypeOf<"expired" | "paid" | "failed" | "requires_action" | "processing" | "pending_provider_action">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.subscriptionActivationStatusSchema"]["input"], []>>().toEqualTypeOf<"not_applicable" | "waiting_for_mandate" | "active" | "action_required">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.subscriptionActivationStatusSchema"]["output"], []>>().toEqualTypeOf<"not_applicable" | "waiting_for_mandate" | "active" | "action_required">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["input"], ["line1"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["input"], ["city"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["input"], ["postalCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["input"], ["country"]>>().toEqualTypeOf<typeof hostCountry>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["input"], ["source"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["input"], ["line2"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["output"], ["line1"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["output"], ["line2"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["output"], ["city"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["output"], ["postalCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["output"], ["country"]>>().toEqualTypeOf<typeof hostCountry>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotAddressSchema"]["output"], ["source"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["input"], ["kind"]>>().toEqualTypeOf<"b2c_named" | "b2b_vat">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["input"], ["companyName"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["input"], ["taxId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["input"], ["email"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["input"], ["contactName"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["output"], ["kind"]>>().toEqualTypeOf<"b2c_named" | "b2b_vat">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["output"], ["companyName"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["output"], ["taxId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["output"], ["email"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutInvoicePreferenceSchema"]["output"], ["contactName"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["input"], ["name"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["input"], ["email"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["input"], ["taxId"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["input"], ["companyName"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["input"], ["source"]>>().toEqualTypeOf<"checkout_invoice_preference">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["output"], ["name"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["output"], ["email"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["output"], ["taxId"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["output"], ["companyName"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.invoiceBuyerSnapshotSchema"]["output"], ["source"]>>().toEqualTypeOf<"checkout_invoice_preference">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["input"], ["kind"]>>().toEqualTypeOf<"none" | "redirect" | "provider_embedded" | "blik_code_prompt">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["input"], ["url"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["input"], ["provider"]>>().toEqualTypeOf<typeof PAYMENT_EXECUTION_PROVIDERS[2] | typeof PAYMENT_EXECUTION_PROVIDERS[3]>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["input"], ["clientSecret"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["input"], ["sessionRef"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["output"], ["kind"]>>().toEqualTypeOf<"none" | "redirect" | "provider_embedded" | "blik_code_prompt">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["output"], ["url"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["output"], ["provider"]>>().toEqualTypeOf<typeof PAYMENT_EXECUTION_PROVIDERS[2] | typeof PAYMENT_EXECUTION_PROVIDERS[3]>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["output"], ["clientSecret"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutClientActionSchema"]["output"], ["sessionRef"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["intent","version"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["intent","selectedVariants",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["intent","recommendationSnapshot","lines",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["intent","recommendationSnapshot","allergenConflicts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["intent","recommendationSnapshot","excludedProducts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["intent","recommendationSnapshot","suggestedVariants",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["paymentProvider"]>>().toEqualTypeOf<typeof PAYMENT_EXECUTION_PROVIDERS[2] | typeof PAYMENT_EXECUTION_PROVIDERS[3] | "hidden_rehearsal" | "noop_payment" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["paymentAttemptSequence"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["declaredBankId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["returnContext"]>>().toEqualTypeOf<"public" | "account" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["input"], ["expectedQuote","totalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["intent","version"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["intent","selectedVariants",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["intent","recommendationSnapshot","lines",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["intent","recommendationSnapshot","allergenConflicts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["intent","recommendationSnapshot","excludedProducts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["intent","recommendationSnapshot","suggestedVariants",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["paymentProvider"]>>().toEqualTypeOf<typeof PAYMENT_EXECUTION_PROVIDERS[2] | typeof PAYMENT_EXECUTION_PROVIDERS[3] | "hidden_rehearsal" | "noop_payment">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["returnContext"]>>().toEqualTypeOf<"public" | "account">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["paymentAttemptSequence"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["declaredBankId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutRequestSchema"]["output"], ["expectedQuote","totalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout.v2">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["checkoutKind"]>>().toEqualTypeOf<"one_time" | "subscription_initial">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["orderRef"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["status"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "requires_action" | "processing" | "pending_provider_action" | "price_changed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["paymentIntentId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["paymentAttemptId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["providerPaymentId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["clientId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["returnUrl"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["statusUrl"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","subtotalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","totalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","netTotal","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","taxTotal","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["authoritativeQuote","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["priceChanged"]>>().toEqualTypeOf<true>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["input"], ["expectedQuote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout.v2">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["checkoutKind"]>>().toEqualTypeOf<"one_time" | "subscription_initial">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["orderRef"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["status"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "requires_action" | "processing" | "pending_provider_action" | "price_changed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["paymentIntentId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["paymentAttemptId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["providerPaymentId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["clientId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["returnUrl"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["statusUrl"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"productSlug"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"unitPriceGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"lineSubtotalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"tax","netAmount","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"tax","vatAmount","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"tax","grossAmount","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","lines",0,"catalogFacts","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","subtotalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","discountTotalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","totalGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","netTotal","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","taxTotal","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","pricingComponents",0,"scope"]>>().toEqualTypeOf<"line" | "order" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","context","starterPack","graduation","lines",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","shippingGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["authoritativeQuote","quote","shippingDiscountGross","currency"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["priceChanged"]>>().toEqualTypeOf<true>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.checkoutResponseSchema"]["output"], ["expectedQuote","totalGross","currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusRequestSchema"]["input"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusRequestSchema"]["input"], ["paymentIntentId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusRequestSchema"]["input"], ["clientId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusRequestSchema"]["output"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusRequestSchema"]["output"], ["paymentIntentId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusRequestSchema"]["output"], ["clientId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout.v2">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["paymentIntentId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["status"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "requires_action" | "processing" | "pending_provider_action">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["orderStatus"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["payment","intentStatus"]>>().toEqualTypeOf<"created" | "expired" | "failed" | "cancelled" | "refunded" | "requires_action" | "processing" | "partially_refunded" | "disputed" | "succeeded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["payment","attemptStatus"]>>().toEqualTypeOf<"created" | "expired" | "failed" | "cancelled" | "requires_action" | "processing" | "succeeded" | "blocked_preflight" | "sent_to_provider" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["failureReason"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["input"], ["failureDisplay"]>>().toEqualTypeOf<"expired" | "cancelled" | "card_declined" | "blik_recurring_unsupported_bank" | "provider_declined" | "technical" | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout.v2">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["orderId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["paymentIntentId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["status"]>>().toEqualTypeOf<"expired" | "paid" | "failed" | "requires_action" | "processing" | "pending_provider_action">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["orderStatus"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["payment","intentStatus"]>>().toEqualTypeOf<"created" | "expired" | "failed" | "cancelled" | "refunded" | "requires_action" | "processing" | "partially_refunded" | "disputed" | "succeeded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["payment","attemptStatus"]>>().toEqualTypeOf<"created" | "expired" | "failed" | "cancelled" | "requires_action" | "processing" | "succeeded" | "blocked_preflight" | "sent_to_provider" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["failureReason"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["checkout.paymentStatusResponseSchema"]["output"], ["failureDisplay"]>>().toEqualTypeOf<"expired" | "cancelled" | "card_declined" | "blik_recurring_unsupported_bank" | "provider_declined" | "technical" | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeTokenSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeTokenSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeSectionIdSchema"]["input"], []>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeSectionIdSchema"]["output"], []>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeRedactedFieldSchema"]["input"], []>>().toEqualTypeOf<"contact" | "pet_identity" | "shipping_address" | "billing_address" | "delivery_notes" | "courier_instructions" | "payment_provider" | "payment_secret" | "raw_form_payload">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeRedactedFieldSchema"]["output"], []>>().toEqualTypeOf<"contact" | "pet_identity" | "shipping_address" | "billing_address" | "delivery_notes" | "courier_instructions" | "payment_provider" | "payment_secret" | "raw_form_payload">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeModeSchema"]["input"], []>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeModeSchema"]["output"], []>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["version"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription" | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["cart","items",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["completion","petProfile"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["input"], ["completion","productSelection"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["version"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["cadenceDays"]>>().toEqualTypeOf<number | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["cart","items",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["completion","petProfile"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftStateSchema"]["output"], ["completion","productSelection"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["draftState","completion","petProfile"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["draftState","completion","productSelection"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["resumeToken"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["input"], ["ttlMinutes"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["draftState","completion","petProfile"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["draftState","completion","productSelection"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["ttlMinutes"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["resumeToken"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertRequestSchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadRequestSchema"]["input"], ["resumeToken"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadRequestSchema"]["output"], ["resumeToken"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["draftState","completion","petProfile"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["draftState","completion","productSelection"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["expiresAt"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["createdAt"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["updatedAt"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["input"], ["replayed"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["id"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["draftState","completion","petProfile"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["draftState","completion","productSelection"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["expiresAt"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["createdAt"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["updatedAt"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeDraftSchema"]["output"], ["replayed"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["resumeToken"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["draft","lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["draft","draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["draft","draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["draft","draftState","completion","petProfile"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["input"], ["draft","draftState","completion","productSelection"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["resumeToken"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["draft","lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["draft","draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["draft","draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["draft","draftState","completion","petProfile"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeUpsertResponseSchema"]["output"], ["draft","draftState","completion","productSelection"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["input"], ["draft","lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["input"], ["draft","draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["input"], ["draft","draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["input"], ["draft","draftState","completion","petProfile"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["input"], ["draft","draftState","completion","productSelection"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.checkout_resume.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["output"], ["draft","lastSectionId"]>>().toEqualTypeOf<"shipping" | "payment" | "account" | "start" | "pet_profile" | "product_selection" | "cadence" | "billing" | "review">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["output"], ["draft","draftState","cart","items",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["output"], ["draft","draftState","cart","items",0,"productSlug"]>>().toEqualTypeOf<string | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["output"], ["draft","draftState","completion","petProfile"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["resume.checkoutResumeReadResponseSchema"]["output"], ["draft","draftState","completion","productSelection"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["version"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["selectedVariants",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["cadencePolicyVersion"]>>().toEqualTypeOf<"commerce.configurator_fixed_cadence_14_21_28.v1" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["recommendationSnapshot","lines",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["recommendationSnapshot","allergenConflicts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["recommendationSnapshot","excludedProducts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["recommendationSnapshot","suggestedVariants",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["input"], ["consciousAllergenOverride"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["version"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["locale"]>>().toEqualTypeOf<"pl" | "en">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["cadenceDays"]>>().toEqualTypeOf<number | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["selectedVariants",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["consciousAllergenOverride"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["cadencePolicyVersion"]>>().toEqualTypeOf<"commerce.configurator_fixed_cadence_14_21_28.v1" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["recommendationSnapshot","lines",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["recommendationSnapshot","allergenConflicts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["recommendationSnapshot","excludedProducts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceRequestSchema"]["output"], ["recommendationSnapshot","suggestedVariants",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentClientMatchReasonSchema"]["input"], []>>().toEqualTypeOf<"client_created" | "client_match_exact_email" | "client_match_plus_normalized_fallback">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentClientMatchReasonSchema"]["output"], []>>().toEqualTypeOf<"client_created" | "client_match_exact_email" | "client_match_plus_normalized_fallback">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["contractVersion"]>>().toEqualTypeOf<"commerce.configurator_intent_persistence.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["intentVersion"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["clientId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["petId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["addressId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["replayed"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["input"], ["clientMatchReason"]>>().toEqualTypeOf<"client_created" | "client_match_exact_email" | "client_match_plus_normalized_fallback" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["contractVersion"]>>().toEqualTypeOf<"commerce.configurator_intent_persistence.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["intentVersion"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["clientId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["petId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["addressId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["replayed"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["persistence.configuratorIntentPersistenceResponseSchema"]["output"], ["clientMatchReason"]>>().toEqualTypeOf<"client_created" | "client_match_exact_email" | "client_match_plus_normalized_fallback" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsRedactedFieldSchema"]["input"], []>>().toEqualTypeOf<"contact" | "shipping_address" | "billing_address" | "delivery_notes" | "courier_instructions" | "payment_provider" | "payment_secret" | "orderer_profile">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsRedactedFieldSchema"]["output"], []>>().toEqualTypeOf<"contact" | "shipping_address" | "billing_address" | "delivery_notes" | "courier_instructions" | "payment_provider" | "payment_secret" | "orderer_profile">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["input"], ["version"]>>().toEqualTypeOf<"commerce.customer_defaults_snapshot.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["input"], ["clientId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["input"], ["payment","scope"]>>().toEqualTypeOf<"one_time" | "subscription" | "any" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["input"], ["payment","methodKind"]>>().toEqualTypeOf<"blik" | "card" | "transfer" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["output"], ["version"]>>().toEqualTypeOf<"commerce.customer_defaults_snapshot.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["output"], ["clientId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["output"], ["payment","scope"]>>().toEqualTypeOf<"one_time" | "subscription" | "any" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["defaults.commerceCustomerDefaultsSnapshotSchema"]["output"], ["payment","methodKind"]>>().toEqualTypeOf<"blik" | "card" | "transfer" | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityStatusSchema"]["input"], []>>().toEqualTypeOf<"unknown" | "available" | "low_stock" | "out_of_stock">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityStatusSchema"]["output"], []>>().toEqualTypeOf<"unknown" | "available" | "low_stock" | "out_of_stock">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySourceSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySourceSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["input"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["input"], ["productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["input"], ["variantId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["input"], ["requestedQuantity"]>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["input"], ["checkoutMode"]>>().toEqualTypeOf<"one_time" | "subscription" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["output"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["output"], ["productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["output"], ["variantId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["output"], ["requestedQuantity"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilityRequestItemSchema"]["output"], ["checkoutMode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["variantId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["status"]>>().toEqualTypeOf<"unknown" | "available" | "low_stock" | "out_of_stock">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["visibleInConfigurator"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["sellableNow"]>>().toEqualTypeOf<number | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["reasonCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["input"], ["source"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["productSlug"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["variantId"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["status"]>>().toEqualTypeOf<"unknown" | "available" | "low_stock" | "out_of_stock">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["visibleInConfigurator"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["sellableNow"]>>().toEqualTypeOf<number | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["reasonCode"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["availability.commerceOfferAvailabilitySchema"]["output"], ["source"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorPetAgeBandSchema"]["input"], []>>().toEqualTypeOf<"puppy" | "young" | "adult" | "senior">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorPetAgeBandSchema"]["output"], []>>().toEqualTypeOf<"puppy" | "young" | "adult" | "senior">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorActivityLevelSchema"]["input"], []>>().toEqualTypeOf<"low" | "normal" | "high">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorActivityLevelSchema"]["output"], []>>().toEqualTypeOf<"low" | "normal" | "high">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorBcsSchema"]["input"], []>>().toEqualTypeOf<"thin" | "ideal" | "overweight">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorBcsSchema"]["output"], []>>().toEqualTypeOf<"thin" | "ideal" | "overweight">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorModeSchema"]["input"], []>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorModeSchema"]["output"], []>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorCadenceDaysSchema"]["input"], []>>().toEqualTypeOf<28 | 14 | 21>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorCadenceDaysSchema"]["output"], []>>().toEqualTypeOf<28 | 14 | 21>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorDeliveryKindSchema"]["input"], []>>().toEqualTypeOf<"parcel-locker" | "courier">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorDeliveryKindSchema"]["output"], []>>().toEqualTypeOf<"parcel-locker" | "courier">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorPaymentMethodSchema"]["input"], []>>().toEqualTypeOf<"blik" | "card" | "transfer">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorPaymentMethodSchema"]["output"], []>>().toEqualTypeOf<"blik" | "card" | "transfer">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorAllergenSlugSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorAllergenSlugSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["input"], ["kind"]>>().toEqualTypeOf<"unit_count" | "total_weight_g" | "feeding_days">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["input"], ["value"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["input"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["output"], ["kind"]>>().toEqualTypeOf<"unit_count" | "total_weight_g" | "feeding_days">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["output"], ["value"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorSizeConstraintSchema"]["output"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["version"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["selectedVariants",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["cadencePolicyVersion"]>>().toEqualTypeOf<"commerce.configurator_fixed_cadence_14_21_28.v1" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["locale"]>>().toEqualTypeOf<"pl" | "en" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["cadenceDays"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["recommendationSnapshot","lines",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["recommendationSnapshot","allergenConflicts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["recommendationSnapshot","excludedProducts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["recommendationSnapshot","suggestedVariants",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["input"], ["consciousAllergenOverride"]>>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["version"]>>().toEqualTypeOf<"commerce.configurator_intent.v1">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["idempotencyKey"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["locale"]>>().toEqualTypeOf<"pl" | "en">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["mode"]>>().toEqualTypeOf<"one_time" | "subscription">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["cadenceDays"]>>().toEqualTypeOf<number | null>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["selectedVariants",0,"sku"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["consciousAllergenOverride"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["cadencePolicyVersion"]>>().toEqualTypeOf<"commerce.configurator_fixed_cadence_14_21_28.v1" | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["visitorId"]>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["recommendationSnapshot","lines",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["recommendationSnapshot","allergenConflicts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["recommendationSnapshot","excludedProducts",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["intent.configuratorIntentSchema"]["output"], ["recommendationSnapshot","suggestedVariants",0,"sku"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceCurrencySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceCurrencySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceTaxCountrySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceTaxCountrySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceTaxCategorySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceTaxCategorySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceTaxLegalBasisSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceTaxLegalBasisSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.cartStatusSchema"]["input"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.cartStatusSchema"]["output"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.checkoutStatusSchema"]["input"], []>>().toEqualTypeOf<"not_configured" | "created" | "expired">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.checkoutStatusSchema"]["output"], []>>().toEqualTypeOf<"not_configured" | "created" | "expired">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.orderDraftStatusSchema"]["input"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.orderDraftStatusSchema"]["output"], []>>().toEqualTypeOf<"draft">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.orderStatusSchema"]["input"], []>>().toEqualTypeOf<"draft" | "expired" | "pending_payment" | "paid" | "failed" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.orderStatusSchema"]["output"], []>>().toEqualTypeOf<"draft" | "expired" | "pending_payment" | "paid" | "failed" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.paymentStatusSchema"]["input"], []>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.paymentStatusSchema"]["output"], []>>().toEqualTypeOf<"expired" | "paid" | "failed" | "refunded" | "not_started" | "requires_action" | "processing" | "partially_refunded" | "disputed">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceProductSlugSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceProductSlugSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceIdempotencyKeySchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceIdempotencyKeySchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSkuSchema"]["input"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSkuSchema"]["output"], []>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceMoneySchema"]["input"], ["amountMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceMoneySchema"]["input"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceMoneySchema"]["output"], ["amountMinor"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceMoneySchema"]["output"], ["currency"]>>().toEqualTypeOf<string>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["input"], ["kind"]>>().toEqualTypeOf<"unit_count" | "total_weight_g" | "feeding_days">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["input"], ["value"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["input"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["input"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["output"], ["kind"]>>().toEqualTypeOf<"unit_count" | "total_weight_g" | "feeding_days">();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["output"], ["value"]>>().toEqualTypeOf<number>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["output"], ["petId"]>>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<ReferenceField<ReferenceSchemaTypes["primitives.commerceSizeConstraintSchema"]["output"], ["dailyKcalOverride"]>>().toEqualTypeOf<number | null | undefined>();
});

it.each([{ minimumUnits: 1 }, { offerVersion: "example.v1" }])("refuses even a full basket's offer ask without a server binding: %j", async ask => {
  const status = vi.fn(), json = vi.fn();
  const res = { setHeader: vi.fn(), status, json } as unknown as HttpResponse;
  status.mockReturnValue(res);
  const checkRateLimit = vi.fn(async () => ({ allowed: true }));
  const result = await admitCheckoutRequest({ req: { method: "POST", headers: {}, body: { intent: { ...baseIntent, ...ask } } },
    res, deps: { checkRateLimit, rateLimitMessage: () => "limited" }, record: async (_stage, operation) => operation() });
  expect(result).toEqual({ kind: "responded", outcome: "rejected" });
  expect(status).toHaveBeenCalledWith(400);
  expect(json).toHaveBeenCalledWith({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid checkout request",
    details: { formErrors: [], fieldErrors: { intent: ["offer_version_unsupported"] } } } });
  expect(checkRateLimit).not.toHaveBeenCalled();
});

it("preserves the existing pricing option and quote-port types at the reference binding", () => {
  type Existing = import("@openlup/platform/pricing").CreateQuoteOptions;
  type Options = import("./ports.js").CreateQuoteOptions;
  type Port = import("./ports.js").CommerceQuotePort;
  expectTypeOf<Options>().toEqualTypeOf<Existing & { offerVersion?: string }>();
  expectTypeOf<Options["clientId"]>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<NonNullable<Options["pricingPolicy"]>>().toEqualTypeOf<import("@openlup/platform/pricing/contracts").PricingPolicySnapshot>();
  expectTypeOf<Parameters<Port["createQuote"]>[0]>().toEqualTypeOf<contracts.CreateQuoteRequest>();
  expectTypeOf<Awaited<ReturnType<Port["createQuote"]>>>().toEqualTypeOf<contracts.CreateQuoteResponse>();
});


// Captured from scratch imports of BASE dbcfe646, including transitive sources.
// Refinement audit inputs: valid surrounding fields let nonfatal field errors
// and object checks run together; invalid types also exercise their abort boundary.
const refinementInputs: Array<[string, unknown[]]> = [];
const refinementIntentInputs: unknown[] = [];
for (const mode of ["one_time", "subscription", "unknown"]) {
  for (const cadencePolicyVersion of [undefined, intent.CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION, "unknown"]) {
    for (const cadenceDays of [undefined, null, 0, -1, 1.5, 20, 21, "invalid"]) {
      for (const fields of [
        {},
        { selectedVariants: [{ ...baseIntent.selectedVariants[0], qty: 1, flavorSlug: "item-b" }] },
        { idempotencyKey: "!", promoCodes: [""], sizeConstraint: { kind: "feeding_days", value: 0, dailyKcalOverride: 0 } },
        { locale: "xx", promoCodes: [0] },
        { contact: { ...baseIntent.contact, email: "invalid", phone: "" }, selectedVariants: [{ ...baseIntent.selectedVariants[0], qty: 0 }] },
        { sizeConstraint: { kind: "unit_count", value: -1 }, promoCodes: Array.from({ length: 21 }, () => "") },
      ]) {
        refinementIntentInputs.push({ ...baseIntent, mode, cadencePolicyVersion, cadenceDays, ...fields });
      }
    }
  }
}
refinementInputs.push(["intent.configuratorIntentSchema", refinementIntentInputs]);
refinementInputs.push(["persistence.configuratorIntentPersistenceRequestSchema", refinementIntentInputs]);
refinementInputs.push(["checkout.checkoutRequestSchema", refinementIntentInputs.flatMap((input) => [
  { intent: input },
  { intent: input, paymentProvider: embeddedProvider, paymentExecution: { provider: interactiveProvider, flow: "redirect" } },
  { intent: input, paymentAttemptSequence: -1, declaredBankId: "!", expectedQuote: { totalGross: { amountMinor: -1, currency: PLATFORM_ACCEPTED_CURRENCIES[0] } } },
  { intent: input, invoicePreference: { kind: "b2b_vat", companyName: "", taxId: "invalid", email: "invalid", address: { line1: "", city: "", postalCode: "", country: hostCountry } } },
])]);

const refinementId = "11111111-1111-4111-8111-111111111111";
const refinementOtherId = "22222222-2222-4222-8222-222222222222";
const refinementTime = new Date(0).toISOString();
const refinementResponseInputs: unknown[] = [];
for (const checkoutKind of ["one_time", "subscription_initial"]) {
  for (const cadenceDays of [null, 0, -1, 21, "invalid"]) {
    for (const requested of [false, true]) {
      for (const requiresReusablePaymentMethod of [undefined, false, true]) {
        for (const fields of [{}, { orderRef: "invalid", statusUrl: "", providerPaymentId: "" }]) {
          refinementResponseInputs.push({ contractVersion: checkout.CHECKOUT_CONTRACT_VERSION, checkoutKind,
            orderRef: `order_${refinementId}`, orderId: refinementId, status: "paid",
            subscription: { requested, cadenceDays, activationStatus: "pending_payment_success" },
            ...(requiresReusablePaymentMethod === undefined ? {} : { payment: { requiresReusablePaymentMethod } }), ...fields });
        }
      }
    }
  }
}
refinementResponseInputs.push({ contractVersion: checkout.CHECKOUT_CONTRACT_VERSION, checkoutKind: "subscription_initial",
  orderRef: `order_${refinementId}`, orderId: refinementId, status: "paid" });
refinementInputs.push(["checkout.checkoutResponseSchema", refinementResponseInputs]);
refinementInputs.push(["checkout.checkoutInvoicePreferenceSchema", [
  { kind: "b2b_vat", companyName: "", taxId: "", email: "invalid", contactName: "", address: { line1: "", city: "", postalCode: "", country: hostCountry } },
  { kind: "b2b_vat", companyName: "Example", taxId: "invalid", address: {} },
  { kind: "b2b_vat", companyName: "Example", taxId: "123", address: { line1: "Example 1", city: "Example", postalCode: "00000", country: hostCountry } },
]]);

const refinementResumeInputs: unknown[] = [];
for (const mode of [null, "one_time", "subscription", "unknown"]) {
  for (const cadenceDays of [undefined, null, 0, -1, 1.5, 21, "invalid"]) {
    for (const fields of [
      {},
      { cart: { items: [{ sku: "", quantity: 0, variantId: "" }] } },
      { completion: { cadence: "invalid" }, redactedFields: Array.from({ length: 21 }, () => "contact") },
      { cart: { items: [{ sku: "ITEM-A", quantity: 0, providerPayload: {} }] }, email: "buyer@example.test" },
    ]) refinementResumeInputs.push({ version: resume.CHECKOUT_RESUME_CONTRACT_VERSION, mode, cadenceDays, completion: {}, ...fields });
  }
}
refinementInputs.push(["resume.checkoutResumeDraftStateSchema", refinementResumeInputs]);
refinementInputs.push(["resume.checkoutResumeUpsertRequestSchema", refinementResumeInputs.flatMap((draftState) => [
  { draftState, lastSectionId: "cadence" },
  { draftState, lastSectionId: "cadence", resumeToken: "!", idempotencyKey: "!", ttlMinutes: 0 },
])]);
const refinementDefaults = { version: defaults.CUSTOMER_DEFAULTS_SNAPSHOT_VERSION, clientId: refinementId,
  payment: { available: false, scope: null, methodKind: null, source: "customer_payment_preferences", applied: false },
  addresses: { hasDefaultShippingAddress: false, defaultShippingAddressId: null, hasDefaultBillingAddress: false,
    defaultBillingAddressId: null, hasDefaultOrdererProfile: false, defaultOrdererProfileId: null,
    hasDeliveryNotes: false, hasCourierInstructions: false, source: "customer_address_profiles", applied: false } };
refinementInputs.push(["defaults.commerceCustomerDefaultsSnapshotSchema", [
  refinementDefaults,
  { ...refinementDefaults, clientId: "invalid", payment: { ...refinementDefaults.payment, scope: "unknown", methodKind: "unknown" } },
  { ...refinementDefaults, email: "buyer@example.test", payment: { ...refinementDefaults.payment, providerPayload: {}, card: "opaque" }, addresses: { ...refinementDefaults.addresses, street: "Example" } },
  { ...refinementDefaults, payment: { ...refinementDefaults.payment, available: "invalid", applied: true }, addresses: { ...refinementDefaults.addresses, defaultShippingAddressId: "invalid" }, redactedFields: ["unknown"] },
]]);
refinementInputs.push(["contracts.createCheckoutResponseSchema", ["created", "not_configured"].flatMap((status) => [
  { contractVersion: "commerce.v0", checkout: { id: "checkout_a", cartId: "cart_a", status, redirectUrl: null, paymentProviderSessionId: "session-a" } },
  { contractVersion: "commerce.v0", checkout: { id: "!", cartId: "!", status, redirectUrl: null, paymentProviderSessionId: "" } },
])]);
refinementInputs.push(["persistence.configuratorIntentPersistenceResponseSchema", [
  { contractVersion: persistence.CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION, intentVersion: intent.CONFIGURATOR_INTENT_VERSION, idempotencyKey: "!", clientId: "invalid", petId: "invalid", addressId: "invalid", replayed: true },
]]);
refinementInputs.push(["availability.commerceOfferAvailabilityRequestItemSchema", [
  { sku: "", productSlug: "!", variantId: "", requestedQuantity: 0, checkoutMode: "subscription" },
  { sku: 0, productSlug: 0, variantId: 0, requestedQuantity: "invalid", checkoutMode: "unknown" },
]]);

const refinementQuote = { contractVersion: "commerce.v0", quote: { currency: PLATFORM_ACCEPTED_CURRENCIES[0], taxIncluded: true,
  lines: [{ sku: "ITEM-A", productSlug: "item-a", quantity: 1, unitPriceGross: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] },
    lineSubtotalGross: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] },
    tax: { included: true, country: hostCountry, category: "generic", vatRateBps: 0,
      legalBasis: "example", netAmount: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] },
      vatAmount: { amountMinor: 0, currency: PLATFORM_ACCEPTED_CURRENCIES[0] }, grossAmount: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] } } }],
  discounts: [], subtotalGross: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] }, discountTotalGross: { amountMinor: 0, currency: PLATFORM_ACCEPTED_CURRENCIES[0] },
  totalGross: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] }, netTotal: { amountMinor: 100, currency: PLATFORM_ACCEPTED_CURRENCIES[0] }, taxTotal: { amountMinor: 0, currency: PLATFORM_ACCEPTED_CURRENCIES[0] } } };
const refinementDraft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
  currency: refinementQuote.quote.currency, taxIncluded: true, lines: refinementQuote.quote.lines, discounts: [],
  totals: { subtotalGross: refinementQuote.quote.subtotalGross, discountTotalGross: refinementQuote.quote.discountTotalGross,
    totalGross: refinementQuote.quote.totalGross, netTotal: refinementQuote.quote.netTotal, taxTotal: refinementQuote.quote.taxTotal } };
const refinementPayload = { orderId: `order_${refinementId}`, orderUuid: refinementId, quoteSnapshot: refinementQuote, orderDraftSnapshot: refinementDraft };
const refinementPayloadInputs = [refinementPayload,
  { ...refinementPayload, orderId: `order_${refinementOtherId}`, orderDraftSnapshot: { ...refinementDraft, totals: { ...refinementDraft.totals, totalGross: { ...refinementDraft.totals.totalGross, amountMinor: 1 } } } },
  { ...refinementPayload, orderId: "invalid", quoteSnapshot: { ...refinementQuote, quote: { ...refinementQuote.quote, totalGross: { ...refinementQuote.quote.totalGross, amountMinor: -1 } } } },
];
refinementInputs.push(["outbox.commerceOrderDraftCreatedPayloadSchema", refinementPayloadInputs]);
const refinementRecord = { id: refinementId, created_at: refinementTime, available_at: refinementTime, processed_at: null,
  aggregate_type: "commerce_order", aggregate_id: refinementOtherId, event_type: outbox.COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
  idempotency_key: "!", status: "pending", attempts: -1, error: null, metadata: {} };
refinementInputs.push(["outbox.commerceOrderDraftCreatedOutboxRecordSchema", refinementPayloadInputs.map((payload) => ({ ...refinementRecord, payload }))]);
refinementInputs.push(["outbox.commerceOrderDraftCreatedEventSchema", refinementPayloadInputs.map((payload) => ({
  contractVersion: outbox.COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION, id: refinementId, createdAt: refinementTime,
  availableAt: refinementTime, processedAt: null, aggregateType: "commerce_order", aggregateId: refinementOtherId,
  eventType: outbox.COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, idempotencyKey: "!", status: "pending", attempts: -1,
  payload, error: null, metadata: {} }))]);
const refinementPaidPayloads = [
  { orderId: `order_${refinementOtherId}`, orderUuid: refinementId, mode: "", occurredAt: "invalid" },
  { orderId: "invalid", orderUuid: refinementId, mode: "one_time", occurredAt: refinementTime },
];
refinementInputs.push(["outbox.commerceOrderPaidPayloadSchema", refinementPaidPayloads]);
refinementInputs.push(["outbox.commerceOrderPaidOutboxRecordSchema", refinementPaidPayloads.map((payload) => ({ ...refinementRecord,
  event_type: outbox.COMMERCE_ORDER_PAID_EVENT_TYPE, payload }))]);
// End refinement audit inputs.

const refinementGoldens: Record<string, [number, string]> = {
  "intent.configuratorIntentSchema": [
    432,
    "4b7ad5ef5bdbbea502c179658d34d99e1dc2178b16dd96f1de1e12907707c0a0"
  ],
  "persistence.configuratorIntentPersistenceRequestSchema": [
    432,
    "4b7ad5ef5bdbbea502c179658d34d99e1dc2178b16dd96f1de1e12907707c0a0"
  ],
  "checkout.checkoutRequestSchema": [
    1728,
    "5aa89f56356df4e38c83cf76d1e1362f2d92b520be053ded6a8abf3991a61e7f"
  ],
  "checkout.checkoutResponseSchema": [
    121,
    "8571fe83d3352d2324592e0394fd069a30f77c7a95599bf71f7f62b3c2dc11b9"
  ],
  "checkout.checkoutInvoicePreferenceSchema": [
    3,
    "e79820c9e82c52e706144e2c04b41d377c484f964339e02e5aca7cd12933cf18"
  ],
  "resume.checkoutResumeDraftStateSchema": [
    112,
    "b24c8342c546bb5a95517405edfc066f9d4cd743bc7e1b9ad92ffe96dd211b9f"
  ],
  "resume.checkoutResumeUpsertRequestSchema": [
    224,
    "f0bb60d8617ff32adeec0bdfee59f2c1b0ddc4f5af99f403fad8cb768e68a00a"
  ],
  "defaults.commerceCustomerDefaultsSnapshotSchema": [
    4,
    "481be3bd3f7d243159ffc47750ddc1acc165ecdaf9f8562bfc7b46b6af1bb476"
  ],
  "contracts.createCheckoutResponseSchema": [
    4,
    "d6b50b707c36794631e9f5b9f604e605b30f2187f6ff8179aae093d48ff76970"
  ],
  "persistence.configuratorIntentPersistenceResponseSchema": [
    1,
    "75ed5b9c7c7753adc717a134c61569e757bf5a8256f1ccd186a4ec8eda27ec33"
  ],
  "availability.commerceOfferAvailabilityRequestItemSchema": [
    2,
    "3cb600b1400080628e995889dbebc82ba26c51a2d08db26b3d02ddfec2ad7709"
  ],
  "outbox.commerceOrderDraftCreatedPayloadSchema": [
    3,
    "0f485857946ff1cc2b8a192a6302eec8929c53155652437211e7bad1c4e442d4"
  ],
  "outbox.commerceOrderDraftCreatedOutboxRecordSchema": [
    3,
    "5e2748d0ac61e2d11a96fc0e7c73562915de40fa45e37497af8d7e8a8c99fbd1"
  ],
  "outbox.commerceOrderDraftCreatedEventSchema": [
    3,
    "f42a0016da807074977757c67bd4d52c89ebe96dd5975d1bba5078198d99120d"
  ],
  "outbox.commerceOrderPaidPayloadSchema": [
    2,
    "1c16b6bf8b75cf9860312d8786b822642ab886a267e05531a959d80dba3b4001"
  ],
  "outbox.commerceOrderPaidOutboxRecordSchema": [
    2,
    "95203fd77c1b0108a9521abea533dcf6bf2d8aa9989c4bda68eee75a060a2271"
  ]
};

it.each(refinementInputs)("preserves BASE simultaneous field/refinement issue order: %s", (name, inputs) => {
  const [moduleName, schemaName] = name.split(".");
  const schema = (auditModules[moduleName as keyof typeof auditModules] as Record<string, z.ZodType>)[schemaName];
  const digest = createHash("sha256");
  for (const input of inputs) {
    const result = schema.safeParse(input);
    digest.update(JSON.stringify(result.success ? { success: true, data: result.data } : { success: false, issues: result.error.issues }) + "\n");
  }
  expect([inputs.length, digest.digest("hex")]).toEqual(refinementGoldens[name]);
});

it.each(refinementInputs.slice(0, 3))("preserves BASE issue order with approved offer asks: %s", (name, inputs) => {
  const [moduleName, schemaName] = name.split(".");
  const schema = (auditModules[moduleName as keyof typeof auditModules] as Record<string, z.ZodType>)[schemaName];
  const digest = createHash("sha256");
  for (const input of inputs) {
    const request = input as Record<string, unknown>;
    const addOffer = (value: unknown) => ({ ...value as object, minimumUnits: 14, offerVersion: "offer-a.v2" });
    const result = schema.safeParse(moduleName === "checkout" ? { ...request, intent: addOffer(request.intent) } : addOffer(request));
    // Only the approved additive output fields differ. Full failures, including
    // refinement order, must still equal the unmodified BASE transcript.
    const removeOffer = (value: Record<string, unknown>) => {
      const { minimumUnits: _minimumUnits, offerVersion: _offerVersion, ...legacy } = value;
      return legacy;
    };
    const data = result.success ? result.data as Record<string, unknown> : undefined;
    const legacyData = data && (moduleName === "checkout"
      ? { ...data, intent: removeOffer(data.intent as Record<string, unknown>) } : removeOffer(data));
    digest.update(JSON.stringify(result.success ? { success: true, data: legacyData } : { success: false, issues: result.error.issues }) + "\n");
  }
  expect([inputs.length, digest.digest("hex")]).toEqual(refinementGoldens[name]);
});

it("keeps approved offer-field bounds alongside simultaneous cadence refinements", () => {
  for (const minimumUnits of [undefined, 0, 1, 14, 99, 100, "invalid"]) {
    for (const offerVersion of [undefined, "offer-a.v2", "INVALID", "a".repeat(41)]) {
      const fields = { ...baseIntent, minimumUnits, offerVersion,
        selectedVariants: [{ ...baseIntent.selectedVariants[0], qty: 1 }] };
      const validAsk = minimumUnits === 1 && (offerVersion === undefined || offerVersion === "offer-a.v2");
      expect(intent.configuratorIntentSchema.safeParse(fields).success).toBe(validAsk);
      const result = intent.configuratorIntentSchema.safeParse({ ...fields, mode: "subscription",
        cadencePolicyVersion: intent.CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION, cadenceDays: 0 });
      expect(result.success).toBe(false);
      if (!result.success && minimumUnits !== "invalid") {
        expect(result.error.issues.filter((issue) => issue.path[0] === "cadenceDays").map((issue) => issue.message))
          .toEqual(["Too small: expected number to be >0", "subscription intent requires cadenceDays",
            "fixed-cadence configurator intents require a 14, 21 or 28 day cadence"]);
      }
    }
  }
});

it("reports numeric, subscription, then fixed-cadence errors in BASE order", () => {
  const result = intent.configuratorIntentSchema.safeParse({ ...baseIntent, mode: "subscription",
    cadencePolicyVersion: intent.CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION, cadenceDays: 0 });
  expect(result.success ? { success: true, data: result.data } : { success: false, issues: result.error.issues })
    .toEqual({
  "success": false,
  "issues": [
    {
      "origin": "number",
      "code": "too_small",
      "minimum": 0,
      "inclusive": false,
      "path": [
        "cadenceDays"
      ],
      "message": "Too small: expected number to be >0"
    },
    {
      "code": "custom",
      "message": "subscription intent requires cadenceDays",
      "path": [
        "cadenceDays"
      ]
    },
    {
      "code": "custom",
      "message": "fixed-cadence configurator intents require a 14, 21 or 28 day cadence",
      "path": [
        "cadenceDays"
      ]
    }
  ]
});
});
