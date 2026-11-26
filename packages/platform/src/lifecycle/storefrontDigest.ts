const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "it is not a non-empty string";
  if (path.includes("\\")) return "it holds a backslash";
  for (let index = 0; index < path.length; index += 1) {
    const unit = path.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return "it holds a control character (such as NUL or a line feed)";
  }
  if (LONE_SURROGATE.test(path)) return "it holds a lone surrogate";
  if (path.normalize("NFC") !== path) return "it is not in Unicode NFC form";
  if (path.startsWith("/")) return "it is absolute";
  if (path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) return "it has an empty, `.` or `..` segment";
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The one client-build digest: `sha256:` and the lower-case hex SHA-256 of a
 * manifest that lists, sorted by path in code-unit order, each file's path, a
 * NUL, the lower-case hex SHA-256 of its bytes and a line feed. Input order does
 * not matter; any changed byte or path changes the digest.
 *
 * Each path is relative and uses `/`, with no empty, `.` or `..` segment, no
 * control character (NUL, line feed and the rest of C0, and DEL), backslash or
 * lone surrogate, and is in NFC. Sorting compares UTF-16 code units, not locale,
 * code-point or UTF-8 byte order. Otherwise, or for a path
 * given twice, it rejects with a `TypeError` whose message starts
 * `storefront_digest_path_invalid` and names the path.
 *
 * @experimental
 */
export async function digestStorefrontFiles(files: readonly { path: string; bytes: Uint8Array }[]): Promise<string> {
  const seen = new Set<string>();
  for (const file of files) {
    const problem = pathProblem(file?.path);
    const named = JSON.stringify(file?.path) ?? String(file?.path);
    if (problem) throw new TypeError(`storefront_digest_path_invalid: path ${named} is refused because ${problem}. Name each built file by its relative POSIX path in NFC.`);
    if (seen.has(file.path)) throw new TypeError(`storefront_digest_path_invalid: path ${named} is given twice. Name each built file once.`);
    seen.add(file.path);
  }
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hashes = await Promise.all(sorted.map(file => sha256Hex(file.bytes)));
  const manifest = sorted.map((file, index) => `${file.path}\u0000${hashes[index]}\n`).join("");
  return `sha256:${await sha256Hex(new TextEncoder().encode(manifest))}`;
}
