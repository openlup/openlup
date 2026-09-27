// Dormant adapter: no installed Git hook calls this module. Activation requires
// a protected caller/configuration and verifier installation, not author opt-in.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
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
  const { stdout } = await execute('git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.filemode=true', '-c', 'core.ignorestat=false', '-C', cwd, ...args], { env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
async function trackedBytes(cwd, head) {
  // Status/index metadata are author-writable. Hash actual bytes against HEAD,
  // including symlink targets and Git's executable bit, independently of them.
  const entries = (await git(cwd, 'ls-tree', '-r', '-l', '-z', head)).split('\0').filter(Boolean);
  const expectedIndex = [];
  for (const entry of entries) {
    const row = /^(100644|100755|120000) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/u.exec(entry);
    refuse(row, 'unsupported or incomplete tracked entry');
    const [, mode, digest, length, name] = row;
    expectedIndex.push(`${mode} ${digest} 0\t${name}`);
    const path = join(cwd, name);
    refuse(inside(cwd, path), 'tracked path escapes the candidate');
    refuse(await realpath(dirname(path)) === dirname(path), 'tracked directory ancestor is a symlink');
    const size = Number(length);
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
async function snapshot(cwd, expected) {
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
  refuse(head !== base && tree !== await git(cwd, 'rev-parse', '--verify', `${base}^{tree}`), 'baseline cannot yield task approval');
  await git(cwd, 'merge-base', '--is-ancestor', base, head);
  await trackedBytes(cwd, head);
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
export async function verifyReviewHook({ cwd, expectation, envelope, installation }) {
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
  const before = await snapshot(directory, expectation);
  // Node caches modules: include the pinned digest so a later authorized version
  // cannot accidentally reuse an earlier version in a long-lived controller.
  const module = await import(`${pathToFileURL(verifierPath).href}?sha256=${installation.sha256}`);
  refuse(typeof module.verifyReviewReceipt === 'function', 'protected verifier has no receipt API');
  const receipt = module.verifyReviewReceipt(envelope, expectation);
  const after = await snapshot(directory, expectation);
  refuse(JSON.stringify(before) === JSON.stringify(after), 'candidate changed during receipt verification');
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
  await verifyReviewHook({ cwd, envelope, expectation: { ...config.expectation, now: Date.now() }, installation: config.installation });
  process.stdout.write('Authenticated exact-candidate review evidence verified.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Review hook refused'}\n`);
    process.exitCode = 1;
  });
}
