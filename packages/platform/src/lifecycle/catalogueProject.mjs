import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const shellCommand = args => "npx --no -- openlup " + args.map(value => /^[A-Za-z0-9_./=-]+$/u.test(value)
  ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");

async function checkApplicationScratch(source, scratch) {
  let directory = dirname(source), foundPackage = false;
  for (;;) {
    try {
      if ((await fs.stat(join(directory, "package.json"))).isFile()) {
        foundPackage = true;
        if (contains(directory, scratch)) throw new Error("Scratch is inside an application directory");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!foundPackage) throw new Error("Catalogue application package.json not found");
}

function contains(root, path) {
  const inside = relative(root, path);
  return !isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`);
}

export async function runCatalogue(command, args, path, json, { emit, refuse, renderFinding }) {
  const projecting = command === "catalogue project";
  const recheck = shellCommand(args);
  let report, transport;
  let fix = "Check the command, readable JSON snapshots and schema ordinal, the catalogue JSON, or the trusted --app module and its documented export. After a partial upgrade, rerun the identical snapshots under exclusive access.";
  let parse = false;
  try {
    if (projecting) {
      const started = performance.now();
      fix = "Point --trusted-packs at a readable module within an application with a package.json.";
      const cwd = await fs.realpath(process.cwd());
      const sourcePath = await fs.realpath(resolve(cwd, path));
      fix = "Use a trusted module within an application with a package.json and choose a writable OS temporary directory outside the application and working directories.";
      const scratch = await fs.realpath(tmpdir());
      if (contains(cwd, scratch)) throw new Error("Scratch is inside the working directory");
      await checkApplicationScratch(sourcePath, scratch);
      fix = "Check that --trusted-packs resolves to a module exporting catalogueConformance with JSON fixture data and registered content validators.";
      const { catalogueConformance } = await import(pathToFileURL(sourcePath).href);
      // eslint-disable-next-line no-restricted-syntax -- the installed bin alone uses the internal compiled projector
      const { projectCatalogExtensionConformance } = await import("../../dist/catalog/testing/catalogExtensionConformance.js");
      const projection = projectCatalogExtensionConformance(catalogueConformance);
      fix = "Check that the OS temporary directory is writable and the scratch subject stays intact.";
      const subjectPath = join(await fs.mkdtemp(join(scratch, "openlup-catalogue-")), "subject.json");
      const expected = Buffer.from(projection.subject);
      await fs.writeFile(subjectPath, expected, { mode: 0o600, flag: "wx" });
      const bytes = await fs.readFile(subjectPath);
      if (!bytes.equals(expected)) throw new Error("Scratch subject changed");
      transport = { subjectPath, subjectHash: createHash("sha256").update(bytes).digest("hex"),
        checkerInvocations: 0, projectionMilliseconds: performance.now() - started, recheck,
        replay: shellCommand(["catalogue", "check", "--packs", subjectPath, ...(json ? ["--json"] : [])]) };
      const checking = performance.now();
      fix = "Check the installed rule bindings and ensure registered content validators return synchronously.";
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
