import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import {
  appended,
  appendedBinding,
  appendedSettings,
  appendedSignatures,
  catalogOnly,
  catalogPinned,
  installBeforeForward,
  laterReplacedByForward,
  observe,
  pinnedFunctions,
  profiles,
  quoteIdentifier,
  remaining,
  remainingBinding,
  remainingSignatures,
  rollBackPin,
  searchPathFailures,
  searchPathRemedy,
  withContainerSlot,
} from "./definerSearchPath.fixture.js";

const runInContainerSlot = withContainerSlot(2);

// Installed counts that the appended forward changes; the rest already carry their final value.
const appendedChanges = { legacy: 392, bootstrap: 371, separate: 371, "admin-managed": 390, "admin-operator": 390 } as const;

describe.concurrent("appended function search_path pin", () => {
  it.concurrent.each(profiles)(
    "appends pg_temp to pinned function search paths when upgrading %s",
    async profile => runInContainerSlot(async () => {
      const { owner, migrator, installation, runner, close } = await installBeforeForward(profile, "function-search-path", appendedBinding);
      try {
        // This forward covered installer-owned functions in public.
        const baseFailures = searchPathFailures((await pinnedFunctions(owner)).filter(row => row.signature.startsWith("public.")));
        expect(baseFailures).toHaveLength(appendedChanges[profile]);
        console.info(`search-path guard base failures ${profile} ${baseFailures.length}`);
        const before = await observe(owner, appendedSignatures);
        const installer = installation.generation === "legacy" ? "postgres" : installation.migrationLogin;
        expect(before.functions.filter(fn => fn.owner !== installer)).toEqual([]);
        const expected = before.functions.map((fn, index) => ({
          ...fn, record: { ...fn.record, proconfig: fn.record.proconfig.map(setting =>
            setting.startsWith("search_path=") ? `search_path=${appendedSettings[index]!.searchPath}` : setting) },
        }));
        expect(expected.filter((fn, index) => fn.record.proconfig.join() !== before.functions[index]!.record.proconfig.join()))
          .toHaveLength(appendedChanges[profile]);

        if (installation.generation === "qualified-admin") {
          await rollBackPin(migrator, before.ledger, appended.path, appendedBinding.sha256);
          expect(await observe(owner, appendedSignatures)).toEqual(before);
          // A function the installer does not own stops the forward before any setting commits.
          const target = appendedSignatures[193]!;
          await owner.query(`ALTER FUNCTION ${target} OWNER TO "${installation.bootstrapLogin}"`);
          try {
            const beforeFailure = await observe(owner, appendedSignatures);
            await expect(runner.apply()).rejects.toThrow(
              `platform migration ${appended.path} failed: must be owner of function ${target.slice(0, target.indexOf("("))}`);
            expect(await observe(owner, appendedSignatures)).toEqual(beforeFailure);
          } finally {
            await owner.query(`ALTER FUNCTION ${target} OWNER TO "${installer}"`);
          }
          expect(await observe(owner, appendedSignatures)).toEqual(before);
        }

        // Verify the search-path forward alone changes only proconfig before later forwards run.
        const pinCheck = await migrator.connect();
        try {
          await pinCheck.query("BEGIN");
          await pinCheck.query(readFileSync(appended.path, "utf8"));
          expect((await pinCheck.query<{ owner: string; record: { proconfig: string[]; prosecdef: boolean } }>(`
            SELECT r.rolname AS owner, pg_catalog.to_jsonb(p) AS record
            FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS targets(signature, ordinal)
            JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(targets.signature)
            JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
            ORDER BY targets.ordinal
          `, [appendedSignatures])).rows).toEqual(expected);
          await pinCheck.query("ROLLBACK");
        } finally {
          pinCheck.release();
        }

        expect((await runner.apply()).applied[0]).toBe(appended.path);
        const after = await observe(owner, appendedSignatures);
        const unchangedIndices = appendedSignatures.flatMap((signature, index) => (laterReplacedByForward.has(signature) ? [] : [index]));
        expect(unchangedIndices.map(index => after.functions[index])).toEqual(unchangedIndices.map(index => expected[index]));
        for (const [index, signature] of appendedSignatures.entries()) {
          if (!laterReplacedByForward.has(signature)) continue;
          const fn = after.functions[index]!;
          expect(fn.owner).toBe(expected[index]!.owner);
          const searchPath = fn.record.proconfig.find(setting => setting.startsWith("search_path="))?.slice(12) ?? null;
          expect(searchPathFailures([{ signature, search_path: searchPath }])).toEqual([]);
        }
        expect(after.memberships).toEqual(before.memberships);
        expect(after.ledger.slice(0, before.ledger.length + 1)).toEqual([...before.ledger, expect.objectContaining({
          catalog_path: appended.path, sha256: appendedBinding.sha256, position: before.ledger.length,
        })]);
        expect((await runner.apply()).applied).toEqual([]);
        expect(await observe(owner, appendedSignatures)).toEqual(after);
      } finally {
        await close();
      }
    }),
    postgresSetupTimeoutMs,
  );
});

