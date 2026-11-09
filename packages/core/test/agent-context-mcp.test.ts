import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runMcp } from "../src/agent-context-mcp";
import { formatContextResult, searchContext } from "../src/agent-context-cli";

const roots: string[] = [];
const prefix = "node_modules/@openlup/core/";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openlup-mcp-"));
  roots.push(root);
  return root;
}
function install(root: string, name = "core", version = "0.37.0"): string {
  const directory = join(root, "node_modules/@openlup", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@openlup/${name}`, version }));
  const excerpt = "## Retry policy\nUse nextRetryAttemptAt for the retry schedule.\n";
  const metadata = { id: "retry-policy", source: `https://github.com/openlup/openlup/blob/openlup-${name}-v${version}/docs/platform/CANONICAL_CONTRACTS.md`, heading: "Retry policy", sha256: createHash("sha256").update(excerpt).digest("hex") };
  writeFileSync(join(directory, "AGENT_CONTEXT.md"), `# Context\n<!-- openlup-context-inventory ${JSON.stringify([metadata])} -->\n<!-- openlup-context ${JSON.stringify(metadata)} -->\n${excerpt}<!-- /openlup-context -->\n`);
  writeFileSync(join(directory, "README.md"), "# Installed package\r\nFirst line\r\nSecond line\r\nThird line\r\n");
  return directory;
}
function fixture(): string { const root = temporaryRoot(); install(root); return root; }
const request = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args: unknown, id = 1) => request("tools/call", { name, arguments: args }, id);
const read = (path = `${prefix}README.md`, args = {}) => call("read_openlup_file", { path, ...args });
const search = (args: Record<string, unknown> = { task: "retry" }) => call("search_openlup_context", args);
const initialize = (protocolVersion = "2025-06-18") => request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });

// Capture the wire bytes, including a final partial line on EOF.
async function exchange(cwd: string, messages: unknown[], raw = false, hooks: Parameters<typeof runMcp>[3] = {}) {
  let stdout = "";
  const output = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const chunks = raw ? messages as (string | Buffer)[] : messages.map(message => `${JSON.stringify(message)}\n`);
  await runMcp(cwd, Readable.from(chunks), output, hooks);
  return stdout.trim() ? stdout.trim().split("\n").map(line => JSON.parse(line)) : [];
}
async function result(cwd: string, message: unknown, hooks: Parameters<typeof runMcp>[3] = {}) { return (await exchange(cwd, [message], false, hooks))[0]; }
async function toolError(cwd: string, message: unknown, expected: RegExp, hooks: Parameters<typeof runMcp>[3] = {}) {
  const response = await result(cwd, message, hooks);
  expect(response.error).toBeUndefined();
  expect(response.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(expected) }] });
}

