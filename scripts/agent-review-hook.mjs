// Dormant adapter: no installed Git hook calls this module. Activation requires
// a protected caller/configuration and verifier installation, not author opt-in.
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const OBJECT_LIMIT = 60000;
const OBJECT_BYTES = 128 * 1024 * 1024;
function refuse(condition, message) {
  if (!condition) throw new Error(`Review hook refused: ${message}`);
}
function inside(directory, path) {
  const part = relative(directory, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}
async function git(cwd, ...args) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null' });
  const { stdout } = await execute('/usr/bin/git', ['--no-replace-objects', '--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'protocol.allow=never', '-c', 'core.commitGraph=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.filemode=true', '-c', 'core.ignorestat=false', '-C', cwd, ...args], { env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  return stdout.trim();
}

/** Read raw objects once, authenticating type, length and Git object digest.
 * Bounded full-history proof deliberately refuses incomplete/shallow graphs.
 */
export async function readReviewObjects(cwd, objects) {
  refuse(Array.isArray(objects) && objects.length > 0 && objects.length <= OBJECT_LIMIT && new Set(objects).size === objects.length && objects.every(object => /^[a-f0-9]{40}$/u.test(object)), 'object inventory exceeds bounds or is invalid');
  const bytes = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/git', ['--no-replace-objects', '--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'protocol.allow=never', '-c', 'core.commitGraph=false', '-C', cwd, 'cat-file', '--batch'], { env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let count = 0; let errors = 0; let failure;
    const stop = message => { failure ??= new Error(`Review hook refused: ${message}`); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('object authentication exceeded timeout'), 30000);
    child.stdout.on('data', chunk => { count += chunk.length; if (count > OBJECT_BYTES) stop('object authentication exceeds byte bound'); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errors += chunk.length; if (errors > 64 * 1024) stop('object diagnostics exceed bounds'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => stop('object authentication refused input'));
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0) reject(new Error('Review hook refused: object authentication failed')); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(`${objects.join('\n')}\n`);
  });
  const result = new Map(); let offset = 0;
  for (const object of objects) {
    const end = bytes.indexOf(10, offset);
    refuse(end >= offset && end - offset <= 128, 'object header is invalid');
    const match = /^([a-f0-9]{40}) (blob|tree|commit) (\d+)$/u.exec(bytes.subarray(offset, end).toString('ascii'));
    refuse(match && match[1] === object && Number.isSafeInteger(Number(match[3])), 'object identity or type is invalid');
    const size = Number(match[3]); const start = end + 1; offset = start + size + 1;
    refuse(offset <= bytes.length && bytes[offset - 1] === 10, 'object content is incomplete');
    const content = bytes.subarray(start, start + size);
    refuse(createHash('sha1').update(`${match[2]} ${size}\0`).update(content).digest('hex') === object, 'object digest differs from its claimed identity');
    result.set(object, { type: match[2], bytes: content });
  }
  refuse(offset === bytes.length, 'object stream has unexpected trailing bytes');
  return result;
}

export async function verifyReviewObjectGraph(cwd, { head, base, tree }) {
  refuse([head, base].every(object => /^[a-f0-9]{40}$/u.test(object)), 'graph roots are invalid');
  const inventory = (await git(cwd, 'rev-list', '--objects', '--no-object-names', head, base, '--')).split('\n').filter(Boolean);
  const objects = await readReviewObjects(cwd, inventory);
  const references = new Map(); const parents = new Map(); const trees = new Map();
  for (const [object, entry] of objects) {
    const links = [];
    if (entry.type === 'commit') {
      const separator = entry.bytes.indexOf('\n\n');
      refuse(separator >= 0 && separator <= 1024 * 1024, 'commit header is invalid');
      const lines = entry.bytes.subarray(0, separator).toString('utf8').split('\n');
      const root = /^tree ([a-f0-9]{40})$/u.exec(lines[0]);
      refuse(root, 'commit initial tree binding is invalid');
      const ancestry = []; let offset = 1;
      while (offset < lines.length && lines[offset].startsWith('parent ')) {
        const parent = /^parent ([a-f0-9]{40})$/u.exec(lines[offset]);
        refuse(parent, 'commit parent binding is invalid');
        ancestry.push(parent[1]); offset += 1;
      }
      refuse(!lines.slice(offset).some(line => /^(tree|parent)(?: |$)/u.test(line)), 'commit tree or parent header is out of order');
      refuse(ancestry.length <= 64, 'commit ancestry exceeds bounds');
      trees.set(object, root[1]); parents.set(object, ancestry);
      links.push({ object: root[1], type: 'tree' }, ...ancestry.map(parent => ({ object: parent, type: 'commit' })));
    } else if (entry.type === 'tree') {
      let offset = 0;
      while (offset < entry.bytes.length) {
        const space = entry.bytes.indexOf(32, offset); const nul = entry.bytes.indexOf(0, space + 1);
        refuse(space > offset && space - offset <= 6 && nul > space + 1 && nul + 21 <= entry.bytes.length, 'tree entry is invalid');
        const mode = entry.bytes.subarray(offset, space).toString('ascii');
        refuse(['40000', '100644', '100755', '120000'].includes(mode), 'tree entry mode is unsupported');
        const name = entry.bytes.subarray(space + 1, nul);
        refuse(!name.includes(47) && !(name.length === 1 && name[0] === 46) && !(name.length === 2 && name[0] === 46 && name[1] === 46), 'tree entry name is invalid');
        links.push({ object: entry.bytes.subarray(nul + 1, nul + 21).toString('hex'), type: mode === '40000' ? 'tree' : 'blob', mode, name: new TextDecoder('utf-8', { fatal: true }).decode(name) });
        offset = nul + 21;
      }
    }
    references.set(object, links);
  }
  for (const root of [head, base]) refuse(objects.get(root)?.type === 'commit', 'graph root is not an authenticated commit');
  const pending = [head, base]; const reachable = new Set();
  while (pending.length) {
    const current = pending.pop(); if (reachable.has(current)) continue;
    reachable.add(current);
    for (const link of references.get(current)) {
      refuse(objects.get(link.object)?.type === link.type, 'authenticated graph is incomplete or has wrong reference types');
      pending.push(link.object);
    }
  }
  refuse(reachable.size === objects.size, 'object inventory differs from raw authenticated reachability');
  const ancestry = [head]; const seen = new Set();
  while (ancestry.length) { const current = ancestry.pop(); if (seen.has(current)) continue; seen.add(current); ancestry.push(...parents.get(current)); }
  refuse(seen.has(base), 'base is not an authenticated ancestor of candidate');
  refuse(tree === undefined || trees.get(head) === tree, 'candidate tree differs from authenticated commit');
  return { headTree: trees.get(head), baseTree: trees.get(base), objectCount: objects.size, objects, references };
}

export function reviewTreeEntries(graph, tree) {
  const result = []; const pending = [{ object: tree, prefix: '' }];
  while (pending.length) {
    const directory = pending.pop();
    refuse(graph.objects.get(directory.object)?.type === 'tree', 'authenticated directory is not a tree');
    for (const entry of graph.references.get(directory.object)) {
      const path = `${directory.prefix}${entry.name}`;
      refuse(path.length <= 4096, 'authenticated path exceeds bounds');
      if (entry.type === 'tree') pending.push({ object: entry.object, prefix: `${path}/` });
      else result.push({ path, mode: entry.mode, object: entry.object, size: graph.objects.get(entry.object).bytes.length });
      refuse(result.length + pending.length <= 30000, 'authenticated tree inventory exceeds bounds');
    }
  }
  return result;
}

async function trackedBytes(cwd, graph) {
  // Status/index metadata are author-writable. Hash actual bytes against HEAD,
  // including symlink targets and Git's executable bit, independently of them.
  const entries = reviewTreeEntries(graph, graph.headTree);
  const expectedIndex = [];
  for (const entry of entries) {
    const { mode, object: digest, size, path: name } = entry;
    expectedIndex.push(`${mode} ${digest} 0\t${name}`);
    const path = join(cwd, name);
    refuse(inside(cwd, path), 'tracked path escapes the candidate');
    refuse(await realpath(dirname(path)) === dirname(path), 'tracked directory ancestor is a symlink');
    refuse(Number.isSafeInteger(size), 'tracked blob size is invalid');
    const hash = createHash('sha1').update(`blob ${size}\0`);
    if (mode === '120000') {
      refuse((await lstat(path)).isSymbolicLink(), 'tracked symlink type changed');
      const target = await readlink(path, { encoding: 'buffer' });
      refuse(target.length === size, 'tracked symlink size changed');
      hash.update(target);
    } else {
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        refuse(metadata.isFile() && metadata.size === size, 'tracked file type or size changed');
        refuse(Boolean(metadata.mode & 0o100) === (mode === '100755'), 'tracked executable mode changed');
        let count = 0;
        for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false })) {
          count += chunk.length;
          refuse(count <= size, 'tracked file grew during verification');
          hash.update(chunk);
        }
        refuse(count === size && (await handle.stat()).size === size, 'tracked file changed during verification');
      } finally { await handle.close(); }
    }
    refuse(hash.digest('hex') === digest, 'tracked bytes differ from the committed candidate');
  }
  const index = (await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  refuse(JSON.stringify(index.sort()) === JSON.stringify(expectedIndex.sort()), 'index differs from the committed candidate');
}
export async function snapshotReviewCandidate(cwd, expected) {
  const flags = await git(cwd, 'ls-files', '-v', '-z');
  refuse(flags.split('\0').filter(Boolean).every((entry) => entry[0] !== 'S' && entry[0] === entry[0].toUpperCase()), 'index flags can conceal an incomplete or dirty candidate');
  // Never run status/diff here: candidate clean filters can execute arbitrary
  // code and mask changed bytes. These inventory operations do not run filters.
  refuse(await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z') === '', 'candidate has untracked files');
  const head = await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}');
  const tree = await git(cwd, 'rev-parse', '--verify', 'HEAD^{tree}');
  refuse(/^[a-f0-9]{40}$/u.test(expected.base), 'expected base must be a full commit digest');
  const base = await git(cwd, 'rev-parse', '--verify', `${expected.base}^{commit}`);
  // No network fetch in a hook. The protected controller must refresh this ref
  // before creating expectations; reject drift in the available ref as well.
  const currentBase = await git(cwd, 'rev-parse', '--verify', 'origin/main^{commit}');
  refuse(base === currentBase, 'expected base differs from current origin/main');
  refuse(head === expected.head && tree === expected.tree && base === expected.base, 'committed snapshot differs from trusted expectations');
  const graph = await verifyReviewObjectGraph(cwd, { head, base, tree });
  refuse(head !== base && tree !== graph.baseTree, 'baseline cannot yield task approval');
  await trackedBytes(cwd, graph);
  return { head, tree, base };
}

