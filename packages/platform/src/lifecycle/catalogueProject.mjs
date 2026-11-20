import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const shellCommand = args => "npx --no -- openlup " + args.map(value => /^[A-Za-z0-9_./=-]+$/u.test(value)
  ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");

export async function runCatalogue(command, args, path, json, { emit, refuse, renderFinding }) {
  const projecting = command === "catalogue project";
  const recheck = shellCommand(args);
  let report, transport;
  let fix = "Check the command, readable JSON snapshots and schema ordinal, the catalogue JSON, or the trusted --app module and its documented export. After a partial upgrade, rerun the identical snapshots under exclusive access.";
  let parse = false;
  try {
    if (projecting) {
      const started = performance.now();
      const root = await fs.realpath(process.cwd());
      fix = "Check that --trusted-packs resolves to a module exporting catalogueConformance with JSON fixture data and registered content validators.";
      const { catalogueConformance } = await import(pathToFileURL(resolve(path)).href);
      // eslint-disable-next-line no-restricted-syntax -- the installed bin alone uses the internal compiled projector
      const { projectCatalogExtensionConformance } = await import("../../dist/catalog/testing/catalogExtensionConformance.js");
      const projection = projectCatalogExtensionConformance(catalogueConformance);
      fix = "Choose a writable OS temporary directory outside the application and rerun projection.";
      const scratch = await fs.realpath(tmpdir());
      const inside = relative(root, scratch);
      if (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))) throw new Error("Scratch is inside the application");
      const subjectPath = join(await fs.mkdtemp(join(scratch, "openlup-catalogue-")), "subject.json");
      const expected = Buffer.from(projection.subject);
      await fs.writeFile(subjectPath, expected, { mode: 0o600, flag: "wx" });
      const bytes = await fs.readFile(subjectPath);
      if (!bytes.equals(expected)) throw new Error("Scratch subject changed");
      transport = { subjectPath, subjectHash: createHash("sha256").update(bytes).digest("hex"),
        checkerInvocations: 0, projectionMilliseconds: performance.now() - started, recheck,
        replay: shellCommand(["catalogue", "check", "--packs", subjectPath, ...(json ? ["--json"] : [])]) };
      const checking = performance.now();
      fix = "Check the installed rule bindings and registered validators, then rerun projection.";
      transport.checkerInvocations++;
      report = await projection.check(bytes.toString("utf8"));
      transport.checkMilliseconds = performance.now() - checking;
    } else {
      // eslint-disable-next-line no-restricted-syntax -- tool entry loads the installed testing subpath
      const { runCatalogExtensionConformance } = await import("@openlup/platform/catalog/testing");
      const text = await fs.readFile(resolve(path), "utf8");
      parse = true;
      report = await runCatalogExtensionConformance(text);
    }
  } catch (error) {
    const syntax = parse && error instanceof SyntaxError && error[Symbol.for("openlup.catalogue.json.parse")] === true;
    const observed = projecting ? "The catalogue operation could not complete. Raw application errors are withheld."
      : "The operation could not complete; raw input and application errors are withheld.";
    refuse(syntax ? 64 : 74, syntax ? "OPENLUP_E_CLI_INPUT" : "OPENLUP_E_CLI_FAILURE", observed, fix);
    return;
  }
  const findings = report.findings.map(finding => ({ ...finding, recheck }));
  const evidence = transport
    ? `Scratch subject: ${transport.subjectPath}\nSHA-256: ${transport.subjectHash}\nChecker invocations: ${transport.checkerInvocations}\nProjection ms: ${transport.projectionMilliseconds}\nCheck ms: ${transport.checkMilliseconds}\nRecheck: ${recheck}\nReplay: ${transport.replay}\n`
    : "";
  emit({ command, ...report, findings, ...(transport ? { transport } : {}) },
    `${command}: ${report.state}\n${report.boundary}\n${evidence}${findings.map(renderFinding).join("\n")}`.trimEnd());
}
