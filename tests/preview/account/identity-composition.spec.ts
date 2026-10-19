import { env as processEnvironment } from "node:process";
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("customer and operator mounts preserve linked profiles, reload sessions and clear logout", async ({ page, request, baseURL }) => {
  // Credential-bearing actions are wrapped so a failure does not print callback URLs or tokens.
  try {
    const directory = processEnvironment.OPENLUP_IDENTITY_RUN_DIR;
    if (!directory) throw new Error("Owned identity installation required");
    const input = JSON.parse(readFileSync(join(directory, "browser-input.json"), "utf8"));
    const owner = JSON.parse(readFileSync(join(directory, "identity-owner.json"), "utf8"));
    expect(baseURL === owner.origin && owner.runId === processEnvironment.OPENLUP_IDENTITY_RUN_ID).toBe(true);
    const mailbox = join(directory, "mailbox");
    const localIds = () => new Set(readdirSync(mailbox));
    async function localChallenge(kind: string, email: string, before: Set<string>) {
      let captured: { challenge?: { token: string }; callback?: string } | undefined;
      await expect.poll(() => {
        captured = readdirSync(mailbox).filter(name => !before.has(name)).map(name => JSON.parse(readFileSync(join(mailbox, name), "utf8"))).find(message => message.kind === kind && message.challenge.email === email);
        return Boolean(captured);
      }, { timeout: 10000, intervals: [100,250] }).toBe(true);
      return captured!;
    }
    async function managedIds(): Promise<Set<string>> {
      if (input.bundle !== "node-supabase") return new Set();
      const response = await request.get(`${processEnvironment.OPENLUP_IDENTITY_MAIL_ORIGIN}/api/v1/messages`);
      expect(response.ok()).toBe(true);
      return new Set((await response.json()).messages.map((message: { ID?: string; id?: string }) => message.ID ?? message.id));
    }
    async function managedLink(email: string, before: Set<string>) {
      const mail = processEnvironment.OPENLUP_IDENTITY_MAIL_ORIGIN, auth = processEnvironment.SUPABASE_URL;
      if (!mail || !auth) throw new Error("Owned managed mailbox required");
      let messageId: string | undefined;
      await expect.poll(async () => {
        const response = await request.get(`${mail}/api/v1/messages`); expect(response.ok()).toBe(true);
        const messages = (await response.json()).messages;
        const found = messages.find((message: { ID?: string; id?: string; To?: (string | { Address: string })[] }) => !before.has(message.ID ?? message.id ?? "") && message.To?.some(value => (typeof value === "string" ? value : value.Address).toLowerCase() === email));
        messageId = found?.ID ?? found?.id; return Boolean(messageId);
      }, { timeout: 10000, intervals: [250,500] }).toBe(true);
      const response = await request.get(`${mail}/api/v1/message/${encodeURIComponent(messageId!)}`), content = await response.json();
      const text = [content.HTML, content.Text, content.html, content.text].filter(value => typeof value === "string").join("\n").replaceAll("&amp;", "&").replaceAll("&#38;", "&");
      const url = (text.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map(value => new URL(value)).find(value => value.origin === auth && value.pathname === "/auth/v1/verify" && value.searchParams.has("token"));
      expect(Boolean(url)).toBe(true); return url!.href;
    }
    await page.goto("/sign-in");
    await page.getByLabel("Email", { exact: true }).fill(input.customerEmail);
    const before = localIds(), managedBefore = await managedIds();
    await page.getByRole("button", { name: "Request sign-in", exact: true }).click();
    if (input.bundle === "node-postgres") {
      const message = await localChallenge("customer", input.customerEmail, before);
      await page.locator("#customer-otp-code").fill(message.challenge!.token);
      await page.locator("#customer-otp-code").press("Enter");
    } else await page.goto(await managedLink(input.customerEmail, managedBefore));
    await expect(page.getByRole("heading", { name: "Your identity account", exact: true })).toBeVisible();
    expect((await page.getByTestId("contact-id").textContent()) === input.contactId).toBe(true);
    await page.reload(); await expect(page.getByRole("heading", { name: "Your identity account", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await expect(page).toHaveURL(`${baseURL}/sign-in`);
    await page.goto("/account"); await expect(page).toHaveURL(`${baseURL}/sign-in`);

    await page.goto("/admin/login");
    await page.locator('form input[name="email"]').fill(input.adminEmail);
    const operatorBefore = localIds(), operatorManagedBefore = await managedIds();
    await page.getByRole("button", { name: /link/i }).click();
    const callback = input.bundle === "node-postgres" ? (await localChallenge("operator", input.adminEmail, operatorBefore)).callback : await managedLink(input.adminEmail, operatorManagedBefore);
    expect(Boolean(callback)).toBe(true); await page.goto(callback!);
    await expect(page.getByRole("heading", { name: "Identity administration", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Identity privacy", exact: true })).toBeVisible();
    await page.getByLabel("Subject ID", { exact: true }).fill(input.contactId);
    await page.getByRole("button", { name: "Export identity data", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Export coverage and retained obligations", exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole("heading", { name: "Identity administration", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await expect(page).toHaveURL(`${baseURL}/admin/login`);
    await expect(page.locator('form input[name="email"]')).toBeVisible();
    await page.goto("/admin"); await expect(page).toHaveURL(`${baseURL}/admin/login`);
    await expect(page.locator('form input[name="email"]')).toBeVisible();
  } catch { throw new Error("Identity browser journey failed; credential-bearing details suppressed"); }
});