describe("installed context MCP protocol", () => {
  it.each([["2025-06-18", "2025-06-18"], ["2024-11-05", "2024-11-05"], ["2025-03-26", "2025-06-18"], ["2099-01-01", "2025-06-18"]])("negotiates %s to %s and reads its own installed server version", async (version, expected) => {
    const response = await result(temporaryRoot(), initialize(version));
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: {
      protocolVersion: expected,
      capabilities: { tools: {} },
      serverInfo: { name: "openlup-context", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version },
      instructions: expect.stringContaining("Search concise English"),
    } });
  });

  it.each([
    {}, { capabilities: {} }, { clientInfo: {} }, { capabilities: {}, clientInfo: {} },
    { clientInfo: { name: "minimal" } }, { capabilities: { roots: {} }, clientInfo: { version: "1" } },
  ])("accepts missing or partial initialization metadata: %j", async metadata => {
    const response = await result(temporaryRoot(), request("initialize", { protocolVersion: "2024-11-05", ...metadata }));
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    expect(response.error).toBeUndefined();
  });

  it("ignores blank and whitespace-only lines before, between and after messages", async () => {
    const replies = await exchange(fixture(), ["\n \t\r\n", `${JSON.stringify(request("ping"))}\n`, "   \n\t\n", `${JSON.stringify(request("ping", undefined, 2))}\n`, " \t"], true);
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]);
    expect(await exchange(fixture(), ["\n \t\r\n"], true)).toEqual([]);
  });

  it.each(["2025-06-18", "2024-11-05"])("rejects batches after negotiating %s and continues serving", async version => {
    const replies = await exchange(fixture(), [initialize(version), [request("ping", undefined, 2), request("ping", undefined, 3)], request("ping", undefined, 4)]);
    expect(replies[0].result.protocolVersion).toBe(version);
    expect(replies[1]).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(replies[2]).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    expect(replies).toHaveLength(3);
  });

  it("accepts a line of exactly 1 MiB and processes another message in the same chunk", async () => {
    const message = JSON.stringify(request("ping"));
    const replies = await exchange(fixture(), [message + " ".repeat(1024 * 1024 - Buffer.byteLength(message)) + "\n" + JSON.stringify(request("ping", undefined, 2)) + "\n"], true);
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]);
  });

  it.each([false, true])("refuses an oversized line once and resumes after its newline (chunked=%s)", async chunked => {
    const valid = JSON.stringify(request("ping", undefined, 2));
    const chunks = [" ".repeat(1024 * 1024), "x", valid, "discarded".repeat(150_000), `\n${valid}\n`];
    const replies = await exchange(fixture(), chunked ? chunks : [chunks.join("")], true);
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message exceeds 1 MiB" } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  it("counts UTF-8 bytes and emits one refusal per oversized line, including at EOF", async () => {
    const message = JSON.stringify(request("ping", { padding: "ż".repeat(600_000) }));
    expect(message.length).toBeLessThan(1024 * 1024);
    const replies = await exchange(fixture(), [Buffer.from(`${message}\n${message}`)], true);
    expect(replies).toHaveLength(2);
    for (const reply of replies) expect(reply).toMatchObject({ id: null, error: { code: -32600, message: "Message exceeds 1 MiB" } });
  });

  it("lists exact tool input schemas without an inexact output schema", async () => {
    const { result: response } = await result(fixture(), request("tools/list"));
    expect(response.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_openlup_context", "read_openlup_file"]);
    expect(response.tools[0].inputSchema).toEqual({ type: "object", properties: {
      task: { type: "string" }, includeApplicationCode: { type: "boolean", default: false }, includePackageCode: { type: "boolean", default: false },
    }, required: ["task"], additionalProperties: false });
    expect(response.tools[1].inputSchema).toEqual({ type: "object", properties: {
      path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
    }, required: ["path"], additionalProperties: false });
    for (const tool of response.tools) expect(tool.outputSchema).toBeUndefined();
  });

  it("ignores all notifications, supports ping and string/zero IDs, and completes on EOF", async () => {
    const replies = await exchange(fixture(), [initialize(),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", method: "unknown-notification" },
      { jsonrpc: "2.0", method: "tools/call", params: "invalid notification params" },
      request("ping", {}, "client-ping"), request("ping", undefined, 0),
    ]);
    expect(replies.map(response => response.id)).toEqual([1, "client-ping", 0]);
    expect(replies.slice(1).map(response => response.result)).toEqual([{}, {}]);
    expect(await exchange(fixture(), [])).toEqual([]);
  });

  it("answers before stdin ends and handles split UTF-8 chunks and a final line without newline", async () => {
    const input = new PassThrough();
    let wire = "";
    let firstReply!: () => void;
    const first = new Promise<void>(resolve => { firstReply = resolve; });
    const output = new Writable({ write(chunk, _encoding, callback) { wire += chunk.toString(); firstReply(); callback(); } });
    const running = runMcp(fixture(), input, output);
    const bytes = Buffer.from(JSON.stringify(request("ping", {}, "żółw")) + "\r\n");
    const split = bytes.indexOf(Buffer.from("ż")) + 1;
    input.write(bytes.subarray(0, split));
    input.write(bytes.subarray(split));
    await first;
    expect(JSON.parse(wire).id).toBe("żółw");
    input.end(JSON.stringify(request("ping", undefined, 2)));
    await running;
    expect(wire.trim().split("\n").map(line => JSON.parse(line).id)).toEqual(["żółw", 2]);
  });

  it("reports unknown methods and recovers after parse and invalid-request errors", async () => {
    const raw = ["{bad\n", "[]\n", "null\n", "42\n", '{}\n', '{"jsonrpc":"1.0","id":1,"method":"ping"}\n',
      '{"jsonrpc":"2.0","id":{},"method":"ping"}\n', '{"jsonrpc":"2.0","id":null,"method":"ping"}\n',
      `${JSON.stringify(request("absent"))}\n`, `${JSON.stringify(request("ping"))}\n`];
    const replies = await exchange(fixture(), raw, true);
    expect(replies.map(response => response.error?.code ?? 0)).toEqual([-32700, -32600, -32600, -32600, -32600, -32600, -32600, -32600, -32601, 0]);
    expect(replies[0].id).toBeNull();
    expect(replies[8].id).toBe(1);
  });

  it.each([
    request("initialize"), request("initialize", { protocolVersion: 1 }),
    request("ping", []), request("tools/list", "bad"), request("tools/list", { cursor: "unsupported" }),
    request("tools/call"), request("tools/call", { name: "search_openlup_context" }),
    call("absent", {}), search({ task: 1 }), search({}), search({ task: "retry", extra: true }),
    search({ task: "retry", includeApplicationCode: "true" }), search({ task: "retry", includePackageCode: 1 }),
    call("read_openlup_file", { path: 1 }), call("read_openlup_file", {}),
    read(undefined, { startLine: 0 }), read(undefined, { endLine: -1 }), read(undefined, { startLine: 1.5 }),
    read(undefined, { endLine: "2" }), read(undefined, { extra: true }),
  ])("rejects invalid params: %j", async message => {
    expect(await result(fixture(), message)).toMatchObject({ id: 1, error: { code: -32602 } });
  });
});

