// Git object authentication shared by native session review and queue admission.
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const OBJECT_LIMIT = 60000;
const OBJECT_BYTES = 128 * 1024 * 1024;
function refuse(condition, message) {
  if (!condition) throw new Error(`Review hook refused: ${message}`);
}
async function git(cwd, ...args) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null' });
  const { stdout } = await execute('/usr/bin/git', ['--no-replace-objects', '--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'protocol.allow=never', '-c', 'core.commitGraph=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.filemode=true', '-c', 'core.ignorestat=false', '-C', cwd, ...args], { env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  return stdout.trim();
}

/** Authenticate the complete graph without retaining historical blob contents.
 * The cumulative byte bound covers the review delta and both bound snapshots;
 * every other object still has the same individual byte bound and raw proof.
 */
export async function readReviewObjects(cwd, objects, boundedObjects = objects) {
  refuse(Array.isArray(objects) && objects.length > 0 && objects.length <= OBJECT_LIMIT && new Set(objects).size === objects.length && objects.every(object => /^[a-f0-9]{40}$/u.test(object)), 'object inventory exceeds bounds or is invalid');
  const bounded = new Set(boundedObjects);
  const inventory = new Set(objects);
  refuse([...bounded].every(object => inventory.has(object)), 'bounded inventory differs from authenticated inventory');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/git', ['--no-replace-objects', '--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'protocol.allow=never', '-c', 'core.commitGraph=false', '-C', cwd, 'cat-file', '--batch'], { env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const result = new Map(); let header = Buffer.alloc(0); let current; let count = 0; let errors = 0; let failure;
    const stop = error => { failure ??= error instanceof Error ? error : new Error(`Review hook refused: ${error}`); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('object authentication exceeded timeout'), 30000);
    child.stdout.on('data', chunk => {
      if (failure) return;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          refuse(result.size < objects.length, 'object stream has unexpected trailing bytes');
          if (!current) {
            const end = chunk.indexOf(10, offset);
            const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
            refuse(header.length + part.length <= 128, 'object header is invalid');
            header = Buffer.concat([header, part]);
            if (end < 0) break;
            const match = /^([a-f0-9]{40}) (blob|tree|commit) (\d+)$/u.exec(header.toString('ascii'));
            refuse(match && match[1] === objects[result.size] && Number.isSafeInteger(Number(match[3])), 'object identity or type is invalid');
            const size = Number(match[3]); const wireSize = header.length + size + 2;
            if (bounded.has(match[1])) count += wireSize;
            refuse(wireSize <= OBJECT_BYTES && count <= OBJECT_BYTES, 'object authentication exceeds byte bound');
            current = { object: match[1], type: match[2], size, remaining: size, hash: createHash('sha1').update(`${match[2]} ${size}\0`), parts: [], retain: match[2] !== 'blob' || bounded.has(match[1]) };
            header = Buffer.alloc(0); offset = end + 1;
          }
          const length = Math.min(current.remaining, chunk.length - offset);
          const part = chunk.subarray(offset, offset + length);
          current.hash.update(part);
          if (current.retain) current.parts.push(part);
          current.remaining -= length; offset += length;
          if (current.remaining || offset === chunk.length) break;
          refuse(chunk[offset] === 10, 'object content is incomplete'); offset += 1;
          refuse(current.hash.digest('hex') === current.object, 'object digest differs from its claimed identity');
          result.set(current.object, { type: current.type, size: current.size, ...(current.retain ? { bytes: Buffer.concat(current.parts) } : {}) });
          current = undefined;
        }
      } catch (error) { stop(error); }
    });
    child.stderr.on('data', chunk => { errors += chunk.length; if (errors > 64 * 1024) stop('object diagnostics exceed bounds'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => stop('object authentication refused input'));
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Review hook refused: object authentication failed'));
      else if (current || header.length || result.size !== objects.length) reject(new Error('Review hook refused: object content is incomplete'));
      else resolve(result);
    });
    child.stdin.end(`${objects.join('\n')}\n`);
  });
}

export async function verifyReviewObjectGraph(cwd, { head, base, tree }) {
  refuse([head, base].every(object => /^[a-f0-9]{40}$/u.test(object)), 'graph roots are invalid');
  const inventory = (await git(cwd, 'rev-list', '--objects', '--no-object-names', head, base, '--')).split('\n').filter(Boolean);
  // Do not trust the base's local object store: historical objects are still
  // authenticated. Only their accumulated bytes cease to consume task budget.
  const delta = (await git(cwd, 'rev-list', '--objects', '--no-object-names', `${base}..${head}`, '--')).split('\n').filter(Boolean);
  const snapshots = (await git(cwd, 'rev-list', '--objects', '--no-object-names', '--no-walk', head, base, '--')).split('\n').filter(Boolean);
  const bounded = new Set([...delta, ...snapshots]);
  const objects = await readReviewObjects(cwd, inventory, [...bounded]);
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
  let authenticatedBytes = 0; let boundedBytes = 0;
  for (const [object, entry] of objects) {
    const bytes = object.length + entry.type.length + String(entry.size).length + entry.size + 4;
    authenticatedBytes += bytes;
    if (bounded.has(object)) boundedBytes += bytes;
  }
  return { headTree: trees.get(head), baseTree: trees.get(base), objectCount: objects.size, authenticatedBytes, boundedBytes, objects, references };
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