async function boundedFile(path, maximum) {
  // Refuse FIFOs/devices without blocking before fstat can classify them.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    refuse(metadata.isFile() && metadata.size <= maximum, 'input is not a bounded regular file');
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    refuse(bytesRead <= maximum, 'input exceeds bounds');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** `installation` and `expectation` are supplied only by a protected caller.
 * The path/digest check pins code, but filesystem permissions and service
 * isolation must be independently established before activating admission.
 */
export async function verifyReviewHook({ cwd, expectation, envelope, installation, now = Date.now }) {
  refuse(typeof now === 'function', 'protected live clock is missing');
  refuse(typeof cwd === 'string' && isAbsolute(cwd), 'candidate directory must be absolute');
  const directory = await realpath(cwd);
  refuse(directory === await git(directory, 'rev-parse', '--show-toplevel'), 'candidate directory must be its checkout root');
  refuse(installation && typeof installation.path === 'string' && isAbsolute(installation.path) && /^[a-f0-9]{64}$/u.test(installation.sha256), 'protected verifier installation is missing');
  const verifierPath = await realpath(installation.path);
  refuse(!inside(directory, verifierPath), 'verifier cannot come from the candidate checkout');
  const metadata = await stat(verifierPath);
  refuse(metadata.isFile() && metadata.size <= 128 * 1024, 'protected verifier is invalid');
  const source = await readFile(verifierPath);
  refuse(createHash('sha256').update(source).digest('hex') === installation.sha256, 'protected verifier digest differs');
  const before = await snapshotReviewCandidate(directory, expectation);
  // Node caches modules: include the pinned digest so a later authorized version
  // cannot accidentally reuse an earlier version in a long-lived controller.
  const module = await import(`${pathToFileURL(verifierPath).href}?sha256=${installation.sha256}`);
  refuse(typeof module.verifyReviewReceipt === 'function', 'protected verifier has no receipt API');
  const receipt = module.verifyReviewReceipt(envelope, { ...expectation, now: now() });
  const after = await snapshotReviewCandidate(directory, expectation);
  refuse(JSON.stringify(before) === JSON.stringify(after), 'candidate changed during receipt verification');
  module.verifyReviewReceipt(envelope, { ...expectation, now: now() });
  return receipt;
}

// The executable accepts only a candidate directory and receipt location. Key,
// policy, expectations and verifier identity come from an adjacent protected
// configuration after the adapter is installed outside the candidate checkout.
async function main() {
  refuse(process.argv.length === 4, 'usage: protected adapter <checkout> <receipt>');
  const cwd = await realpath(process.argv[2]);
  const ownPath = await realpath(fileURLToPath(import.meta.url));
  refuse(!inside(cwd, ownPath), 'this source adapter is dormant; protected installation is required');
  const configPath = new URL('./agent-review-hook.json', import.meta.url);
  const configBytes = await boundedFile(configPath, 128 * 1024);
  const receiptBytes = await boundedFile(process.argv[3], 192 * 1024);
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
  await verifyReviewHook({ cwd, envelope, expectation: config.expectation, installation: config.installation });
  process.stdout.write('Authenticated exact-candidate review evidence verified.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Review hook refused'}\n`);
    process.exitCode = 1;
  });
}