describe("MCP installed context search", () => {
  it("returns CLI text and JSON with reusable application-relative file paths", async () => {
    const root = fixture();
    const { result: response } = await result(root, search());
    expect(response.content).toEqual([{ type: "text", text: formatContextResult(root, searchContext(root, "retry")) }]);
    expect(response.structuredContent).toMatchObject({ version: "0.37.0", packages: ["@openlup/core"], hits: [{ file: `${prefix}AGENT_CONTEXT.md`, start: 4, end: 5, reason: "canonical owner excerpt", owner: expect.stringContaining("openlup-core-v0.37.0") }] });
    const hit = response.structuredContent.hits[0];
    expect((await result(root, read(hit.file, { startLine: hit.start, endLine: hit.end }))).result.content[0].text).toContain("4: ## Retry policy\n5: Use nextRetryAttemptAt");
    await toolError(root, read(hit.owner), /source URL is not installed/);
  });

  it("accepts 1,000-character tasks and returns a tool error above the limit", async () => {
    const root = fixture();
    const accepted = await result(root, search({ task: "x".repeat(1_000) }));
    expect(accepted.result.isError).toBeUndefined();
    expect(accepted.result.structuredContent.hits).toEqual([]);
    await toolError(root, search({ task: "x".repeat(1_001) }), /Search task exceeds 1000 characters/);
  });

  it("only searches application and package code when requested and refreshes edits", async () => {
    const root = fixture();
    mkdirSync(join(root, prefix, "src"));
    writeFileSync(join(root, "checkout.ts"), "export const applicationNeedle = 1;\n");
    writeFileSync(join(root, prefix, "src/checkout.ts"), "export const packageNeedle = 1;\n");
    for (const [task, flag, file] of [["applicationNeedle", "includeApplicationCode", "checkout.ts"], ["packageNeedle", "includePackageCode", `${prefix}src/checkout.ts`]]) {
      expect((await result(root, search({ task }))).result.structuredContent.hits).toEqual([]);
      expect((await result(root, search({ task, [flag]: true }))).result.structuredContent.hits[0].file).toBe(file);
    }
    writeFileSync(join(root, "checkout.ts"), "export const renamedNeedle = 1;\n");
    expect((await result(root, search({ task: "applicationNeedle", includeApplicationCode: true }))).result.structuredContent.hits).toEqual([]);
    const empty = (await result(root, search({ task: "unmatchedNeedle" }))).result;
    expect(empty.content[0].text).toContain("does not prove a public seam is absent");
    expect(empty.isError).toBeUndefined();
  });

  it("returns installed-package, task and corpus failures as tool errors", async () => {
    await toolError(temporaryRoot(), search(), /No installed/);
    const root = fixture();
    for (const task of ["", "   ", "the and"]) await toolError(root, search({ task }), /specific task/);
    install(root, "outbox", "0.36.0");
    await toolError(root, search(), /Mixed @openlup/);
    rmSync(join(root, "node_modules/@openlup/outbox"), { recursive: true });
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@openlup/core": { version: "0.36.0" } } }));
    await toolError(root, search(), /Lockfile and installed/);
    rmSync(join(root, "package-lock.json"));
    const file = join(root, prefix, "AGENT_CONTEXT.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("retry schedule", "altered schedule"));
    await toolError(root, search(), /digest mismatch/);
  });
});

describe("MCP installed file reader", () => {
  it("reads full files and inclusive ranges with defaults and EOF clamping", async () => {
    const root = fixture();
    expect((await result(root, read())).result.content[0].text).toBe(`${prefix}README.md:1-4\n1: # Installed package\n2: First line\n3: Second line\n4: Third line`);
    expect((await result(root, read(undefined, { startLine: 2, endLine: 3 }))).result.content[0].text).toBe(`${prefix}README.md:2-3\n2: First line\n3: Second line`);
    expect((await result(root, read(undefined, { endLine: 1 }))).result.content[0].text).toContain("1: # Installed package");
    expect((await result(root, read(undefined, { startLine: 4 }))).result.content[0].text).toContain("4: Third line");
    expect((await result(root, read(undefined, { endLine: 999 }))).result.content[0].text).toContain("README.md:1-4");
    writeFileSync(join(root, prefix, "empty.md"), "");
    expect((await result(root, read(`${prefix}empty.md`))).result.content[0].text).toContain("empty file");
    writeFileSync(join(root, prefix, "no-newline.md"), "one\ntwo");
    expect((await result(root, read(`${prefix}no-newline.md`))).result.content[0].text).toContain("1: one\n2: two");
    install(root, "outbox");
    expect((await result(root, read("node_modules/@openlup/outbox/README.md"))).result.content[0].text).toContain("Installed package");
  });

  it.each(["", "/etc/passwd", "C:/secret.txt", "C:\\secret.txt", "//host/share", "checkout.ts", "node_modules/zod/package.json", "node_modules/@openlup/core", `${prefix}../other/secret`, `${prefix}./README.md`, `${prefix}src/../../secret`, `${prefix}/README.md`, `${prefix}README.md/`, `${prefix}README.md\0`, `${prefix}src\\secret`, "node_modules/@openlup/.hidden/file"])("refuses path %j as a tool error", async path => {
    await toolError(fixture(), read(path), /relative node_modules/);
  });

  it("refuses directories, missing files, non-directory parents and invalid ranges", async () => {
    const root = fixture();
    mkdirSync(join(root, prefix, "src"));
    await toolError(root, read(`${prefix}src`), /ordinary file/);
    await toolError(root, read(`${prefix}absent.md`), /ENOENT/);
    await toolError(root, read(`${prefix}README.md/inside`), /ENOTDIR/);
    await toolError(root, read(undefined, { startLine: 3, endLine: 2 }), /endLine must/);
    await toolError(root, read(undefined, { startLine: 5 }), /file length/);
    await toolError(temporaryRoot(), read(), /ENOENT/);
  });

  it("reads search hits through a symlinked package root in a pnpm layout", async () => {
    const root = fixture();
    const packagePath = join(root, "node_modules/@openlup/core");
    const installedPath = join(root, "node_modules/.pnpm/@openlup+core@0.37.0/node_modules/@openlup/core");
    mkdirSync(dirname(installedPath), { recursive: true });
    renameSync(packagePath, installedPath);
    symlinkSync(relative(dirname(packagePath), installedPath), packagePath);
    expect((await result(root, read())).result.content[0].text).toContain("1: # Installed package");
    const hit = (await result(root, search())).result.structuredContent.hits[0];
    expect(hit.file).toBe(`${prefix}AGENT_CONTEXT.md`);
    expect((await result(root, read(hit.file, { startLine: hit.start, endLine: hit.end }))).result.content[0].text).toContain("4: ## Retry policy");
  });

  it.each(["file", "directory", "sibling-prefix"])("refuses an escaping %s symlink inside the package", async kind => {
    const root = fixture(), outside = kind === "sibling-prefix" ? join(root, "node_modules/@openlup/core-other") : temporaryRoot();
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "outside secret");
    const path = kind === "directory" ? `${prefix}linked/secret.md` : `${prefix}linked.md`;
    symlinkSync(kind === "directory" ? outside : join(outside, "secret.md"), join(root, prefix, kind === "directory" ? "linked" : "linked.md"));
    await toolError(root, read(path), /File realpath escapes the installed package root/);
  });

  it("reads a symlink whose target stays inside the package", async () => {
    const root = fixture();
    symlinkSync("README.md", join(root, prefix, "alias.md"));
    expect((await result(root, read(`${prefix}alias.md`))).result.content[0].text).toContain("1: # Installed package");
  });

  it.each(["File", "Manifest"] as const)("refuses a %s parent swapped outside between resolution and open", async kind => {
    const root = fixture(), outside = temporaryRoot();
    const directory = join(root, prefix, kind === "File" ? "src" : "metadata");
    mkdirSync(directory);
    const target = join(directory, kind === "File" ? "entry.md" : "package.json");
    if (kind === "Manifest") {
      renameSync(join(root, prefix, "package.json"), target);
      symlinkSync("metadata/package.json", join(root, prefix, "package.json"));
    } else writeFileSync(target, "inside file");
    writeFileSync(join(outside, kind === "File" ? "entry.md" : "package.json"), kind === "File" ? "outside secret" : JSON.stringify({ name: "@openlup/core", version: "0.37.0" }));
    const resolvedTarget = realpathSync(target);
    let swapped = false;
    await toolError(root, kind === "File" ? read(`${prefix}src/entry.md`) : read(), new RegExp(`${kind} realpath escapes the installed package root`), {
      beforeFileOpen(path) {
        if (path !== resolvedTarget || swapped) return;
        swapped = true;
        renameSync(directory, `${directory}-checked`);
        symlinkSync(outside, directory);
      },
    });
    expect(swapped).toBe(true);
  });

  it("re-resolves the package root when its installation link changes before open", async () => {
    const root = fixture(), replacementRoot = fixture();
    const packagePath = join(root, "node_modules/@openlup/core");
    const installedPath = `${packagePath}-installed`;
    renameSync(packagePath, installedPath);
    symlinkSync(installedPath, packagePath);
    const target = realpathSync(join(packagePath, "README.md"));
    let swapped = false;
    await toolError(root, read(), /File realpath escapes the installed package root/, {
      beforeFileOpen(path) {
        if (path !== target || swapped) return;
        swapped = true;
        rmSync(packagePath);
        symlinkSync(join(replacementRoot, "node_modules/@openlup/core"), packagePath);
      },
    });
    expect(swapped).toBe(true);
  });

  it.each(["File", "Manifest"] as const)("refuses a %s inode changed after open even when its path stays inside the package", async kind => {
    const root = fixture();
    const target = join(root, prefix, kind === "File" ? "README.md" : "package.json");
    const replacement = readFileSync(target);
    const resolvedTarget = realpathSync(target);
    let swapped = false;
    await toolError(root, read(), new RegExp(`${kind} changed while opening`), {
      afterFileOpen(path) {
        if (path !== resolvedTarget || swapped) return;
        swapped = true;
        renameSync(target, `${target}.previous`);
        writeFileSync(target, replacement);
      },
    });
    expect(swapped).toBe(true);
  });

  it("refuses a FIFO without opening a blocking stream", async () => {
    const root = fixture(), path = `${prefix}fifo`;
    execFileSync("mkfifo", [join(root, path)]);
    await toolError(root, read(path), /ordinary file/);
  });

  it("bounds manifest reads as well as the requested file", async () => {
    const root = fixture();
    writeFileSync(join(root, prefix, "package.json"), " ".repeat(200_001));
    await toolError(root, read(), /exceeds 200000 bytes/);
  });

  it("checks package identity and confines a symlinked manifest to the package root", async () => {
    const root = fixture();
    const file = join(root, prefix, "package.json");
    for (const manifest of [{ name: "another", version: "1" }, { name: "@openlup/core" }]) {
      writeFileSync(file, JSON.stringify(manifest));
      await toolError(root, read(), /Invalid installed package manifest/);
    }
    const manifest = { name: "@openlup/core", version: "0.37.0" };
    writeFileSync(join(root, prefix, "identity.json"), JSON.stringify(manifest));
    rmSync(file);
    symlinkSync("identity.json", file);
    expect((await result(root, read())).result.isError).toBeUndefined();
    rmSync(file);
    const outside = join(temporaryRoot(), "package.json");
    writeFileSync(outside, JSON.stringify(manifest));
    symlinkSync(outside, file);
    await toolError(root, read(), /Manifest realpath escapes the installed package root/);
  });

  it("enforces the 200,000-byte bound even for a small requested range", async () => {
    const root = fixture(), path = `${prefix}large.md`;
    writeFileSync(join(root, path), "x".repeat(200_000));
    expect((await result(root, read(path))).result.isError).toBeUndefined();
    writeFileSync(join(root, path), "x".repeat(200_001));
    await toolError(root, read(path, { startLine: 1, endLine: 1 }), /exceeds 200000 bytes/);
  });
});