const q2Preimages = [catalogPinned, catalogPinned, catalogOnly, catalogPinned, "pg_catalog, public, pg_temp"];
const adminPreimages = [catalogPinned, catalogPinned, catalogOnly, catalogPinned, catalogOnly];

describe.concurrent("remaining function search_path pin", () => {
  it.concurrent.each(profiles)(
    "pins the remaining function search paths when upgrading %s",
    async profile => runInContainerSlot(async () => {
      const { owner, migrator, installation, runner, close } = await installBeforeForward(profile, "remaining-search-path", remainingBinding);
      try {
        expect(remainingSignatures).toEqual([
          "acquisition_private.case_projection(uuid)",
          "acquisition_private.keyed_digest(text,jsonb)",
          "acquisition_private.partner_case_projection(uuid)",
          "acquisition_private.refuse_append_only_mutation()",
          "auth.uid()",
        ]);
        const installer = installation.generation === "legacy" ? "postgres" : installation.migrationLogin;
        const before = await observe(owner, remainingSignatures);
        expect(before.functions.map(fn => fn.owner)).toEqual([...Array(4).fill("platform_acquisition_owner"), installer]);
        const preimages = installation.generation === "legacy" ? Array<string>(5).fill(catalogOnly)
          : installation.generation === "qualified-v2" ? q2Preimages : adminPreimages;
        expect(before.functions.map(fn => fn.record.proconfig.filter(setting => setting.startsWith("search_path="))))
          .toEqual(preimages.map(path => [`search_path=${path}`]));
        const preForwardFailures = remainingSignatures.flatMap((signature, index) => preimages[index] === catalogOnly
          ? [searchPathRemedy(signature, catalogPinned)] : []).sort();
        expect(searchPathFailures(await pinnedFunctions(owner))).toEqual(preForwardFailures);

        const expectedFunctions = before.functions.map(fn => ({
          ...fn, record: { ...fn.record, proconfig: fn.record.proconfig.map(setting =>
            setting.startsWith("search_path=") ? `search_path=${catalogPinned}` : setting) },
        }));
        if (installation.generation === "qualified-admin") {
          await rollBackPin(migrator, before.ledger, remaining.path, remainingBinding.sha256, async client => {
            // The owner window is closed, so look up private functions by their observed OIDs.
            const isolated = await observe(client, remainingSignatures, before.functions.map(fn => fn.record.oid));
            expect(isolated.functions).toEqual(expectedFunctions);
            expect(isolated.memberships).toEqual(before.memberships);
          });
          expect(await observe(owner, remainingSignatures)).toEqual(before);

          // Both failures occur after the partner projection's path has changed in the transaction.
          for (const [signature, originalOwner] of [
            ["acquisition_private.refuse_append_only_mutation()", "platform_acquisition_owner"],
            ["auth.uid()", installer],
          ] as const) {
            await owner.query(`ALTER FUNCTION ${signature} OWNER TO ${quoteIdentifier(installation.bootstrapLogin)}`);
            try {
              const beforeFailure = await observe(owner, remainingSignatures);
              await expect(runner.apply()).rejects.toThrow(
                `platform migration ${remaining.path} failed: must be owner of function ${signature.split("(")[0]}`);
              expect(await observe(owner, remainingSignatures)).toEqual(beforeFailure);
            } finally {
              await owner.query(`ALTER FUNCTION ${signature} OWNER TO ${quoteIdentifier(originalOwner)}`);
            }
            expect(await observe(owner, remainingSignatures)).toEqual(before);
          }
        }

        expect((await runner.apply()).applied[0]).toBe(remaining.path);
        const after = await observe(owner, remainingSignatures);
        expect(after.functions).toEqual(expectedFunctions);
        expect(after.memberships).toEqual(before.memberships);
        expect(after.ledger.slice(0, before.ledger.length + 1)).toEqual([...before.ledger, expect.objectContaining({
          catalog_path: remaining.path, sha256: remainingBinding.sha256, position: before.ledger.length,
        })]);
        expect(searchPathFailures(await pinnedFunctions(owner))).toEqual([]);

        if (installation.generation === "qualified-admin") {
          await migrator.query(readFileSync(remaining.path, "utf8"));
          expect(await observe(owner, remainingSignatures)).toEqual(after);
        }
        expect((await runner.apply()).applied).toEqual([]);
        expect(await observe(owner, remainingSignatures)).toEqual(after);
      } finally {
        await close();
      }
    }),
    postgresSetupTimeoutMs,
  );
});
