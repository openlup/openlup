// Opt-in stdio development tool. Kernel exports never import this module.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { formatContextResult, searchContext } from "./agent-context-cli.js";

const versions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const maxFileBytes = 200_000;
const tools = [
  {
    name: "search_openlup_context",
    description: "Locate installed OpenLup owners, seams and public symbols offline. Search concise English terms when the owner is unclear, then read cited files and follow callers and tests. Code scans are opt-in and bounded; ranked hits are starting points, not complete contract coverage.",
    inputSchema: {
      type: "object", properties: {
        task: { type: "string" },
        includeApplicationCode: { type: "boolean", default: false },
        includePackageCode: { type: "boolean", default: false },
      }, required: ["task"], additionalProperties: false,
    },
  },
  {
    name: "read_openlup_file",
    description: "Read numbered lines from an installed node_modules/@openlup/<name> file, using its application-relative search path. Inclusive line numbers start at 1. Only ordinary files up to 200,000 bytes are allowed; symlinked package roots are supported, while traversal, repository URLs and file realpaths outside the resolved package root are refused. Application source hits must be read with the client's own file tool.",
    inputSchema: {
      type: "object", properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      }, required: ["path"], additionalProperties: false,
    },
  },
];

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
class InvalidParams extends Error {}
function requireParams(condition: unknown): asserts condition {
  if (!condition) throw new InvalidParams("Invalid params");
}

function readOrdinaryFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile()) throw new Error("Installed path must be an ordinary file");
    if (state.size > maxFileBytes) throw new Error(`Installed file exceeds ${maxFileBytes} bytes`);
    // Bound the actual read too, in case the file grows after stat.
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxFileBytes) throw new Error(`Installed file exceeds ${maxFileBytes} bytes`);
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(descriptor); }
}

function readInstalledFile(cwd: string, path: string, startLine = 1, endLine?: number): string {
  if (/^https?:\/\//iu.test(path)) throw new Error("This source URL is not installed. Read the cited installed AGENT_CONTEXT.md excerpt instead; no URL is fetched.");
  const parts = path.split("/");
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes("\\") || path.includes("\0") ||
      parts.some(part => !part || part === "." || part === "..") ||
      parts.length < 4 || parts[0] !== "node_modules" || parts[1] !== "@openlup" || !/^[a-z0-9][a-z0-9-]*$/u.test(parts[2])) {
    throw new Error("Use a relative node_modules/@openlup/<name>/<file> path without traversal");
  }
  const packageRoot = realpathSync(join(cwd, ...parts.slice(0, 3)));
  const manifestPath = realpathSync(join(packageRoot, "package.json"));
  if (!manifestPath.startsWith(`${packageRoot}${sep}`)) throw new Error("Manifest realpath escapes the installed package root");
  const manifest = JSON.parse(readOrdinaryFile(manifestPath)) as { name?: unknown; version?: unknown };
  if (manifest.name !== `@openlup/${parts[2]}` || typeof manifest.version !== "string" || !manifest.version) throw new Error("Invalid installed package manifest");
  const filePath = realpathSync(join(cwd, ...parts));
  if (!filePath.startsWith(`${packageRoot}${sep}`)) throw new Error("File realpath escapes the installed package root");
  const content = readOrdinaryFile(filePath);
  const lines = content ? content.replace(/\r?\n$/u, "").split(/\r?\n/u) : [];
  const end = endLine ?? lines.length;
  if (endLine !== undefined && endLine < startLine) throw new Error("endLine must be at least startLine");
  if (!lines.length && startLine === 1 && endLine === undefined) return `${path} (empty file)`;
  if (startLine > lines.length) throw new Error(`startLine exceeds file length (${lines.length} lines)`);
  return `${path}:${startLine}-${Math.min(end, lines.length)}\n${lines.slice(startLine - 1, end).map((line, index) => `${startLine + index}: ${line}`).join("\n")}`;
}

function callTool(cwd: string, params: ObjectValue): ObjectValue {
  requireParams(typeof params.name === "string" && object(params.arguments));
  const args = params.arguments;
  if (params.name === "search_openlup_context") {
    requireParams(typeof args.task === "string" &&
      ["includeApplicationCode", "includePackageCode"].every(key => args[key] === undefined || typeof args[key] === "boolean") &&
      Object.keys(args).every(key => ["task", "includeApplicationCode", "includePackageCode"].includes(key)));
  } else if (params.name === "read_openlup_file") {
    requireParams(typeof args.path === "string" &&
      ["startLine", "endLine"].every(key => args[key] === undefined || (Number.isSafeInteger(args[key]) && (args[key] as number) >= 1)) &&
      Object.keys(args).every(key => ["path", "startLine", "endLine"].includes(key)));
  } else { throw new InvalidParams(`Unknown tool: ${params.name}`); }
  try {
    if (params.name === "search_openlup_context") {
      const result = searchContext(cwd, args.task as string, args.includeApplicationCode as boolean | undefined, args.includePackageCode as boolean | undefined);
      return {
        content: [{ type: "text", text: formatContextResult(cwd, result) }],
        structuredContent: { ...result, hits: result.hits.map(hit => ({ ...hit, file: relative(cwd, hit.file).split(sep).join("/") })) },
      };
    }
    return { content: [{ type: "text", text: readInstalledFile(cwd, args.path as string, args.startLine as number | undefined, args.endLine as number | undefined) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
  }
}

function dispatch(cwd: string, method: string, params: unknown): ObjectValue {
  if (!["initialize", "ping", "tools/list", "tools/call"].includes(method)) throw new Error("Method not found");
  requireParams(params === undefined || object(params));
  const input = params ?? {};
  switch (method) {
    case "initialize": {
      requireParams(typeof input.protocolVersion === "string");
      const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      return {
        protocolVersion: versions.includes(input.protocolVersion) ? input.protocolVersion : versions[0],
        capabilities: { tools: {} }, serverInfo: { name: "openlup-context", version: manifest.version },
        instructions: "Search concise English OpenLup terms or exact public symbols when an installed package owner or extension seam is unclear. Read cited installed files and follow exports, callers and tests; ranked hits do not prove complete coverage. The application's own instructions govern.",
      };
    }
    case "ping": return {};
    case "tools/list":
      requireParams(input.cursor === undefined);
      return { tools };
    default: return callTool(cwd, input);
  }
}

/** One JSON-RPC message per line; stream completion leaves no server or timer running. */
export async function runMcp(cwd: string, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const reply = async (value: ObjectValue): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
    });
  };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { await reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
          (Object.hasOwn(message, "id") && typeof message.id !== "string" && !(typeof message.id === "number" && Number.isFinite(message.id)))) {
        await reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        continue;
      }
      if (!Object.hasOwn(message, "id")) continue;
      try {
        const result = dispatch(cwd, message.method, message.params);
        await reply({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        const code = error instanceof InvalidParams ? -32602 : error instanceof Error && error.message === "Method not found" ? -32601 : -32603;
        await reply({ jsonrpc: "2.0", id: message.id, error: { code, message: (error as Error).message } });
      }
    }
  } finally { lines.close(); }
}
