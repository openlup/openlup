import { describe, expect, it } from "vitest";
import {
  BRAND_SENDER_ENV_NAMES,
  readBrandConfig,
  readBrandFromEmail,
} from "./readBrandConfig.js";
import {
  APP_BRAND_NAME,
  APP_DEFAULT_SELLER,
  APP_EMAIL_BRAND,
  APP_FROM_EMAIL,
  APP_ORDER_REF_PREFIX,
  APP_PRODUCTION_EMAIL_HOSTS,
  APP_REPLY_TO_EMAIL,
  APP_SITE_ORIGIN,
  APP_SUPPORT_EMAIL,
} from "./appBrand.js";

describe("readBrandConfig", () => {
  it("returns the static brand identity with seller defaults when env is empty", () => {
    const brand = readBrandConfig({});
    expect(brand).toMatchObject({
      brandName: APP_BRAND_NAME,
      supportEmail: APP_SUPPORT_EMAIL,
      siteOrigin: APP_SITE_ORIGIN,
      productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
      orderRefPrefix: APP_ORDER_REF_PREFIX,
      fromEmail: APP_FROM_EMAIL,
      replyToEmail: APP_REPLY_TO_EMAIL,
    });
    expect(brand.seller).toMatchObject(APP_DEFAULT_SELLER);
    expect(brand.email.copyBrandName).toBe("OPENLUP");
    expect(brand.email.copyBrandNameCased).toBe("openlup");
    expect(brand.email.theme.logoText).toBe("openlup");
  });

  it("overlays ACCOUNTING_SELLER_* env onto the seller defaults", () => {
    const brand = readBrandConfig({
      ACCOUNTING_SELLER_NAME: "Acme Commerce Sp. z o.o.",
      ACCOUNTING_SELLER_NIP: "1234563218",
      FAKTUROWNIA_DEPARTMENT_ID: "dep-123",
    });
    expect(brand.seller.name).toBe("Acme Commerce Sp. z o.o.");
    expect(brand.seller.taxId).toBe("1234563218");
    expect(brand.seller.departmentId).toBe("dep-123");
    // Unset fields still fall back to the brand defaults.
    expect(brand.seller.city).toBe(APP_DEFAULT_SELLER.city);
  });

  it("defaults to an empty env when called with no argument", () => {
    expect(readBrandConfig().seller).toMatchObject(APP_DEFAULT_SELLER);
  });
});

describe("sender identity seam", () => {
  // Regression control for the seam: the env every deployment actually sets
  // today must resolve to exactly what the call sites hard-coded before the
  // seam existed. If this value ever moves, mail changes sender in production.
  it("keeps the sender unchanged for the env shape deployments use today", () => {
    // Pins the composed default against the constants it is built from, and
    // against the shape every call site's literal had: display label, one
    // space, then the mailbox in angle brackets, nothing else.
    expect(APP_FROM_EMAIL).toBe(`${APP_EMAIL_BRAND.copyBrandName} <${APP_SUPPORT_EMAIL}>`);
    expect(APP_FROM_EMAIL).toMatch(/^\S+ <[^@\s]+@[^@\s]+>$/);
    expect(readBrandConfig({}).fromEmail).toBe(APP_FROM_EMAIL);
    expect(readBrandConfig({ ACCOUNTING_SELLER_NAME: "Acme" }).fromEmail).toBe(APP_FROM_EMAIL);
    expect(readBrandFromEmail()).toBe(APP_FROM_EMAIL);
  });

  it("resolves the sender from every supported env name", () => {
    for (const name of BRAND_SENDER_ENV_NAMES) {
      expect(readBrandConfig({ [name]: "Sender <a@example.test>" }).fromEmail).toBe(
        "Sender <a@example.test>",
      );
    }
  });

  // Cases address the names through BRAND_SENDER_ENV_NAMES rather than repeating
  // them as literals, so the list stays the single source of truth for which
  // names exist. Order is pinned even while the list holds a single name: the
  // next name appended must not displace this one.
  it("resolves the shared name first", () => {
    expect(BRAND_SENDER_ENV_NAMES[0]).toBe("FROM_EMAIL");
    const env = Object.fromEntries(
      BRAND_SENDER_ENV_NAMES.map((name, index) => [name, `Sender${index} <s${index}@example.test>`]),
    );
    expect(readBrandConfig(env).fromEmail).toBe("Sender0 <s0@example.test>");
  });

  it("falls through a blank override instead of composing an empty sender", () => {
    for (const name of BRAND_SENDER_ENV_NAMES) {
      expect(readBrandFromEmail({ [name]: "   " })).toBe(APP_FROM_EMAIL);
      expect(readBrandFromEmail({ [name]: "" })).toBe(APP_FROM_EMAIL);
    }
  });

  it("trims a padded override so the composed header stays well-formed", () => {
    expect(readBrandFromEmail({ FROM_EMAIL: "  Sender <a@example.test>  " })).toBe(
      "Sender <a@example.test>",
    );
  });

  it("exposes a reply-to address that is a bare mailbox, not a display form", () => {
    const brand = readBrandConfig({});
    expect(brand.replyToEmail).toBe(APP_SUPPORT_EMAIL);
    expect(brand.replyToEmail).not.toContain("<");
  });
});
