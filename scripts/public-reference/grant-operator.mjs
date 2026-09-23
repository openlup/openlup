#!/usr/bin/env node
// Local-only bootstrap. Usage: node --import tsx scripts/public-reference/grant-operator.mjs
//   --env-file /absolute/owned/subscription.env --email confirmed@example.test
// This grants an existing confirmed Auth identity a human admin row; it never creates a session.
import { basename, dirname, isAbsolute, join } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

function fail(message) { throw new Error(message); }
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) fail(`Required: ${name} VALUE`);
  return process.argv[index + 1];
}

try {
  if (process.argv.length !== 6) fail("Use exactly --env-file and --email");
  const fileArg = option("--env-file");
  const email = option("--email").trim().toLowerCase();
  if (!isAbsolute(fileArg) || basename(fileArg) !== "subscription.env") fail("Use the absolute generated subscription.env path");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) fail("A valid confirmed email is required");
  const file = realpathSync(fileArg);
  const directory = dirname(file);
  if (statSync(file).mode & 0o077) fail("Generated environment file must be private");
  const env = { ...process.env, ...parseEnv(readFileSync(file, "utf8")) };
  if (env.OPENLUP_REFERENCE_PROFILE !== "subscription"
    || realpathSync(env.OPENLUP_REFERENCE_SUPABASE_DIR ?? "") !== directory) fail("Environment is not the owned subscription setup");
  const marker = JSON.parse(readFileSync(join(directory, "subscription-owner.json"), "utf8"));
  if (marker.projectId !== env.OPENLUP_REFERENCE_PROJECT_ID) fail("Subscription owner marker does not match");
  const { validateSubscriptionProfile } = await import("../../server/runtime/public-reference/subscriptionProfile.ts");
  const profile = validateSubscriptionProfile(env);
  await profile.assertDisposable();

  const service = createClient(profile.data.url, profile.data.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let matched = null;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (error || !data) fail("Local Auth users could not be verified");
    for (const user of data.users) {
      if (user.email?.trim().toLowerCase() !== email) continue;
      if (matched) fail("Ambiguous Auth email");
      matched = user;
    }
    if (data.users.length < 100) break;
    if (page === 10) fail("Local Auth user search exceeded its bound");
  }
  if (!matched?.email_confirmed_at) fail("A matching, email-confirmed Auth identity is required");

  const byId = await service.from("admin_users")
    .select("id, email, role, is_machine_actor, membership_state")
    .eq("id", matched.id).maybeSingle();
  const byEmail = await service.from("admin_users")
    .select("id, email, role, is_machine_actor, membership_state")
    .eq("email", email).maybeSingle();
  if (byId.error || byEmail.error) fail("Local operator membership could not be checked");
  const existing = byId.data ?? byEmail.data;
  if (existing) {
    if (existing.id !== matched.id || existing.email?.toLowerCase() !== email
      || existing.role !== "admin" || existing.membership_state !== "active"
      || existing.is_machine_actor !== false || (byId.data && byEmail.data && byId.data.id !== byEmail.data.id)) {
      fail("Conflicting operator membership; refusing to change it");
    }
    console.log("Existing local human operator membership verified.");
  } else {
    const { error } = await service.from("admin_users").insert({
      id: matched.id, email, role: "admin", is_machine_actor: false,
      membership_state: "active", membership_provenance: "legacy",
      membership_accepted_at: new Date().toISOString(),
    });
    if (error) fail("Local operator membership could not be granted");
    console.log("Confirmed local human operator membership granted.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local operator grant failed");
  process.exitCode = 1;
}
