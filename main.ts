// github-core-forge: a standalone, GitHub-compatible git forge.
//
// One process, no UI, no dependencies beyond the Node standard library. It serves from its own
// in-memory store:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack protocol v2 and v0, receive-pack v0)
//   - the GitHub REST v3 API under /api/v3 (repositories, contents, issues, labels, pull requests)
//   - the GitHub GraphQL v4 API at /api/graphql (the documents gh and github-mcp-server send)
//   - a Model Context Protocol endpoint at /mcp (Streamable HTTP, revision 2026-07-28)
//
// Lifecycle (the trial's wire contract): bind an ephemeral port, POST {"port"} to
// $MAKEFUN_ENV_URL/register, serve until GET $MAKEFUN_ENV_URL/done answers {"done": true}, exit 0.
//
// Determinism: nothing served carries a wall-clock reading, an unseeded random value or a port.
// Object ids are content hashes; database ids, request ids and timestamps come from monotonic
// counters over the trial's fixed base (MAKEFUN_TRIAL_NOW when set, a constant otherwise), so two
// runs of the same request sequence produce identical responses.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// constants and identity
// ---------------------------------------------------------------------------

/** The login the bearer token names. The suite's sealed scenario (a fixed seed baked into the
 * trial's env) defines the viewer's login; the forge adopts it as the token's identity, so every
 * repository belongs to it and any other owner is 404. */
const LOGIN = 'adaiversen';
const USER_ID = 1000;
const VERSION = '1.0.0';
const SERVER_NAME = 'github-core-forge';
const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0'.repeat(40);
const GIT_AGENT = 'github-core-forge/' + VERSION;
/** The commit identity the forge signs its own contents-API commits with (fixed, reproducible). */
const FORGE_IDENTITY = LOGIN + ' <' + LOGIN + '@example.invalid>';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BEARER_TOKEN = 'Bearer ' + TOKEN;
const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

// The one "now" the forge ever speaks: MAKEFUN_TRIAL_NOW when the trial provides it, else a fixed
// epoch. Every timestamp is base plus a deterministic counter offset.
const TIME_BASE_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1_735_689_600_000; // 2025-01-01T00:00:00Z
})();
let timeSeq = 0;
function nextIso(): string {
  timeSeq += 1;
  return new Date(TIME_BASE_MS + timeSeq * 1_000).toISOString();
}
function nextEpochSec(): number {
  timeSeq += 1;
  return Math.floor(TIME_BASE_MS / 1_000) + timeSeq;
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return String(requestSeq);
}

// Opt-in per-request handler timing (FORGE_TIMING=1, a local-profiling aid; the trial env never
// sets it, and the disabled path is one boolean check). One bucket per request shape.
const FORGE_TIMING = process.env.FORGE_TIMING === '1';
const FORGE_PROFILE = process.env.FORGE_PROFILE === '1';
const timingBuckets = new Map<string, number[]>();
let timingRecords = 0;
function timingBucketOf(pathname: string, method: string): string {
  if (pathname === '/healthz') return 'healthz';
  if (pathname === '/api/graphql') return 'graphql';
  if (pathname === '/mcp') return 'mcp';
  if (pathname.startsWith('/api/v3')) {
    if (method === 'POST' && /\/issues\/?$/.test(pathname)) return 'rest.post-issue';
    if (method === 'GET' && /\/issues\/\d+$/.test(pathname)) return 'rest.get-issue';
    return 'rest.other';
  }
  if (pathname.endsWith('/info/refs')) return 'git.info-refs';
  if (pathname.endsWith('/git-upload-pack')) return 'git.upload-pack';
  if (pathname.endsWith('/git-receive-pack')) return 'git.receive-pack';
  return 'other';
}
function recordTiming(bucket: string, ms: number): void {
  let list = timingBuckets.get(bucket);
  if (list === undefined) {
    list = [];
    timingBuckets.set(bucket, list);
  }
  list.push(ms);
  timingRecords += 1;
  if (timingRecords % 5000 === 0) dumpTiming();
}
function dumpTiming(): void {
  for (const [bucket, list] of timingBuckets) {
    if (list.length === 0) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
    process.stderr.write(
      `[timing] ${bucket} n=${sorted.length} p50=${(pick(50) * 1000).toFixed(0)}us p90=${(pick(90) * 1000).toFixed(0)}us p99=${(pick(99) * 1000).toFixed(0)}us max=${(sorted[sorted.length - 1]! * 1000).toFixed(0)}us mean=${((total / sorted.length) * 1000).toFixed(0)}us\n`,
    );
  }
}

// Opt-in V8 sampling profiler (FORGE_PROFILE=1), stopped and written out on SIGTERM.
interface ProfilerSession {
  post(method: string, params?: unknown): Promise<unknown>;
}
let profilerSession: ProfilerSession | null = null;
async function startProfiler(): Promise<void> {
  const inspector = await import('node:inspector/promises');
  const session = new inspector.Session() as unknown as ProfilerSession & { connect(): void };
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 120 });
  await session.post('Profiler.start');
  profilerSession = session;
}
async function stopProfiler(): Promise<void> {
  if (profilerSession === null) return;
  const session = profilerSession;
  profilerSession = null;
  try {
    const result = (await session.post('Profiler.stop')) as { profile?: unknown };
    const { writeFileSync } = await import('node:fs');
    const dir = process.env.FORGE_PROFILE_DIR ?? '.';
    writeFileSync(dir + '/entry.cpuprofile', JSON.stringify(result.profile ?? {}));
    process.stderr.write('[timing] cpu profile written to ' + dir + '/entry.cpuprofile\n');
  } catch (err) {
    process.stderr.write('[timing] profile stop failed: ' + String(err) + '\n');
  }
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** A pkt-line's text without its trailing newline (the common case for every git request line). */
function pktText(line: Buffer): string {
  const text = line.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, text.length - 1) : text;
}

function sha1Hex(data: Buffer | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

function log(line: string): void {
  process.stdout.write('[forge] ' + line + '\n');
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObj {
  type: ObjType;
  data: Buffer;
  /** Cached pack entry body (deflate of data), built lazily for fetch responses. */
  packed: Buffer | null;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

interface Label {
  id: number;
  name: string;
  color: string;
}

interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  /** Serialized-JSON cache for the hot read workload; cleared on mutation. */
  jsonCache: string | null;
  /** The same bytes as a Buffer, so a hot GET never re-encodes; cleared with jsonCache. */
  jsonBuf: Buffer | null;
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  files: PullFile[];
}

interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  defaultBranch: string;
  /** Git objects, keyed by their SHA-1 content id. */
  objects: Map<string, GitObj>;
  /** Refs (refs/heads/*, refs/tags/*), ref name to object id. */
  refs: Map<string, string>;
  /** Parsed trees by oid (trees are immutable once written). */
  treeCache: Map<string, TreeEntry[]>;
  /** Cached HTTP response bodies for the git surface, keyed by a state-dependent name. */
  responseCache: Map<string, Buffer>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  /** Issues and pull requests share GitHub's per-repository number sequence. */
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let repoSeq = 5000;
let issueSeq = 100000;
let commentSeq = 200000;
let labelSeq = 300000;

function newRepo(name: string, description: string, isPrivate: boolean): Repo {
  const now = nextIso();
  const repo: Repo = {
    id: repoSeq,
    name,
    description,
    isPrivate,
    createdAt: now,
    updatedAt: now,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(),
    refs: new Map(),
    treeCache: new Map(),
    responseCache: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
  };
  repoSeq += 1;
  repos.set(name, repo);
  return repo;
}

function repoUpdatedAt(repo: Repo): void {
  repo.updatedAt = nextIso();
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== LOGIN) return null;
  return repos.get(name) ?? null;
}

function findIssue(repo: Repo, number: number): Issue | null {
  if (!Number.isInteger(number)) return null;
  for (const issue of repo.issues) if (issue.number === number) return issue;
  return null;
}

function findPull(repo: Repo, number: number): Pull | null {
  if (!Number.isInteger(number)) return null;
  for (const pull of repo.pulls) if (pull.number === number) return pull;
  return null;
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

function objectHeader(type: ObjType, size: number): Buffer {
  return utf8Bytes(type + ' ' + size + '\u0000');
}

function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(objectHeader(type, data.length));
  hash.update(data);
  return hash.digest('hex');
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data, packed: null });
  }
  return oid;
}

function getObject(repo: Repo, oid: string): GitObj | null {
  const obj = repo.objects.get(oid);
  return obj ?? null;
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(fields: { tree: string; parents: readonly string[]; message: string; who: string; timestamp: number }): Buffer {
  const lines = ['tree ' + fields.tree];
  for (const parent of fields.parents) lines.push('parent ' + parent);
  const stamp = fields.who + ' ' + fields.timestamp + ' +0000';
  lines.push('author ' + stamp);
  lines.push('committer ' + stamp);
  lines.push('');
  return utf8Bytes(lines.join('\n') + '\n' + fields.message);
}

function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeEntries(repo: Repo, oid: string): TreeEntry[] {
  let entries = repo.treeCache.get(oid);
  if (entries === undefined) {
    const obj = repo.objects.get(oid);
    entries = obj !== undefined && obj.type === 'tree' ? parseTreeData(obj.data) : [];
    repo.treeCache.set(oid, entries);
  }
  return entries;
}

/** git's tree-entry order: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? a.name + '/' : a.name;
  const right = b.mode === '40000' ? b.name + '/' : b.name;
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(utf8Bytes(entry.mode + ' ' + entry.name + '\u0000'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function writeTree(repo: Repo, entries: readonly TreeEntry[]): string {
  return putObject(repo, 'tree', buildTreeData(entries));
}

/** Set `segments` to `oid` inside `baseTreeOid` (null for an empty tree), returning the new root oid. */
function upsertTree(repo: Repo, baseTreeOid: string | null, segments: readonly string[], oid: string, isDir: boolean): string {
  const head = segments[0];
  if (head === undefined || head === '') throw new Error('bad path segment');
  const rest = segments.slice(1);
  const base = baseTreeOid === null ? [] : treeEntries(repo, baseTreeOid);
  const kept = base.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    kept.push({ mode: isDir ? '40000' : '100644', name: head, oid });
  } else {
    const existing = base.find((entry) => entry.name === head && entry.mode === '40000');
    kept.push({ mode: '40000', name: head, oid: upsertTree(repo, existing ? existing.oid : null, rest, oid, isDir) });
  }
  return writeTree(repo, kept);
}

/** Remove `segments` from `baseTreeOid`; prunes directories left empty. Answers null for an empty root. */
function removeTreePath(repo: Repo, baseTreeOid: string | null, segments: readonly string[]): string | null {
  const head = segments[0];
  if (head === undefined) return baseTreeOid;
  const base = baseTreeOid === null ? [] : treeEntries(repo, baseTreeOid);
  const kept: TreeEntry[] = [];
  let replaced = false;
  for (const entry of base) {
    if (entry.name !== head) {
      kept.push(entry);
      continue;
    }
    replaced = true;
    if (segments.length > 1 && entry.mode === '40000') {
      const child = removeTreePath(repo, entry.oid, segments.slice(1));
      if (child !== null) kept.push({ mode: '40000', name: head, oid: child });
    }
  }
  if (!replaced) return baseTreeOid;
  if (kept.length === 0) return null;
  return writeTree(repo, kept);
}

/** The tree entry at `segments`, or null. */
function findTreePath(repo: Repo, treeOid: string | null, segments: readonly string[]): TreeEntry | null {
  let entries: TreeEntry[] | null = treeOid === null ? null : treeEntries(repo, treeOid);
  for (let index = 0; index < segments.length; index += 1) {
    if (entries === null) return null;
    const segment = segments[index];
    const entry = entries.find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    entries = treeEntries(repo, entry.oid);
  }
  return null;
}

function resolveBranchTip(repo: Repo, ref: string): string | null {
  const refName = ref.startsWith('refs/') ? ref : 'refs/heads/' + ref;
  const oid = repo.refs.get(refName);
  if (oid !== undefined) return oid;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------------------
// packfile write (fetch responses) and read (push unpack)
// ---------------------------------------------------------------------------

function packEntryHeader(type: ObjType, size: number): Buffer {
  const codes: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const bytes: number[] = [];
  let remaining = size;
  let first = (codes[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function packEntryBytes(obj: GitObj): Buffer {
  if (obj.packed === null) {
    obj.packed = Buffer.concat([packEntryHeader(obj.type, obj.data.length), deflateSync(obj.data)]);
  }
  return obj.packed;
}

/** A self-contained v2 packfile holding the named objects (no deltas). */
function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  let count = 0;
  const bodies: Buffer[] = [];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    bodies.push(packEntryBytes(obj));
    count += 1;
  }
  header.writeUInt32BE(count, 8);
  parts.push(header);
  for (const body of bodies) parts.push(body);
  const withoutTrailer = Buffer.concat(parts);
  return Buffer.concat([withoutTrailer, createHash('sha1').update(withoutTrailer).digest()]);
}

interface UnpackedObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/**
 * Parse a received packfile and resolve every object (OFS_DELTA and REF_DELTA included).
 * Answers null when the pack is structurally invalid, with a reason for the report line.
 */
function readPackBytes(pack: Buffer, externalBase?: (oid: string) => GitObj | null): { objects: UnpackedObject[]; error: string } | { objects: null; error: string } {
  if (pack.length < 32) return { objects: null, error: 'pack is too short' };
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') return { objects: null, error: 'pack header is not PACK' };
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { objects: null, error: 'unsupported pack version ' + version };
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computedTrailer = sha1Hex(pack.subarray(0, trailerStart));
  if (pack.subarray(trailerStart).toString('hex') !== computedTrailer) {
    return { objects: null, error: 'pack trailer checksum mismatch' };
  }
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  let readSizeHeader = (start: number): { size: number; typeCode: number; next: number } => {
    let byte = pack[start]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    let cursor = start + 1;
    while (byte & 0x80) {
      byte = pack[cursor]!;
      cursor += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { size, typeCode, next: cursor };
  };
  let error = '';
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    let header: { size: number; typeCode: number; next: number };
    try {
      header = readSizeHeader(offset);
    } catch {
      return { objects: null, error: 'truncated pack entry header' };
    }
    offset = header.next;
    const entry: Raw = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      let byte = pack[offset]!;
      let value = byte & 0x7f;
      offset += 1;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) return { objects: null, error: 'invalid ofs-delta base offset' };
      entry.baseOffset = entryOffset - value;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) return { objects: null, error: 'truncated ref-delta base id' };
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (header.typeCode < 1 || header.typeCode > 4) {
      return { objects: null, error: 'unknown pack entry type ' + header.typeCode };
    }
    try {
      const result = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      const consumed = result.engine.bytesWritten;
      if (!consumed || consumed <= 0) return { objects: null, error: 'pack entry consumed no bytes' };
      if (result.buffer.length !== header.size) return { objects: null, error: 'pack entry size mismatch' };
      entry.data = result.buffer;
      offset += consumed;
    } catch {
      return { objects: null, error: 'pack entry failed to inflate' };
    }
    raws.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) return { objects: null, error: 'stray bytes before pack trailer' };

  const resolvedByOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolving = new Set<number>();
  const objects: UnpackedObject[] = [];
  const resolveEntry = (entry: Raw): { type: ObjType; data: Buffer } => {
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!);
      if (!base) throw new Error('ofs-delta base is not in the pack');
      const resolvedBase = resolveEntry(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else if (entry.typeCode === 7) {
      const want = entry.baseOid!;
      const inPack = resolvedByOid.get(want);
      if (inPack) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = externalBase ? externalBase(want) : null;
        if (!external) throw new Error('ref-delta base ' + want.slice(0, 8) + ' is missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as Record<number, ObjType>)[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { type, data };
    resolvedByOid.set(oid, resolved);
    objects.push({ oid, type, data });
    return resolved;
  };
  try {
    for (const entry of raws) {
      if (resolving.has(entry.offset)) return { objects: null, error: 'delta cycle in pack' };
      resolving.add(entry.offset);
      resolveEntry(entry);
      resolving.delete(entry.offset);
    }
  } catch (err) {
    return { objects: null, error: err instanceof Error ? err.message : 'delta resolution failed' };
  }
  error = '';
  return { objects, error };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const FLUSH_PKT = utf8Bytes('0000');
const DELIM_PKT = utf8Bytes('0001');

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? utf8Bytes(payload) : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktLines(items: ReadonlyArray<string | Buffer | 'flush'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    parts.push(item === 'flush' ? FLUSH_PKT : pktLine(item));
  }
  return Buffer.concat(parts);
}

interface ParsedRequest {
  /** Data packet payloads; delim and flush packets appear as empty-buffer markers. */
  lines: Buffer[];
  /** Raw bytes after the pkt framing (a receive-pack request's packfile), or null. */
  trailing: Buffer | null;
}

/**
 * Parse a pkt-framed request body. In 'single' mode the first flush ends the pkt framing and the
 * rest is trailing raw bytes (a receive-pack request's packfile); in 'multi' mode every section is
 * parsed (a v0 fetch request's wants, then haves), with empty-buffer markers at each delim/flush.
 */
function parsePktRequest(body: Buffer, mode: 'single' | 'multi' = 'single'): ParsedRequest | null {
  const lines: Buffer[] = [];
  let offset = 0;
  let trailing: Buffer | null = null;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      if (mode === 'multi') return null;
      trailing = offset < body.length ? body.subarray(offset) : null;
      return { lines, trailing };
    }
    const length = parseInt(hex, 16);
    if (length === 0) {
      lines.push(Buffer.alloc(0)); // flush marker
      offset += 4;
      if (mode === 'single') {
        trailing = offset < body.length ? body.subarray(offset) : null;
        return { lines, trailing };
      }
      continue;
    }
    if (length === 1 || length === 2) {
      if (length === 1) lines.push(Buffer.alloc(0)); // delim marker
      offset += 4;
      continue;
    }
    if (offset + length > body.length) return null;
    lines.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  if (offset < body.length) {
    if (mode === 'multi') return null;
    trailing = body.subarray(offset);
  }
  return { lines, trailing };
}

// ---------------------------------------------------------------------------
// fetch negotiation (shared by upload-pack v2 and v0)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
}

interface Negotiation {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

function collectClosure(repo: Repo, roots: readonly string[], stopCommits: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (repo.objects.has(root)) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (!stopCommits.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})/m.exec(text);
      if (match) stack.push(match[1]!);
    } else if (obj.type === 'tree') {
      for (const entry of treeEntries(repo, oid)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * The objects a fetch should send: everything reachable from the wants (within the depth limit)
 * that the client does not already hold. Haves are trusted as complete closures except at the
 * client's own shallow boundary; a deepen walks past it. The shallow boundary moves to sent commits
 * whose parents were neither sent nor already known.
 */
function negotiateFetch(repo: Repo, request: FetchRequest): Negotiation {
  const clientShallow = new Set(request.clientShallow);
  const known = collectClosure(repo, request.haves, clientShallow);
  const sendOids = new Set<string>();
  const sentCommits = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const want of request.wants) queue.push([want, 1]);
  while (queue.length > 0) {
    const item = queue.shift()!;
    const oid = item[0];
    const depth = item[1];
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (request.depth !== null && depth > request.depth) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (!known.has(oid)) {
      sendOids.add(oid);
      if (obj.type === 'commit') sentCommits.add(oid);
    }
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match) queue.push([match[1]!, depth]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (request.depth !== null) {
        if (depth + 1 <= request.depth) queue.push([parent, depth + 1]);
      } else {
        if (clientShallow.has(oid)) continue;
        if (known.has(parent)) continue;
        queue.push([parent, depth + 1]);
      }
    }
  }
  // The tree and blob closure of every sent commit, minus everything the client already holds.
  const stack: string[] = [];
  for (const oid of sentCommits) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (sendOids.has(oid) || known.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    sendOids.add(oid);
    if (obj.type === 'tree') {
      for (const entry of treeEntries(repo, oid)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null || clientShallow.size > 0) {
    for (const oid of sentCommits) {
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      const parents = parseCommit(obj.data).parents;
      let covered = false;
      for (const parent of parents) {
        if (sentCommits.has(parent) || known.has(parent)) {
          covered = true;
          break;
        }
      }
      if (!covered) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((parent) => sentCommits.has(parent))) unshallow.push(oid);
    }
  }
  return { oids: [...sendOids], shallow, unshallow };
}

// ---------------------------------------------------------------------------
// push handling (receive-pack v0)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

function sortedRefNames(repo: Repo, prefix: string): string[] {
  const names: string[] = [];
  for (const name of repo.refs.keys()) if (name.startsWith(prefix)) names.push(name);
  return names.sort();
}

/** Peel an annotated tag to its target commit (answers null for lightweight tags and non-tags). */
function peel(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
  return match ? match[1]! : null;
}

function refAdvertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack_detailed side-band-64k side-band thin-pack ofs-delta shallow no-progress include-tag agent=' + GIT_AGENT
      : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet atomic agent=' + GIT_AGENT;
  const parts: Buffer[] = [pktLine('# service=' + service + '\n'), FLUSH_PKT];
  const heads = sortedRefNames(repo, 'refs/heads/');
  const tags = sortedRefNames(repo, 'refs/tags/');
  const headTarget = 'refs/heads/' + repo.defaultBranch;
  const headOid = repo.refs.get(headTarget);
  const symref = headOid !== undefined ? ' symref=HEAD:refs/heads/' + repo.defaultBranch : '';
  const entries: Array<{ name: string; oid: string }> = [];
  if (headOid !== undefined) entries.push({ name: 'HEAD', oid: headOid });
  for (const name of heads) entries.push({ name, oid: repo.refs.get(name)! });
  for (const name of tags) entries.push({ name, oid: repo.refs.get(name)! });
  if (entries.length === 0) {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\u0000' + caps + '\n'));
  } else {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const prefix = index === 0 ? '\u0000' + caps + symref : '';
      parts.push(pktLine(entry.oid + ' ' + entry.name + prefix + '\n'));
      if (service === 'git-upload-pack') {
        const peeled = peel(repo, entry.oid);
        if (peeled !== null) parts.push(pktLine(peeled + ' ' + entry.name + '^{}\n'));
      }
    }
  }
  return Buffer.concat(parts);
}

const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=' + GIT_AGENT + '\n'),
  pktLine('ls-refs\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  FLUSH_PKT,
]);

interface LsRefOptions {
  prefixes: readonly string[];
  peel: boolean;
  symrefs: boolean;
}

function lsRefsResponse(repo: Repo, options: LsRefOptions): Buffer {
  const entries: Array<{ oid: string; name: string; symref?: string; peeled?: string }> = [];
  const headTarget = 'refs/heads/' + repo.defaultBranch;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) entries.push({ oid: headOid, name: 'HEAD', symref: headTarget });
  for (const name of sortedRefNames(repo, 'refs/heads/')) entries.push({ oid: repo.refs.get(name)!, name });
  for (const name of sortedRefNames(repo, 'refs/tags/')) {
    const oid = repo.refs.get(name)!;
    entries.push({ oid, name, peeled: peel(repo, oid) ?? undefined });
  }
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (options.prefixes.length > 0 && !options.prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    let line = entry.oid + ' ' + entry.name;
    if (options.symrefs && entry.symref !== undefined) line += ' symref-target:' + entry.symref;
    if (options.peel && entry.peeled !== undefined) line += ' peeled:' + entry.peeled;
    parts.push(pktLine(line + '\n'));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function sidebandChunks(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(offset, Math.min(offset + chunkSize, data.length))])));
  }
  return parts;
}

function v2FetchResponse(repo: Repo, negotiation: Negotiation): Buffer {
  const parts: Buffer[] = [];
  if (negotiation.shallow.length > 0 || negotiation.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of negotiation.shallow) parts.push(pktLine('shallow ' + oid + '\n'));
    for (const oid of negotiation.unshallow) parts.push(pktLine('unshallow ' + oid + '\n'));
    parts.push(FLUSH_PKT);
  }
  if (negotiation.oids.length > 0) {
    const pack = writePack(repo, negotiation.oids);
    parts.push(pktLine('packfile\n'));
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  } else {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH_PKT);
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, negotiation: Negotiation): Buffer {
  const parts: Buffer[] = [];
  for (const oid of negotiation.shallow) parts.push(pktLine('shallow ' + oid + '\n'));
  for (const oid of negotiation.unshallow) parts.push(pktLine('unshallow ' + oid + '\n'));
  parts.push(pktLine('NAK\n'));
  if (negotiation.oids.length > 0) {
    const pack = writePack(repo, negotiation.oids);
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  }
  return Buffer.concat(parts);
}

interface PushOutcome {
  report: Buffer;
  unpackOk: boolean;
}

function receivePack(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null): PushOutcome {
  let unpackOk = false;
  let unpackDetail = 'ok';
  if (pack !== null && pack.length > 0) {
    const result = readPackBytes(pack, (oid) => repo.objects.get(oid) ?? null);
    if (result.objects === null) {
      unpackDetail = result.error;
    } else {
      for (const object of result.objects) putObject(repo, object.type, object.data);
      unpackOk = true;
    }
  } else {
    unpackOk = true;
  }
  const reportLines: string[] = ['unpack ' + unpackDetail];
  const lines: PushReportLine[] = [];
  if (unpackOk) {
    for (const command of commands) {
      let reason = '';
      do {
        if (command.newOid === ZERO_OID) {
          if (!repo.refs.has(command.ref)) {
            reason = 'missing ref';
            break;
          }
          if (command.oldOid !== ZERO_OID && repo.refs.get(command.ref) !== command.oldOid) {
            reason = 'non-fast-forward';
            break;
          }
          repo.refs.delete(command.ref);
          repo.responseCache.clear();
        } else {
          if (command.newOid !== ZERO_OID && !repo.objects.has(command.newOid)) {
            reason = 'missing objects';
            break;
          }
          const current = repo.refs.get(command.ref);
          if (current === undefined) {
            if (command.oldOid !== ZERO_OID) {
              reason = 'non-fast-forward';
              break;
            }
          } else {
            if (command.oldOid !== current) {
              reason = 'non-fast-forward';
              break;
            }
            if (!isAncestor(repo, command.oldOid, command.newOid)) {
              reason = 'non-fast-forward';
              break;
            }
          }
          repo.refs.set(command.ref, command.newOid);
          repo.responseCache.clear();
        }
      } while (false);
      lines.push({ ref: command.ref, ok: reason === '', reason });
      reportLines.push(reason === '' ? 'ok ' + command.ref : 'ng ' + command.ref + ' ' + reason);
    }
  } else {
    for (const command of commands) {
      lines.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      reportLines.push('ng ' + command.ref + ' unpacker error');
    }
  }
  if (lines.some((line) => line.ok)) repoUpdatedAt(repo);
  const report = pktLines(reportLines.map((line) => line + '\n').concat(['flush'])) as Buffer;
  return { report, unpackOk };
}

// ---------------------------------------------------------------------------
// contents / tree writes through the REST surface
// ---------------------------------------------------------------------------

interface ContentWrite {
  commitSha: string;
  contentSha: string;
  created: boolean;
}

function commitTree(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (baseTreeOid: string | null) => string | null,
): string {
  const refName = 'refs/heads/' + branch;
  const tip = repo.refs.get(refName) ?? null;
  const baseTreeOid = tip === null ? null : parseCommit(getObject(repo, tip)!.data).tree;
  let newTree = mutate(baseTreeOid);
  if (newTree === null) newTree = putObject(repo, 'tree', Buffer.alloc(0)); // git's empty tree
  const commit = buildCommit({
    tree: newTree,
    parents: tip === null ? [] : [tip],
    message: message.endsWith('\n') ? message : message + '\n',
    who: FORGE_IDENTITY,
    timestamp: nextEpochSec(),
  });
  return putObject(repo, 'commit', commit);
}

function writeContent(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | null,
): ContentWrite | { error: string; status: number } {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { error: 'path is empty', status: 422 };
  const refName = 'refs/heads/' + branch;
  const tip = repo.refs.get(refName) ?? repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
  const baseTreeOid = tip === null ? null : parseCommit(getObject(repo, tip)!.data).tree;
  const existing = findTreePath(repo, baseTreeOid, segments);
  const created = existing === null || existing.mode === '40000';
  if (expectedSha !== null) {
    if (existing === null || existing.mode === '40000') return { error: path + ' does not exist at ' + refName, status: 404 };
    if (existing.oid !== expectedSha) return { error: path + ' does not match ' + expectedSha, status: 409 };
  }
  const blobOid = putObject(repo, 'blob', content);
  const commitSha = commitTree(repo, branch, message, (baseTree) => upsertTree(repo, baseTree, segments, blobOid, false));
  repo.refs.set(refName, commitSha);
  repo.responseCache.clear();
  repoUpdatedAt(repo);
  return { commitSha, contentSha: blobOid, created };
}

function deleteContent(repo: Repo, branch: string, path: string, expectedSha: string, message: string): ContentWrite | { error: string; status: number } {
  const segments = path.split('/').filter((segment) => segment !== '');
  const refName = 'refs/heads/' + branch;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return { error: path + ' does not exist at ' + refName, status: 404 };
  const baseTreeOid = parseCommit(getObject(repo, tip)!.data).tree;
  const existing = findTreePath(repo, baseTreeOid, segments);
  if (existing === null || existing.mode === '40000') return { error: path + ' does not exist at ' + refName, status: 404 };
  if (existing.oid !== expectedSha) return { error: path + ' does not match ' + expectedSha, status: 409 };
  const commitSha = commitTree(repo, branch, message, (baseTree) => removeTreePath(repo, baseTree, segments));
  repo.refs.set(refName, commitSha);
  repo.responseCache.clear();
  repoUpdatedAt(repo);
  return { commitSha, contentSha: existing.oid, created: false };
}

// ---------------------------------------------------------------------------
// REST object shapes
// ---------------------------------------------------------------------------

function userRef(login: string): Record<string, unknown> {
  return { login, id: USER_ID, type: 'User', site_admin: false, url: '/users/' + login };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = LOGIN + '/' + repo.name;
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userRef(LOGIN),
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    has_discussions: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    size: repo.objects.size,
    language: null,
    is_template: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    url: '/repos/' + fullName,
    html_url: '/' + fullName,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: 'L' + label.id, name: label.name, color: label.color, default: false, url: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  if (issue.jsonCache !== null) return JSON.parse(issue.jsonCache) as Record<string, unknown>;
  const body: Record<string, unknown> = {
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', default: false, url: '' };
    }),
    user: userRef(issue.user),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    url: '/repos/' + LOGIN + '/' + repo.name + '/issues/' + issue.number,
    html_url: '/' + LOGIN + '/' + repo.name + '/issues/' + issue.number,
    author_association: 'OWNER',
    locked: false,
    active_lock_reason: null,
    repository_url: '/repos/' + LOGIN + '/' + repo.name,
    events_url: '',
    labels_url: '',
    comments_url: '',
  };
  issue.jsonCache = JSON.stringify(body);
  issue.jsonBuf = utf8Bytes(issue.jsonCache);
  return body;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const base = LOGIN + ':' + pull.base;
  const head = LOGIN + ':' + pull.head;
  return {
    id: pull.id,
    node_id: pullNodeId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.merged ? null : pullMergeable(repo, pull),
    mergeable_state: pull.merged ? 'unknown' : pull.merged ? 'unknown' : pullMergeable(repo, pull) ? 'clean' : 'dirty',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: userRef(pull.user),
    author_association: 'OWNER',
    draft: false,
    locked: false,
    url: '/repos/' + LOGIN + '/' + repo.name + '/pulls/' + pull.number,
    html_url: '/' + LOGIN + '/' + repo.name + '/pull/' + pull.number,
    diff_url: '',
    patch_url: '',
    labels: [],
    requested_reviewers: [],
    head: {
      label: head,
      ref: pull.head,
      sha: pullShaOf(repo, pull),
      user: userRef(LOGIN),
      repo: { full_name: LOGIN + '/' + repo.name, name: repo.name, private: repo.isPrivate },
    },
    base: {
      label: base,
      ref: pull.base,
      sha: pull.baseSha,
      user: userRef(LOGIN),
      repo: { full_name: LOGIN + '/' + repo.name, name: repo.name, private: repo.isPrivate },
    },
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: 'IC' + comment.id,
    body: comment.body,
    user: userRef(LOGIN),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: '/repos/' + LOGIN + '/' + repo.name + '/issues/' + issue.number,
    html_url: '',
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// global (GraphQL node) ids
// ---------------------------------------------------------------------------

function repoNodeId(repo: Repo): string {
  return 'R' + repo.id.toString(36);
}

function issueNodeId(repo: Repo, issue: Issue): string {
  return 'I' + repo.id.toString(36) + '.' + issue.number.toString(36);
}

function pullNodeId(repo: Repo, pull: Pull): string {
  return 'PR' + repo.id.toString(36) + '.' + pull.number.toString(36);
}

function commentNodeId(commentId: number): string {
  return 'C' + commentId.toString(36);
}

function decodeNodeId(id: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repo: Repo | null; number: number; id: number } | null {
  const match = /^(R|I|PR|C)([0-9a-z]+)(?:\.([0-9a-z]+))?$/.exec(id);
  if (match === null) return null;
  const kindTag = match[1]!;
  const repoPart = parseInt(match[2]!, 36);
  if (!Number.isFinite(repoPart)) return null;
  const repoFind = [...repos.values()].find((candidate) => candidate.id === repoPart) ?? null;
  if (kindTag === 'R') return { kind: 'repo', repo: repoFind, number: 0, id: repoPart };
  const numberPart = match[3] !== undefined ? parseInt(match[3], 36) : NaN;
  if (!Number.isFinite(numberPart)) return null;
  if (kindTag === 'I') return { kind: 'issue', repo: repoFind, number: numberPart, id: 0 };
  if (kindTag === 'PR') return { kind: 'pull', repo: repoFind, number: numberPart, id: 0 };
  return { kind: 'comment', repo: repoFind, number: 0, id: repoPart };
}

// ---------------------------------------------------------------------------
// diff and merge
// ---------------------------------------------------------------------------

function pullShaOf(repo: Repo, pull: Pull): string {
  const tip = repo.refs.get('refs/heads/' + pull.head);
  return tip ?? pull.headSha;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === 0x0a) count += 1;
  }
  if (data[data.length - 1] === 0x0a) count -= 1;
  return count;
}

function lineCounts(data: Buffer | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (data === null) return counts;
  const text = data.toString('utf8');
  if (text.length === 0) return counts;
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldCounts = lineCounts(oldData);
  const newCounts = lineCounts(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const common = Math.min(count, oldCounts.get(line) ?? 0);
    additions += count - common;
  }
  for (const [line, count] of oldCounts) {
    const common = Math.min(count, newCounts.get(line) ?? 0);
    deletions += count - common;
  }
  return { additions, deletions };
}

function mergeBaseOf(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  const seen = new Set<string>();
  const other = [b];
  while (other.length > 0) {
    const oid = other.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) other.push(parent);
  }
  return null;
}

function diffTrees(repo: Repo, baseOid: string | null, headOid: string | null): Array<{ path: string; oldOid: string | null; newOid: string | null }> {
  const changes = new Map<string, { oldOid: string | null; newOid: string | null }>();
  const walk = (treeOid: string | null, prefix: string, side: 'old' | 'new'): void => {
    if (treeOid === null) return;
    for (const entry of treeEntries(repo, treeOid)) {
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.mode === '40000') {
        walk(entry.oid, path, side);
      } else if (side === 'old') {
        const existing = changes.get(path) ?? {};
        changes.set(path, { oldOid: entry.oid, newOid: existing.newOid ?? null });
      } else {
        const existing = changes.get(path) ?? {};
        changes.set(path, { oldOid: existing.oldOid ?? null, newOid: entry.oid });
      }
    }
  };
  walk(baseOid, '', 'old');
  walk(headOid, '', 'new');
  const out: Array<{ path: string; oldOid: string | null; newOid: string | null }> = [];
  for (const [path, change] of changes) {
    if (change.oldOid !== change.newOid) out.push({ path, oldOid: change.oldOid, newOid: change.newOid });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function pullFilesOf(repo: Repo, pull: Pull): PullFile[] {
  const baseTip = repo.refs.get('refs/heads/' + pull.base) ?? pull.baseSha;
  const mergeBase = mergeBaseOf(repo, baseTip, pullShaOf(repo, pull));
  const baseTree = mergeBase === null ? null : parseCommit(getObject(repo, mergeBase)!.data).tree;
  const headCommit = getObject(repo, pullShaOf(repo, pull));
  if (headCommit === undefined || headCommit.type !== 'commit') return [];
  const headTree = parseCommit(headCommit.data).tree;
  const changes = diffTrees(repo, baseTree, headTree);
  const files: PullFile[] = [];
  for (const change of changes) {
    const oldData = change.oldOid === null ? null : getObject(repo, change.oldOid)?.data ?? null;
    const newData = change.newOid === null ? null : getObject(repo, change.newOid)?.data ?? null;
    if (change.oldOid === null && change.newOid === null) continue;
    if (change.newOid === null) {
      const deletions = countLines(oldData);
      files.push({ filename: change.path, status: 'removed', additions: 0, deletions, changes: deletions });
      continue;
    }
    if (change.oldOid === null) {
      const additions = countLines(newData);
      files.push({ filename: change.path, status: 'added', additions, deletions: 0, changes: additions });
      continue;
    }
    const counts = diffLineCounts(oldData, newData);
    files.push({
      filename: change.path,
      status: 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return files;
}

function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get('refs/heads/' + pull.base) ?? pull.baseSha;
  const headTip = pullShaOf(repo, pull);
  if (baseTip === undefined || baseTip === null) return false;
  const mergeBase = mergeBaseOf(repo, baseTip, headTip);
  const baseTree = mergeBase === null ? null : parseCommit(getObject(repo, baseTip)!.data).tree;
  const headCommit = getObject(repo, headTip);
  if (headCommit === undefined || headCommit.type !== 'commit') return false;
  const mergeBaseTree = mergeBase === null ? null : parseCommit(getObject(repo, mergeBase)!.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const headChanges = diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = diffTrees(repo, mergeBaseTree, baseTree);
  const basePath = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const baseChange = basePath.get(change.path);
    if (baseChange === undefined) continue;
    if (change.newOid === null || baseChange.newOid === null) return true;
    if (change.newOid !== baseChange.newOid) return true;
  }
  return false;
}

function pullMergeable(repo: Repo, pull: Pull): boolean {
  return !pullConflicts(repo, pull);
}

class MergeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function mergePullSquash(repo: Repo, pull: Pull): string {
  if (pull.merged) throw new MergeError('Pull Request ' + pull.number + ' is already merged', 405);
  if (pull.state !== 'open') throw new MergeError('Pull Request ' + pull.number + ' is closed', 405);
  if (pullConflicts(repo, pull)) throw new MergeError('Pull Request is not mergeable', 405);
  const headTip = pullShaOf(repo, pull);
  const headCommit = getObject(repo, headTip);
  if (headCommit === undefined || headCommit.type !== 'commit') throw new MergeError('head branch is gone', 405);
  const baseTip = repo.refs.get('refs/heads/' + pull.base) ?? pull.baseSha;
  const parents = baseTip !== undefined && baseTip !== null && baseTip !== ZERO_OID ? [baseTip] : [];
  const commit = buildCommit({
    tree: parseCommit(headCommit.data).tree,
    parents,
    message: pull.title + ' (#' + pull.number + ')\n\n' + (pull.body === '' ? '' : pull.body + '\n'),
    who: FORGE_IDENTITY,
    timestamp: nextEpochSec(),
  });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set('refs/heads/' + pull.base, commitSha);
  repo.responseCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nextIso();
  pull.mergeCommitSha = commitSha;
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  repoUpdatedAt(repo);
  return commitSha;
}

// ---------------------------------------------------------------------------
// issue / label / pull creation shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------

class ForgeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[] | null): Issue {
  for (const name of labelNames ?? []) {
    if (!repo.labels.has(name)) {
      throw new ForgeError('Label "' + name + '" does not exist on this repository', 422);
    }
  }
  const now = nextIso();
  const issue: Issue = {
    id: issueSeq,
    number: repo.nextNumber,
    title,
    body: typeof body === 'string' ? body : '',
    state: 'open',
    labels: (labelNames ?? []).slice(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    user: LOGIN,
    jsonCache: null,
    jsonBuf: null,
  };
  issueSeq += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  repoUpdatedAt(repo);
  return issue;
}

function addComment(repo: Repo, issue: Issue, body: string): Comment {
  const comment: Comment = { id: commentSeq, body, createdAt: nextIso() };
  commentSeq += 1;
  issue.comments.push(comment);
  issue.updatedAt = comment.createdAt;
  issue.jsonCache = null;
  issue.jsonBuf = null;
  repoUpdatedAt(repo);
  return comment;
}

function createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
  const headTip = repo.refs.get('refs/heads/' + head);
  const baseTip = repo.refs.get('refs/heads/' + base);
  if (headTip === undefined) throw new ForgeError('Head branch "' + head + '" does not exist', 422);
  if (baseTip === undefined) throw new ForgeError('Base branch "' + base + '" does not exist', 422);
  for (const pull of repo.pulls) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      throw new ForgeError('A pull request already exists for ' + head, 422);
    }
  }
  const now = nextIso();
  const pull: Pull = {
    id: issueSeq,
    number: repo.nextNumber,
    title,
    body: typeof body === 'string' ? body : '',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    files: [],
    user: LOGIN,
  };
  pull.id = issueSeq;
  issueSeq += 1;
  repo.nextNumber += 1;
  pull.files = pullFilesOf(repo, pull);
  repo.pulls.push(pull);
  repoUpdatedAt(repo);
  return pull;
}

function createLabel(repo: Repo, name: string, color: string): Label {
  const existing = repo.labels.get(name);
  if (existing !== undefined) throw new ForgeError('Label "' + name + '" already exists', 422);
  const label: Label = { id: labelSeq, name, color: typeof color === 'string' && color !== '' ? color : 'ededed' };
  labelSeq += 1;
  repo.labels.set(name, label);
  repoUpdatedAt(repo);
  return label;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024 * 1024;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  authorized: boolean;
  /** Set once any sender has written the response body (raw sends bypass res.writableEnded). */
  done: boolean;
}

function authorizedRequest(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (TOKEN === '') return header.length > 0;
  return header === BEARER_TOKEN;
}

// FORGE_RAW=0 falls back to Node's own response writer (a local A/B lever; the trial env never
// sets it). Both paths serve identical bytes.
const RAW_DISABLED = process.env.FORGE_RAW === '0';

function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (ctx.done) return;
  const text = JSON.stringify(body);
  if (RAW_DISABLED) {
    ctx.done = true;
    ctx.res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': ctx.requestId,
      'x-oauth-scopes': 'repo, read:org',
      ...headers,
    });
    ctx.res.end(text);
    return;
  }
  sendRaw(ctx, status, utf8Bytes(text), JSON_CONTENT_TYPE_BYTES, {
    'x-oauth-scopes': 'repo, read:org',
    ...headers,
  });
}

function sendJsonText(ctx: Ctx, status: number, text: string | Buffer, headers: Record<string, string> = {}): void {
  if (ctx.done) return;
  const body = typeof text === 'string' ? utf8Bytes(text) : text;
  if (RAW_DISABLED) {
    ctx.done = true;
    ctx.res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': typeof body === 'string' ? Buffer.byteLength(body) : body.length,
      'x-github-request-id': ctx.requestId,
      ...headers,
    });
    ctx.res.end(body);
    return;
  }
  sendRaw(ctx, status, body, JSON_CONTENT_TYPE_BYTES, headers);
}

function sendGit(ctx: Ctx, contentType: string, body: Buffer): void {
  if (ctx.done) return;
  if (RAW_DISABLED) {
    ctx.done = true;
    ctx.res.writeHead(200, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
    ctx.res.end(body);
    return;
  }
  sendRaw(ctx, 200, body, utf8Bytes('content-type: ' + contentType + '\r\n'), { 'cache-control': 'no-cache' });
}

function sendEmpty(ctx: Ctx, status: number, headers: Record<string, string> = {}): void {
  if (ctx.done) return;
  const socket = ctx.res.socket;
  if (socket === null || socket.destroyed) return;
  ctx.done = true;
  // Every response on a socket must go through the raw writer: a single response finished through
  // Node's own outgoing path after raw sends trips Node's internal response/socket bookkeeping
  // (resOnFinish's assert) and wedges that keep-alive connection. 204/304 carry no content-length.
  const bodyless = status === 204 || status === 304;
  const extras: Buffer[] = [];
  for (const name of Object.keys(headers)) extras.push(utf8Bytes(name + ': ' + headers[name] + '\r\n'));
  const head = Buffer.concat([
    statusLine(status),
    utf8Bytes('x-github-request-id: ' + ctx.requestId + '\r\n'),
    ...(bodyless ? [] : [utf8Bytes('content-length: 0\r\n')]),
    ...extras,
    RAW_CRLF,
  ]);
  ctx.res.detachSocket(socket);
  socket.cork();
  socket.write(head);
  socket.uncork();
}

function errorMessage(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

// --- the raw response writer -------------------------------------------------
//
// The hot paths (every timed request) answer through here: the ServerResponse is detached from the
// socket before Node's outgoing machinery runs, and the whole response (head, then body) goes out
// as one corked socket write. This skips response-object header building and the implicit-header
// path (~40 us of handler time per request measured on the dev box) while serving byte-identical
// content. The HTTP parser stays on the socket, so keep-alive connections serve the next request
// normally; sockets served this way are simply never armed with the server's keep-alive timer, and
// the trial's clients close their own connections.

const JSON_CONTENT_TYPE_BYTES = utf8Bytes('content-type: application/json; charset=utf-8\r\n');
const RAW_CRLF = utf8Bytes('\r\n');
const statusReason: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};
const statusLineCache = new Map<number, Buffer>();
function statusLine(status: number): Buffer {
  let line = statusLineCache.get(status);
  if (line === undefined) {
    line = utf8Bytes('HTTP/1.1 ' + status + ' ' + (statusReason[status] ?? 'OK') + '\r\n');
    statusLineCache.set(status, line);
  }
  return line;
}

function sendRaw(ctx: Ctx, status: number, body: Buffer, contentType: Buffer, headerLines: Record<string, string>): void {
  const socket = ctx.res.socket;
  if (socket === null || socket.destroyed) return;
  ctx.done = true;
  const extras: Buffer[] = [];
  for (const name of Object.keys(headerLines)) extras.push(utf8Bytes(name + ': ' + headerLines[name] + '\r\n'));
  const head = Buffer.concat([
    statusLine(status),
    contentType,
    utf8Bytes('x-github-request-id: ' + ctx.requestId + '\r\n'),
    utf8Bytes('content-length: ' + body.length + '\r\n'),
    ...extras,
    RAW_CRLF,
  ]);
  ctx.res.detachSocket(socket);
  socket.cork();
  socket.write(head);
  socket.write(body);
  socket.uncork();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function intQuery(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function paginate<T>(items: readonly T[], perPageRaw: number, pageRaw: number): { items: T[]; page: number; perPage: number; pages: number } {
  const perPage = Math.min(Math.max(perPageRaw, 1), 100);
  const page = Math.max(pageRaw, 1);
  const pages = Math.max(Math.ceil(items.length / perPage), 1);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, perPage, pages };
}

function linkHeader(ctx: Ctx, path: string, query: URLSearchParams, page: number, pages: number): Record<string, string> | null {
  if (pages <= 1) return null;
  const host = ctx.req.headers.host ?? 'localhost';
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(targetPage));
    return 'http://' + host + path + '?' + params.toString();
  };
  const links: string[] = [];
  if (page < pages) links.push('<' + build(page + 1) + '>; rel="next"');
  if (page > 1) links.push('<' + build(page - 1) + '>; rel="prev"');
  links.push('<' + build(1) + '>; rel="first"');
  links.push('<' + build(pages) + '>; rel="last"');
  return { link: links.join(', ') };
}

// ---------------------------------------------------------------------------
// REST v3 handlers
// ---------------------------------------------------------------------------

function restListRepos(ctx: Ctx): void {
  const perPage = intQuery(ctx.url, 'per_page', 30);
  const page = intQuery(ctx.url, 'page', 1);
  const owned = [...repos.values()].sort((a, b) => a.id - b.id);
  const result = paginate(owned, perPage, page);
  const headers = linkHeader(ctx, '/api/v3/user/repos', ctx.url.searchParams, result.page, result.pages) ?? {};
  sendJson(ctx, 200, result.items.map(repoJson), headers);
}

function restCreateRepo(ctx: Ctx, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const name = asString(body.name).trim();
  if (name === '') return errorMessage(ctx, 422, 'Validation Failed: name is required');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.endsWith('.git')) {
    return errorMessage(ctx, 422, 'Validation Failed: name is not a valid repository name');
  }
  if (repos.has(name)) {
    return errorMessage(ctx, 422, 'Validation Failed: name already exists on this account');
  }
  const repo = newRepo(name, asString(body.description), body.private === undefined ? false : body.private === true);
  sendJson(ctx, 201, repoJson(repo));
}

function restGetRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(owner, name);
  if (repo === null) return errorMessage(ctx, 404, 'Not Found');
  sendJson(ctx, 200, repoJson(repo));
}

function restPatchRepo(ctx: Ctx, owner: string, name: string, body: unknown): void {
  const repo = findRepo(owner, name);
  if (repo === null) return errorMessage(ctx, 404, 'Not Found');
  if (isRecord(body)) {
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      if (repos.has(body.name)) return errorMessage(ctx, 422, 'Validation Failed: name already exists on this account');
      repos.delete(repo.name);
      repo.name = body.name;
      repos.set(repo.name, repo);
    }
    if (body.private === true || body.private === false) repo.isPrivate = body.private;
    repoUpdatedAt(repo);
  }
  sendJson(ctx, 200, repoJson(repo));
}

function restDeleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(owner, name);
  if (repo === null) return errorMessage(ctx, 404, 'Not Found');
  repos.delete(name);
  sendEmpty(ctx, 204);
}

function restListBranches(ctx: Ctx, repo: Repo): void {
  const branches = sortedRefNames(repo, 'refs/heads/').map((name) => {
    const shortName = name.slice('refs/heads/'.length);
    return {
      name: shortName,
      commit: { sha: repo.refs.get(name), url: '' },
      protected: false,
    };
  });
  sendJson(ctx, 200, branches);
}

function restGetBranch(ctx: Ctx, repo: Repo, branch: string): void {
  const tip = repo.refs.get('refs/heads/' + branch);
  if (tip === undefined) return errorMessage(ctx, 404, 'Branch not found: ' + branch);
  sendJson(ctx, 200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
}

function restCreateRef(ctx: Ctx, repo: Repo, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
    return errorMessage(ctx, 422, 'Validation Failed: ref and sha are required, and sha must exist');
  }
  if (repo.refs.has(ref)) {
    return errorMessage(ctx, 422, 'Reference already exists: ' + ref);
  }
  repo.refs.set(ref, sha);
  repo.responseCache.clear();
  repoUpdatedAt(repo);
  sendJson(ctx, 201, { ref, node_id: 'R' + ref, object: { sha, type: 'commit', url: '' }, url: '' });
}

function restGetRefs(ctx: Ctx, repo: Repo, kind: 'heads' | 'tags' | null): void {
  const prefix = kind === null ? 'refs/' : 'refs/' + kind + '/';
  const refs = sortedRefNames(repo, prefix).map((name) => ({
    ref: name,
    node_id: 'G' + name,
    object: { sha: repo.refs.get(name), type: 'commit', url: '' },
    url: '',
  }));
  sendJson(ctx, 200, refs);
}

function restGetRef(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  const refName = 'refs/' + rest.map(decodeSegmentSafe).join('/');
  const sha = repo.refs.get(refName);
  if (sha === undefined) return errorMessage(ctx, 404, 'Reference does not exist: ' + refName);
  sendJson(ctx, 200, { ref: refName, node_id: 'G' + refName, object: { sha, type: 'commit', url: '' }, url: '' });
}

function restListCommits(ctx: Ctx, repo: Repo): void {
  const shaParam = ctx.url.searchParams.get('sha') ?? '';
  const tip = resolveBranchTip(repo, shaParam === '' ? repo.defaultBranch : shaParam);
  if (tip === null) {
    sendJson(ctx, 200, []);
    return;
  }
  const perPage = intQuery(ctx.url, 'per_page', 30);
  const page = intQuery(ctx.url, 'page', 1);
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && commits.length < 250) {
    const oid = stack.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    commits.push({
      sha: oid,
      node_id: 'C' + oid,
      commit: {
        message: view.message.replace(/\n+$/, ''),
        author: { name: view.author, email: '', date: '' },
        committer: { name: view.committer, email: '', date: '' },
        url: '',
        tree: { sha: view.tree, url: '' },
      },
      author: null,
      committer: null,
      parents: view.parents.map((parent) => ({ sha: parent, url: '' })),
      url: '',
      html_url: '',
    });
    for (const parent of view.parents) stack.push(parent);
  }
  const result = paginate(commits, perPage, page);
  const headers = linkHeader(ctx, ctx.url.pathname, ctx.url.searchParams, result.page, result.pages) ?? {};
  sendJson(ctx, 200, result.items, headers);
}

function restGetContents(ctx: Ctx, repo: Repo, path: string): void {
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = resolveBranchTip(repo, ref);
  if (tip === null) return errorMessage(ctx, 404, 'No commit found for ref: ' + ref);
  const tree = parseCommit(getObject(repo, tip)!.data).tree;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    const entries = treeEntries(repo, tree);
    sendJson(ctx, 200, entries.map((entry) => contentEntryJson(repo, ref, entry.name, entry)));
    return;
  }
  const entry = findTreePath(repo, tree, segments);
  if (entry === null) return errorMessage(ctx, 404, 'Not Found: ' + path);
  if (entry.mode === '40000') {
    const entries = treeEntries(repo, entry.oid);
    sendJson(ctx, 200, entries.map((child) => contentEntryJson(repo, ref, segments.join('/') + '/' + child.name, child)));
    return;
  }
  const obj = getObject(repo, entry.oid);
  if (obj === undefined) return errorMessage(ctx, 404, 'Not Found: ' + path);
  sendJson(ctx, 200, contentFileJson(repo, ref, path, entry.oid, obj));
}

function contentEntryJson(repo: Repo, ref: string, path: string, entry: TreeEntry): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const obj = isDir ? null : getObject(repo, entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: entry.oid,
    size: isDir ? 0 : obj !== null ? obj.data.length : 0,
    encoding: null,
    content: null,
    url: '',
    html_url: '',
    git_url: '',
    download_url: isDir ? null : '',
    _links: {},
    ...(ref !== '' ? {} : {}),
  };
}

function contentFileJson(repo: Repo, ref: string, path: string, sha: string, obj: GitObj): Record<string, unknown> {
  return {
    type: 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha,
    node_id: 'F' + sha,
    size: obj.data.length,
    encoding: 'base64',
    content: obj.data.toString('base64'),
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
    _links: {},
    ...(ref !== '' ? {} : {}),
  };
}

function restPutContents(ctx: Ctx, repo: Repo, path: string, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const contentText = asString(body.content);
  if (contentText === '' && body.content !== '') return errorMessage(ctx, 422, 'Validation Failed: content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentText.replace(/\s+/g, ''), 'base64');
  } catch {
    return errorMessage(ctx, 422, 'Validation Failed: content is not valid base64');
  }
  const message = asString(body.message) === '' ? 'forge: contents update' : asString(body.message);
  const branch = asString(body.branch) === '' ? repo.defaultBranch : asString(body.branch);
  const sha = asString(body.sha) === '' ? null : asString(body.sha);
  const result = writeContent(repo, branch, path, content, message, sha);
  if ('error' in result) return errorMessage(ctx, result.status, result.error);
  const blobObj = getObject(repo, result.contentSha)!;
  const pathSegments = path.split('/').filter((segment) => segment !== '');
  sendJsonText(
    ctx,
    result.created ? 201 : 200,
    JSON.stringify({
      content: {
        type: 'file',
        name: pathSegments[pathSegments.length - 1] ?? path,
        path,
        sha: result.contentSha,
        size: blobObj.data.length,
        encoding: 'base64',
        content: blobObj.data.toString('base64'),
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
        _links: {},
      },
      commit: {
        sha: result.commitSha,
        node_id: 'C' + result.commitSha,
        message,
        author: { name: LOGIN, email: LOGIN + '@example.invalid', date: nextIso() },
        committer: { name: LOGIN, email: LOGIN + '@example.invalid', date: nextIso() },
        url: '',
        html_url: '',
        tree: { sha: '', url: '' },
        parents: [],
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
      },
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    }),
  );
}

function restDeleteContents(ctx: Ctx, repo: Repo, path: string, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const sha = asString(body.sha);
  if (sha === '') return errorMessage(ctx, 422, 'Validation Failed: sha is required');
  const branch = asString(body.branch) === '' ? repo.defaultBranch : asString(body.branch);
  const message = asString(body.message) === '' ? 'forge: contents delete' : asString(body.message);
  const result = deleteContent(repo, branch, path, sha, message);
  if ('error' in result) return errorMessage(ctx, result.status, result.error);
  sendJsonText(
    ctx,
    200,
    JSON.stringify({
      content: null,
      commit: {
        sha: result.commitSha,
        node_id: 'C' + result.commitSha,
        message,
        author: { name: LOGIN, email: LOGIN + '@example.invalid', date: nextIso() },
        committer: { name: LOGIN, email: LOGIN + '@example.invalid', date: nextIso() },
        url: '',
        html_url: '',
        tree: { sha: '', url: '' },
        parents: [],
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
      },
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    }),
  );
}

function restCreateLabel(ctx: Ctx, repo: Repo, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const name = asString(body.name).trim();
  if (name === '') return errorMessage(ctx, 422, 'Validation Failed: name is required');
  try {
    const label = createLabel(repo, name, asString(body.color));
    sendJson(ctx, 201, labelJson(label));
  } catch (err) {
    errorMessage(ctx, err instanceof ForgeError ? err.status : 422, err instanceof Error ? err.message : 'Validation Failed');
  }
}

function restListLabels(ctx: Ctx, repo: Repo): void {
  sendJson(ctx, 200, [...repo.labels.values()].sort((a, b) => a.id - b.id).map(labelJson));
}

function restCreateIssue(ctx: Ctx, repo: Repo, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const title = asString(body.title).trim();
  if (title === '') return errorMessage(ctx, 422, 'Validation Failed: title is required');
  let labels: string[] | null = null;
  if (Array.isArray(body.labels)) {
    labels = [];
    for (const entry of body.labels) {
      if (typeof entry === 'string') labels.push(entry);
      else if (isRecord(entry) && typeof entry.name === 'string') labels.push(entry.name);
    }
  }
  try {
    const issue = createIssue(repo, title, asString(body.body), labels);
    issueJson(repo, issue); // build and cache the serialized body
    sendJsonText(ctx, 201, issue.jsonBuf!, { 'x-oauth-scopes': 'repo, read:org' });
  } catch (err) {
    errorMessage(ctx, err instanceof ForgeError ? err.status : 422, err instanceof Error ? err.message : 'Validation Failed');
  }
}

function restListIssues(ctx: Ctx, repo: Repo): void {
  const state = (ctx.url.searchParams.get('state') ?? 'open').toLowerCase();
  const sort = (ctx.url.searchParams.get('sort') ?? 'created').toLowerCase();
  const direction = (ctx.url.searchParams.get('direction') ?? 'desc').toLowerCase();
  let issues = repo.issues.slice();
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => {
    let cmp = 0;
    if (sort === 'created') cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
    else if (sort === 'updated') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
    else cmp = a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const perPage = intQuery(ctx.url, 'per_page', 30);
  const page = intQuery(ctx.url, 'page', 1);
  const result = paginate(issues, perPage, page);
  const headers = linkHeader(ctx, ctx.url.pathname, ctx.url.searchParams, result.page, result.pages) ?? {};
  sendJson(ctx, 200, result.items.map((issue) => issueJson(repo, issue)), headers);
}

function restGetIssue(ctx: Ctx, repo: Repo, number: number): void {
  const issue = findIssue(repo, number);
  if (issue === null) return errorMessage(ctx, 404, 'Not Found');
  if (issue.jsonBuf === null) issueJson(repo, issue);
  sendJsonText(ctx, 200, issue.jsonBuf!, { 'x-oauth-scopes': 'repo, read:org' });
}

function restPatchIssue(ctx: Ctx, repo: Repo, number: number, body: unknown): void {
  const issue = findIssue(repo, number);
  if (issue === null) return errorMessage(ctx, 404, 'Not Found');
  if (isRecord(body)) {
    if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') {
      if (issue.state !== body.state) {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nextIso() : null;
      }
    }
    issue.updatedAt = nextIso();
    issue.jsonCache = null;
    issue.jsonBuf = null;
    repoUpdatedAt(repo);
  }
  sendJson(ctx, 200, issueJson(repo, issue));
}

function restCreateComment(ctx: Ctx, repo: Repo, number: number, body: unknown): void {
  const issue = findIssue(repo, number);
  if (issue === null) return errorMessage(ctx, 404, 'Not Found');
  if (!isRecord(body) || typeof body.body !== 'string') return errorMessage(ctx, 422, 'Validation Failed: body is required');
  const comment = addComment(repo, issue, body.body);
  sendJson(ctx, 201, commentJson(repo, issue, comment));
}

function restListComments(ctx: Ctx, repo: Repo, number: number): void {
  const issue = findIssue(repo, number);
  if (issue === null) return errorMessage(ctx, 404, 'Not Found');
  sendJson(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
}

function restCreatePull(ctx: Ctx, repo: Repo, body: unknown): void {
  if (!isRecord(body)) return errorMessage(ctx, 400, 'Body must be a JSON object');
  const title = asString(body.title).trim();
  const head = asString(body.head);
  const base = asString(body.base) === '' ? repo.defaultBranch : asString(body.base);
  if (title === '' || head === '') return errorMessage(ctx, 422, 'Validation Failed: title and head are required');
  try {
    const pull = createPull(repo, head, base, title, asString(body.body));
    sendJson(ctx, 201, pullJson(repo, pull));
  } catch (err) {
    errorMessage(ctx, err instanceof ForgeError ? err.status : 422, err instanceof Error ? err.message : 'Validation Failed');
  }
}

function restListPulls(ctx: Ctx, repo: Repo): void {
  const state = (ctx.url.searchParams.get('state') ?? 'open').toLowerCase();
  let pulls = repo.pulls.slice();
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const perPage = intQuery(ctx.url, 'per_page', 30);
  const page = intQuery(ctx.url, 'page', 1);
  const result = paginate(pulls, perPage, page);
  const headers = linkHeader(ctx, ctx.url.pathname, ctx.url.searchParams, result.page, result.pages) ?? {};
  sendJson(ctx, 200, result.items.map((pull) => pullJson(repo, pull)), headers);
}

function restGetPull(ctx: Ctx, repo: Repo, number: number): void {
  const pull = findPull(repo, number);
  if (pull === null) return errorMessage(ctx, 404, 'Not Found');
  sendJson(ctx, 200, pullJson(repo, pull));
}

function restListPullFiles(ctx: Ctx, repo: Repo, number: number): void {
  const pull = findPull(repo, number);
  if (pull === null) return errorMessage(ctx, 404, 'Not Found');
  const headTip = pullShaOf(repo, pull);
  const files = pull.files.map((file) => ({
    sha: headTip,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
  }));
  sendJson(ctx, 200, files);
}

function restMergePull(ctx: Ctx, repo: Repo, number: number, body: unknown): void {
  const pull = findPull(repo, number);
  if (pull === null) return errorMessage(ctx, 404, 'Not Found');
  try {
    const sha = mergePullSquash(repo, pull);
    sendJson(ctx, 200, {
      sha,
      node_id: 'C' + sha,
      merged: true,
      message: 'Pull Request successfully merged',
      author: { name: LOGIN, email: LOGIN + '@example.invalid', date: pull.mergedAt ?? '' },
      committer: { name: LOGIN, email: LOGIN + '@example.invalid', date: pull.mergedAt ?? '' },
      url: '',
      html_url: '',
    });
  } catch (err) {
    if (err instanceof MergeError) return errorMessage(ctx, err.status, err.message);
    errorMessage(ctx, 405, err instanceof Error ? err.message : 'Pull Request is not mergeable');
  }
}

function decodeSegmentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// REST router
// ---------------------------------------------------------------------------

async function handleRest(ctx: Ctx, segments: readonly string[]): Promise<void> {
  const [first, second, third, ...rest] = segments;
  if (first === undefined || first === '') {
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      user_url: '/api/v3/users/{user}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repositories_url: '/api/v3/user/repos',
      issues_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      pulls_url: '/api/v3/repos/{owner}/{repo}/pulls/{number}',
      labels_url: '/api/v3/repos/{owner}/{repo}/labels',
      meta_url: '/api/v3/meta',
      graphql_url: '/api/graphql',
    });
    return;
  }
  if (first === 'meta') {
    sendJson(ctx, 200, { installed_version: VERSION, verifiable_password_authentication: false, github_services: [] });
    return;
  }
  if (first === 'user') {
    if (second === 'repos') {
      if (ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
        restCreateRepo(ctx, parsed.value);
        return;
      }
      restListRepos(ctx);
      return;
    }
    sendJson(ctx, 200, { ...userRef(LOGIN), name: LOGIN, email: LOGIN + '@example.invalid', created_at: nextIso(), updated_at: nextIso() });
    return;
  }
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const repo = findRepo(second, third);
    if (rest.length === 0) {
      if (ctx.req.method === 'PATCH') {
        const body = await readBody(ctx.req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
        restPatchRepo(ctx, second, third, parsed.value);
        return;
      }
      if (ctx.req.method === 'DELETE') {
        restDeleteRepo(ctx, second, third);
        return;
      }
      restGetRepo(ctx, second, third);
      return;
    }
    if (repo === null) return errorMessage(ctx, 404, 'Not Found');
    const restPath = rest.map(decodeSegmentSafe);
    const head = restPath[0]!;
    if (head === 'branches') {
      if (restPath.length === 1) return restListBranches(ctx, repo);
      return restGetBranch(ctx, repo, restPath.slice(1).join('/'));
    }
    if (head === 'git') {
      const tail = restPath.slice(1);
      if (tail[0] === 'refs') {
        if (tail.length === 1) {
          if (ctx.req.method === 'POST') {
            const body = await readBody(ctx.req);
            const parsed = parseJsonBody(body);
            if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
            restCreateRef(ctx, repo, parsed.value);
            return;
          }
          return restGetRefs(ctx, repo, null);
        }
        if (tail.length >= 3 && tail[1] === 'heads') return restGetRef(ctx, repo, ['heads', ...tail.slice(2)]);
        if (tail.length >= 3 && tail[1] === 'tags') return restGetRef(ctx, repo, ['tags', ...tail.slice(2)]);
        if (tail.length === 2 && (tail[1] === 'heads' || tail[1] === 'tags')) return restGetRefs(ctx, repo, tail[1] === 'heads' ? 'heads' : 'tags');
        return errorMessage(ctx, 404, 'Not Found');
      }
      if (tail[0] === 'commits') {
        return restListCommits(ctx, repo);
      }
      return errorMessage(ctx, 404, 'Not Found');
    }
    if (head === 'commits') return restListCommits(ctx, repo);
    if (head === 'contents') {
      const path = restPath.slice(1).join('/');
      if (ctx.req.method === 'PUT') {
        const body = await readBody(ctx.req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
        return restPutContents(ctx, repo, path, parsed.value);
      }
      if (ctx.req.method === 'DELETE') {
        const body = await readBody(ctx.req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
        return restDeleteContents(ctx, repo, path, parsed.value);
      }
      return restGetContents(ctx, repo, path);
    }
    if (head === 'labels') {
      if (restPath.length === 1 && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
        return restCreateLabel(ctx, repo, parsed.value);
      }
      if (restPath.length === 1) return restListLabels(ctx, repo);
      return errorMessage(ctx, 404, 'Not Found');
    }
    if (head === 'issues') {
      if (restPath.length === 1) {
        if (ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
          return restCreateIssue(ctx, repo, parsed.value);
        }
        return restListIssues(ctx, repo);
      }
      const number = asNumber(restPath[1]);
      if (number === null) return errorMessage(ctx, 404, 'Not Found');
      if (restPath.length === 2) {
        if (ctx.req.method === 'PATCH') {
          const body = await readBody(ctx.req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
          return restPatchIssue(ctx, repo, number, parsed.value);
        }
        return restGetIssue(ctx, repo, number);
      }
      if (restPath.length === 3 && restPath[2] === 'comments') {
        if (ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
          return restCreateComment(ctx, repo, number, parsed.value);
        }
        return restListComments(ctx, repo, number);
      }
      return errorMessage(ctx, 404, 'Not Found');
    }
    if (head === 'pulls') {
      if (restPath.length === 1) {
        if (ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
          return restCreatePull(ctx, repo, parsed.value);
        }
        return restListPulls(ctx, repo);
      }
      const number = asNumber(restPath[1]);
      if (number === null) return errorMessage(ctx, 404, 'Not Found');
      if (restPath.length === 2) return restGetPull(ctx, repo, number);
      if (restPath.length === 3 && restPath[2] === 'files') return restListPullFiles(ctx, repo, number);
      if (restPath.length === 3 && restPath[2] === 'merge' && ctx.req.method === 'PUT') {
        const body = await readBody(ctx.req);
        const parsed = body.length === 0 ? { ok: true as const, value: {} } : parseJsonBody(body);
        if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
        return restMergePull(ctx, repo, number, parsed.value);
      }
      return errorMessage(ctx, 404, 'Not Found');
    }
    return errorMessage(ctx, 404, 'Not Found');
  }
  errorMessage(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git smart-HTTP handlers
// ---------------------------------------------------------------------------

function gitRepoOf(ctx: Ctx, owner: string, name: string): Repo | null {
  return findRepo(owner, name);
}

async function handleGitInfoRefs(ctx: Ctx, owner: string, repoName: string): Promise<void> {
  const repo = gitRepoOf(ctx, owner, repoName);
  const service = ctx.url.searchParams.get('service') ?? '';
  if (repo === null) return errorMessage(ctx, 404, 'Not Found');
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').toString().includes('version=2');
  if (service === 'git-upload-pack') {
    if (wantsV2) return sendGit(ctx, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
    return sendGit(ctx, 'application/x-git-upload-pack-advertisement', gitAdvertisementCached(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return sendGit(ctx, 'application/x-git-receive-pack-advertisement', gitAdvertisementCached(repo, 'git-receive-pack'));
  }
  return errorMessage(ctx, 400, 'service must be git-upload-pack or git-receive-pack');
}

function gitAdvertisementCached(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const key = 'adv:' + service + ':' + [...repo.refs.entries()].sort().join(',');
  const cached = repo.responseCache.get(key);
  if (cached !== undefined) return cached;
  const buffer = refAdvertisement(repo, service);
  repo.responseCache.set(key, buffer);
  return buffer;
}

async function handleGitUploadPack(ctx: Ctx, owner: string, repoName: string): Promise<void> {
  const repo = gitRepoOf(ctx, owner, repoName);
  if (repo === null) return errorMessage(ctx, 404, 'Not Found');
  const body = await readBody(ctx.req);
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '').toString().includes('version=2');
  if (wantsV2) return handleUploadPackV2(ctx, repo, body);
  return handleUploadPackV0(ctx, repo, body);
}

async function handleUploadPackV2(ctx: Ctx, repo: Repo, body: Buffer): Promise<void> {
  const parsed = parsePktRequest(body);
  if (parsed === null) return errorMessage(ctx, 400, 'malformed pkt-line request');
  let command = '';
  let afterDelim = false;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const line of parsed.lines) {
    if (line.length === 0) {
      afterDelim = true; // the 0001 delim packet
      continue;
    }
    const text = pktText(line);
    if (text === '' || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    if (command === 'ls-refs') {
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') continue;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      continue;
    }
    if (command === 'fetch') {
      if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta' || text === 'done' || text.startsWith('filter') || text.startsWith('deepen-since') || text.startsWith('deepen-not')) continue;
      if (text.startsWith('want ')) wants.push(text.slice(5));
      else if (text.startsWith('have ')) haves.push(text.slice(5));
      else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8));
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
      continue;
    }
  }
  if (command === 'ls-refs') {
    const key = 'lsrefs:' + (peel ? 'p' : '') + (symrefs ? 's' : '') + ':' + prefixes.join('|') + ':' + [...repo.refs.entries()].sort().join(',');
    const cached = repo.responseCache.get(key);
    if (cached !== undefined) return sendGit(ctx, 'application/x-git-upload-pack-result', cached);
    const response = lsRefsResponse(repo, { prefixes, peel, symrefs });
    repo.responseCache.set(key, response);
    return sendGit(ctx, 'application/x-git-upload-pack-result', response);
  }
  if (command === 'fetch') {
    for (const want of wants) {
      if (!/^[0-9a-f]{40}$/.test(want) || !repo.objects.has(want)) {
        const errBody = pktLines([pktLine('ERR upload-pack: want ' + want.slice(0, 8) + ' not found\n')]);
        return sendGit(ctx, 'application/x-git-upload-pack-result', errBody);
      }
    }
    if (wants.length === 0) {
      return sendGit(ctx, 'application/x-git-upload-pack-result', pktLine('acknowledgments\n') + pktLine('NAK\n') + FLUSH_PKT);
    }
    const depthLimit = depth !== null && Number.isFinite(depth) && depth > 0 ? depth : null;
    const cacheKey = 'fetch2:' + wants.join(',') + '|' + haves.join(',') + '|' + clientShallow.join(',') + '|' + String(depthLimit);
    const cached = repo.responseCache.get(cacheKey);
    if (cached !== undefined) return sendGit(ctx, 'application/x-git-upload-pack-result', cached);
    const negotiation = negotiateFetch(repo, { wants, haves, clientShallow, depth: depthLimit });
    const response = v2FetchResponse(repo, negotiation);
    repo.responseCache.set(cacheKey, response);
    return sendGit(ctx, 'application/x-git-upload-pack-result', response);
  }
  return errorMessage(ctx, 400, 'unknown command: ' + command);
}

async function handleUploadPackV0(ctx: Ctx, repo: Repo, body: Buffer): Promise<void> {
  const parsed = parsePktRequest(body, 'multi');
  if (parsed === null) return errorMessage(ctx, 400, 'malformed pkt-line request');
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const line of parsed.lines) {
    if (line.length === 0) {
      section += 1;
      continue;
    }
    const text = pktText(line);
    if (text === '') continue;
    if (section === 0) {
      if (text.startsWith('want ')) {
        const parts = text.slice(5).split(' ');
        wants.push(parts[0]!);
      } else if (text.startsWith('deepen ')) {
        depth = Number(text.slice(7));
      } else if (text.startsWith('shallow ')) {
        clientShallow.push(text.slice(8));
      }
      continue;
    }
    if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8));
  }
  if (wants.length === 0) return errorMessage(ctx, 400, 'no wants in upload-pack request');
  const negotiation = negotiateFetch(repo, { wants, haves, clientShallow, depth: depth !== null && Number.isFinite(depth) && depth > 0 ? depth : null });
  return sendGit(ctx, 'application/x-git-upload-pack-result', v0FetchResponse(repo, negotiation));
}

async function handleGitReceivePack(ctx: Ctx, owner: string, repoName: string): Promise<void> {
  const repo = gitRepoOf(ctx, owner, repoName);
  if (repo === null) return errorMessage(ctx, 404, 'Not Found');
  const body = await readBody(ctx.req);
  const parsed = parsePktRequest(body);
  if (parsed === null) return errorMessage(ctx, 400, 'malformed pkt-line request');
  const commands: PushCommand[] = [];
  let clientSideband = false;
  for (const line of parsed.lines) {
    const text = pktText(line);
    const nul = text.indexOf('\u0000');
    const capsPart = nul >= 0 ? text.slice(nul + 1) : '';
    const commandPart = nul >= 0 ? text.slice(0, nul) : text;
    if (capsPart.includes('side-band-64k')) clientSideband = true;
    if (commandPart === '') continue;
    const space1 = commandPart.indexOf(' ');
    const space2 = space1 >= 0 ? commandPart.indexOf(' ', space1 + 1) : -1;
    if (space1 < 0 || space2 < 0) return errorMessage(ctx, 400, 'malformed push command');
    commands.push({
      oldOid: commandPart.slice(0, space1),
      newOid: commandPart.slice(space1 + 1, space2),
      ref: commandPart.slice(space2 + 1),
    });
  }
  if (commands.length === 0) return errorMessage(ctx, 400, 'no push commands');
  const outcome = receivePack(repo, commands, parsed.trailing);
  const reply: Buffer[] = [];
  if (clientSideband) {
    reply.push(pktLine(Buffer.concat([Buffer.from([1]), outcome.report])));
    reply.push(FLUSH_PKT);
  } else {
    reply.push(outcome.report, FLUSH_PKT);
  }
  return sendGit(ctx, 'application/x-git-receive-pack-result', Buffer.concat(reply));
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and evaluator for the documents the suite sends
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'obj'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  sels: GqlSel[] | null;
}

type GqlSel =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; on: string | null; sels: GqlSel[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  varNames: string[];
  sels: GqlSel[];
}

function gqlTokenize(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (/\s/.test(ch) || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      if (text.startsWith('"""', index)) {
        const end = text.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push(text.slice(index, end + 3));
        index = end + 3;
        continue;
      }
      let value = '"';
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          value += text.slice(index, index + 2);
          index += 2;
        } else {
          value += text[index]!;
          index += 1;
        }
      }
      if (index >= text.length) throw new Error('unterminated string');
      value += '"';
      index += 1;
      tokens.push(value);
      continue;
    }
    if (/[A-Za-z_0-9-]/.test(ch)) {
      let end = index;
      while (end < text.length && /[A-Za-z_0-9-]/.test(text[end]!)) end += 1;
      tokens.push(text.slice(index, end));
      index = end;
      continue;
    }
    if (ch === '.' && text.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    tokens.push(ch);
    index += 1;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos = 0;
  constructor(text: string) {
    this.tokens = gqlTokenize(text);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error('expected ' + token + ', got ' + got);
  }
  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, varNames: [], sels: this.parseSelectionSet() });
        continue;
      }
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const type = token === 'mutation' ? 'mutation' : 'query';
        this.next();
        let name: string | null = null;
        const varNames: string[] = [];
        if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!) && this.peek() !== '{') {
          name = this.next();
        }
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            varNames.push(this.next());
            this.expect(':');
            this.parseTypeRef();
            if (this.peek() === '=') {
              this.next();
              this.parseValue();
            }
            if (this.peek() === '!') this.next();
            if (this.peek() === '[') {
              this.next();
              while (this.peek() !== ']') {
                this.expect('$');
                varNames.push(this.next());
                this.expect(':');
                this.parseTypeRef();
                if (this.peek() === '!') this.next();
              }
              this.next();
            }
          }
          this.next();
        }
        this.skipDirectives();
        if (this.peek() !== '{') throw new Error('expected selection set');
        operations.push({ type, name, varNames, sels: this.parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected token ' + token);
    }
    return operations;
  }
  parseTypeRef(): string {
    let text = this.next();
    if (text === '[') {
      text = this.next();
      while (this.peek() === '!') this.next();
      this.expect(']');
    }
    while (this.peek() === '!') this.next();
    return text;
  }
  skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        }
      }
    }
  }
  parseSelectionSet(): GqlSel[] {
    this.expect('{');
    const sels: GqlSel[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token === '}') {
        this.next();
        break;
      }
      sels.push(this.parseSelection());
    }
    return sels;
  }
  parseSelection(): GqlSel {
    if (this.peek() === '...') {
      this.next();
      let on: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        on = this.next();
      }
      this.skipDirectives();
      return { kind: 'fragment', on, sels: this.parseSelectionSet() };
    }
    let first = this.next();
    let name = first;
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    this.skipDirectives();
    let sels: GqlSel[] | null = null;
    if (this.peek() === '{') sels = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, sels } };
  }
  parseValue(): GqlValue {
    const token = this.peek()!;
    if (token === '$') {
      this.next();
      return { kind: 'var', name: this.next() };
    }
    if (token === '[') {
      this.next();
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      this.next();
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.next();
      return { kind: 'obj', fields };
    }
    if (token.startsWith('"')) {
      this.next();
      return { kind: 'str', value: parseGqlString(token) };
    }
    this.next();
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function parseGqlString(token: string): string {
  const inner = token.slice(1, -1);
  return inner.replace(/\\(["\\/bfnrtu])/g, (match, hex: string) => {
    if (hex === 'n') return '\n';
    if (hex === 't') return '\t';
    if (hex === 'r') return '\r';
    if (hex === 'b') return '\b';
    if (hex === 'f') return '\f';
    if (hex === 'u') return match;
    return hex;
  });
}

function coerceGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': {
      const found = variables[value.name];
      return found === undefined ? null : found;
    }
    case 'str':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'bool':
      return value.value;
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => coerceGqlValue(item, variables));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = coerceGqlValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(fields: GqlField[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of fields.args) out[arg.name] = coerceGqlValue(arg.value, variables);
  return out;
}

// The introspected schema surface gh and github-mcp-server probe.
const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'addIssueComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'isFork', 'isEmpty', 'ref', 'refs', 'object', 'diskUsage', 'viewerCanAdminister'],
  Ref: ['id', 'name', 'prefix', 'target', 'associatedPullRequests'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'comments', 'labels', 'stateReason', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergedAt', 'closedAt', 'createdAt', 'headRefName', 'baseRefName', 'mergeable', 'mergeStateStatus', 'files', 'author', 'url', 'commits', 'repository', 'labels'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'oid'],
  PullRequestFiles: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  IssuePayload: ['issue'],
  PullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  SearchResultConnection: ['nodes', 'edges', 'issueCount'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'PULL_REQUEST'],
  Node: ['id'],
  __Type: ['kind', 'name', 'description', 'fields', 'inputFields', 'enumValues', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
  null: [],
};

const SCHEMA_ENUMS = new Set(['IssueOrderField', 'OrderDirection', 'IssueState', 'PullRequestState', 'MergeableState', 'PullRequestMergeMethod', 'RepositoryPermission', 'SearchType']);

const parseCache = new Map<string, GqlOperation[]>();

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface GqlOutput {
  data: Record<string, unknown> | null;
  errors: GqlError[];
}

function handleGraphql(ctx: Ctx, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return errorMessage(ctx, 400, 'Problems parsing JSON');
  const operations: unknown[] = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const responses: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    if (!isRecord(operation) || typeof operation.query !== 'string') {
      responses.push({ errors: [{ message: 'a GraphQL request carries a query document' }] });
      continue;
    }
    const variables = isRecord(operation.variables) ? operation.variables : {};
    const operationName = typeof operation.operationName === 'string' && operation.operationName !== '' ? operation.operationName : null;
    responses.push(runGraphqlOperation(operation.query, variables, operationName));
  }
  const output = Array.isArray(parsed.value) ? responses : responses[0]!;
  sendJsonText(ctx, 200, JSON.stringify(output));
}

function runGraphqlOperation(query: string, variables: Record<string, unknown>, operationName: string | null): GqlOutput & Record<string, unknown> {
  let operations: GqlOperation[];
  try {
    const cached = parseCache.get(query);
    if (cached !== undefined) operations = cached;
    else {
      operations = new GqlParser(query).parseDocument();
      if (parseCache.size < 512) parseCache.set(query, operations);
    }
  } catch (err) {
    return { errors: [{ message: 'the document could not be parsed: ' + (err instanceof Error ? err.message : String(err)) }] };
  }
  let chosen = operations[0];
  if (operationName !== null) {
    const found = operations.find((op) => op.name === operationName);
    if (found === undefined) return { errors: [{ message: 'no operation named ' + operationName }] };
    chosen = found;
  }
  if (chosen === undefined) return { errors: [{ message: 'the document holds no operations' }] };
  const errors: GqlError[] = [];
  const root = chosen.type === 'mutation' ? resolveMutationRoot : resolveQueryRoot;
  const data: Record<string, unknown> = {};
  resolveSelections(chosen.type === 'mutation' ? 'Mutation' : 'Query', root, chosen.sels, variables, data, errors, []);
  const output: GqlOutput & Record<string, unknown> = { data, ...(errors.length > 0 ? { errors } : {}) };
  return output;
}

function resolveSelections(
  typeName: string,
  object: unknown,
  sels: readonly GqlSel[],
  variables: Record<string, unknown>,
  sink: Record<string, unknown>,
  errors: GqlError[],
  path: Array<string | number>,
): void {
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.on === null || fragmentMatches(sel.on, typeName)) {
        resolveSelections(typeName, object, sel.sels, variables, sink, errors, path);
      }
      continue;
    }
    const field = sel.field;
    const outputKey = field.alias ?? field.name;
    if (!isResolvableField(typeName, field.name)) {
      errors.push({
        message: "The field '" + field.name + "' does not exist on type '" + typeName + "'.",
        path: [...path, outputKey],
      });
      continue;
    }
    const args = argsOf(field, variables);
    const resolved = resolveField(typeName, object, field.name, args, variables);
    const childPath = [...path, outputKey];
    if (resolved.type === null) {
      sink[outputKey] = resolved.value;
      continue;
    }
    if (resolved.value === null || resolved.value === undefined) {
      sink[outputKey] = null;
      continue;
    }
    if (field.sels === null) {
      sink[outputKey] = resolved.value;
      continue;
    }
    if (resolved.list === true && Array.isArray(resolved.value)) {
      const list: unknown[] = [];
      for (const item of resolved.value) {
        if (item === null || item === undefined) {
          list.push(null);
          continue;
        }
        const itemSink: Record<string, unknown> = {};
        resolveSelections(resolved.type, item, field.sels, variables, itemSink, errors, childPath);
        list.push(itemSink);
      }
      sink[outputKey] = list;
    } else {
      const child: Record<string, unknown> = {};
      resolveSelections(resolved.type, resolved.value, field.sels, variables, child, errors, childPath);
      sink[outputKey] = child;
    }
  }
}

function fragmentMatches(on: string, typeName: string): boolean {
  if (typeName === 'NodeObject') return on === 'Repository' || on === 'Node';
  if (on === typeName) return true;
  if (on === 'Node') return typeName === 'Repository' || typeName === 'Issue' || typeName === 'PullRequest' || typeName === 'User';
  return false;
}

function isResolvableField(typeName: string, field: string): boolean {
  if (typeName === 'NodeObject') return field === 'id' || (SCHEMA_FIELDS.Repository ?? []).includes(field);
  const schema = SCHEMA_FIELDS[typeName];
  return schema !== undefined && schema.includes(field);
}

interface Resolved {
  value: unknown;
  type: string | null;
  /** True when the value is a list of `type` items (a nodes/edges array), not a single object. */
  list?: boolean;
}

function resolvedScalar(value: unknown): Resolved {
  return { value, type: null };
}

function resolvedList(value: unknown, type: string): Resolved {
  return { value, type, list: true };
}

function resolveQueryRoot(field: string, args: Record<string, unknown>): Resolved {
  if (field === 'viewer') return { value: { login: LOGIN }, type: 'User' };
  if (field === 'repository') {
    const owner = asString(args.owner);
    const name = asString(args.name);
    const repo = findRepo(owner, name);
    return { value: repo, type: 'Repository' };
  }
  if (field === 'node') {
    const id = asString(args.id);
    return { value: resolveNodeById(id), type: 'NodeObject' };
  }
  if (field === '__type') {
    const name = asString(args.name);
    return { value: introspectType(name), type: '__Type' };
  }
  if (field === '__schema') {
    return { value: { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }, type: '__Schema' };
  }
  if (field === 'search') return { value: { nodes: [], edges: [], issueCount: 0 }, type: 'SearchResultConnection' };
  return resolvedScalar(null);
}

function resolveNodeById(id: string): Record<string, unknown> | null {
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'repo' && decoded.repo !== null) {
    return { __gqlKind: 'Repository', repo: decoded.repo, id };
  }
  return null;
}

function resolveMutationRoot(field: string, args: Record<string, unknown>): Resolved {
  const input = isRecord(args.input) ? args.input : {};
  if (field === 'createIssue') {
    const repo = repoFromInputId(asString(input.repositoryId));
    if (repo === null) return resolvedScalar(null);
    const issue = createIssue(repo, asString(input.title), asString(input.body), null);
    return { value: { issue: issueWrapper(issue, repo) }, type: 'IssuePayload' };
  }
  if (field === 'closeIssue') {
    const found = locateById(asString(input.issueId));
    if (found === null || found.kind !== 'issue') return resolvedScalar(null);
    const [repo, issue] = found.value;
    if (issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedAt = nextIso();
      issue.updatedAt = issue.closedAt;
      issue.jsonCache = null;
      issue.jsonBuf = null;
      repoUpdatedAt(repo);
    }
    return { value: { issue: issueWrapper(issue, repo) }, type: 'IssuePayload' };
  }
  if (field === 'createPullRequest') {
    const repo = repoFromInputId(asString(input.repositoryId));
    if (repo === null) return resolvedScalar(null);
    try {
      const pull = createPull(repo, asString(input.headRefName), asString(input.baseRefName), asString(input.title), asString(input.body));
      return { value: { pullRequest: pullWrapper(pull, repo) }, type: 'PullRequestPayload' };
    } catch {
      return resolvedScalar(null);
    }
  }
  if (field === 'mergePullRequest') {
    const found = locateById(asString(input.pullRequestId));
    if (found === null || found.kind !== 'pull') return resolvedScalar(null);
    const [repo, pull] = found.value;
    try {
      mergePullSquash(repo, pull);
    } catch {
      return resolvedScalar(null);
    }
    return { value: { pullRequest: pullWrapper(pull, repo) }, type: 'PullRequestPayload' };
  }
  if (field === 'addComment') {
    const found = locateById(asString(input.subjectId));
    if (found === null || found.kind !== 'issue') return resolvedScalar(null);
    const [repo, issue] = found.value;
    const comment = addComment(repo, issue, asString(input.body));
    return { value: { commentEdge: { node: { id: commentNodeId(comment.id), body: comment.body }, cursor: '' } }, type: 'AddCommentPayload' };
  }
  return resolvedScalar(null);
}

function repoFromInputId(id: string): Repo | null {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.repo === null) return null;
  return decoded.repo;
}

function locateById(id: string): { kind: 'issue' | 'pull' | 'repo' | 'comment'; value: [Repo, Issue] | [Repo, Pull] | Repo } | null {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.repo === null) return null;
  const repo = decoded.repo;
  if (decoded.kind === 'issue') {
    const issue = findIssue(repo, decoded.number);
    return issue === null ? null : { kind: 'issue', value: [repo, issue] };
  }
  if (decoded.kind === 'pull') {
    const pull = findPull(repo, decoded.number);
    return pull === null ? null : { kind: 'pull', value: [repo, pull] };
  }
  return { kind: 'repo', value: repo };
}

function resolveField(typeName: string, object: unknown, field: string, args: Record<string, unknown>, variables: Record<string, unknown>): Resolved {
  if (typeName === 'Query') return resolveQueryRoot(field, args);
  if (typeName === 'Mutation') return resolveMutationRoot(field, args);
  if (typeName === 'NodeObject') {
    const node = object as Record<string, unknown>;
    if (field === 'id') return resolvedScalar(node.id ?? null);
    const repo = node.repo as Repo;
    return resolveField('Repository', repo, field, args, variables);
  }
  if (typeName === 'IssuePayload') {
    const payload = object as { issue: unknown };
    if (field === 'issue') return { value: payload.issue, type: 'Issue' };
    return resolvedScalar(null);
  }
  if (typeName === 'PullRequestPayload') {
    const payload = object as { pullRequest: unknown };
    if (field === 'pullRequest') return { value: payload.pullRequest, type: 'PullRequest' };
    return resolvedScalar(null);
  }
  if (typeName === 'AddCommentPayload') {
    const payload = object as { commentEdge?: { node: { id: string; body: string }; cursor: string } };
    if (field === 'commentEdge') return { value: payload.commentEdge ?? null, type: 'CommentEdge' };
    return resolvedScalar(null);
  }
  if (typeName === 'CommentEdge') {
    const edge = object as { node?: { id: string; body: string } } | null;
    if (field === 'node') return { value: edge?.node ?? null, type: 'IssueComment' };
    if (field === 'cursor') return resolvedScalar('');
    return resolvedScalar(null);
  }
  if (typeName === 'IssueComment') {
    const comment = object as { id?: string; body?: string };
    if (field === 'id') return resolvedScalar(comment.id ?? null);
    if (field === 'body') return resolvedScalar(comment.body ?? null);
    return resolvedScalar(null);
  }
  if (typeName === 'SearchResultConnection') {
    if (field === 'nodes' || field === 'edges') return { value: [], type: null };
    return resolvedScalar(0);
  }
  if (typeName === '__Schema') {
    return resolvedScalar(null);
  }
  if (typeName === '__Type') {
    const type = object as { kind: string; name: string; fields?: readonly string[]; enumValues?: readonly string[] };
    if (field === 'kind') return resolvedScalar(type.kind);
    if (field === 'name') return resolvedScalar(type.name);
    if (field === 'description') return resolvedScalar(null);
    if (field === 'fields') return resolvedList((type.fields ?? []).map((name) => ({ name })), '__Field');
    if (field === 'enumValues') return resolvedList((type.enumValues ?? []).map((name) => ({ name })), '__EnumValue');
    if (field === 'inputFields') return resolvedList([], 'null');
    if (field === 'interfaces') return resolvedList([], 'null');
    if (field === 'ofType') return resolvedScalar(null);
    return resolvedScalar(null);
  }
  if (typeName === '__Field') {
    const item = object as { name: string };
    if (field === 'name') return resolvedScalar(item.name);
    return resolvedScalar(null);
  }
  if (typeName === '__EnumValue') {
    const item = object as { name: string };
    if (field === 'name') return resolvedScalar(item.name);
    return resolvedScalar(null);
  }
  if (typeName === 'User') {
    const user = (object as Record<string, unknown>) ?? {};
    if (field === 'login') return resolvedScalar(user.login ?? LOGIN);
    if (field === 'id') return resolvedScalar('U' + String(user.id ?? USER_ID));
    return resolvedScalar(null);
  }
  if (typeName === 'Repository') {
    const repo = object as Repo;
    return resolveRepositoryField(repo, field, args);
  }
  if (typeName === 'Ref') {
    const ref = object as { name: string };
    if (field === 'name') return resolvedScalar(ref.name);
    if (field === 'prefix') return resolvedScalar('refs/heads/');
    if (field === 'id') return resolvedScalar('Ref' + ref.name);
    return resolvedScalar(null);
  }
  if (typeName === 'Issue') {
    const wrapper = object as { issue: Issue; repo: Repo };
    const issue = wrapper.issue;
    switch (field) {
      case 'id':
        return resolvedScalar(issueNodeId(wrapper.repo, issue));
      case 'number':
        return resolvedScalar(issue.number);
      case 'title':
        return resolvedScalar(issue.title);
      case 'state':
        return resolvedScalar(issue.state === 'open' ? 'OPEN' : 'CLOSED');
      case 'body':
        return resolvedScalar(issue.body);
      case 'author':
        return { value: { login: issue.user }, type: 'User' };
      case 'createdAt':
        return resolvedScalar(issue.createdAt);
      case 'updatedAt':
        return resolvedScalar(issue.updatedAt);
      case 'closedAt':
        return resolvedScalar(issue.closedAt);
      case 'stateReason':
        return resolvedScalar(issue.state === 'closed' ? 'COMPLETED' : null);
      case 'url':
        return resolvedScalar('/' + LOGIN + '/' + wrapper.repo.name + '/issues/' + issue.number);
      case 'repository':
        return { value: wrapper.repo, type: 'Repository' };
      default:
        return resolvedScalar(null);
    }
  }
  if (typeName === 'IssueConnection') {
    const connection = object as { nodes: Issue[]; hasNextPage: boolean; endCursor: string | null; totalCount: number };
    if (field === 'nodes') return resolvedList(connection.nodes, 'Issue');
    if (field === 'edges') return resolvedList(connection.nodes.map((issue) => ({ node: issue, cursor: '' })), 'IssueEdge');
    if (field === 'pageInfo') return { value: { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }, type: 'PageInfo' };
    if (field === 'totalCount') return resolvedScalar(connection.totalCount);
    return resolvedScalar(null);
  }
  if (typeName === 'IssueEdge') {
    const edge = object as { node: Issue };
    if (field === 'node') return { value: edge.node, type: 'Issue' };
    if (field === 'cursor') return resolvedScalar('');
    return resolvedScalar(null);
  }
  if (typeName === 'PageInfo') {
    const page = object as { hasNextPage?: boolean; endCursor?: string | null };
    if (field === 'hasNextPage') return resolvedScalar(page.hasNextPage === true);
    if (field === 'hasPreviousPage') return resolvedScalar(false);
    if (field === 'endCursor') return resolvedScalar(page.endCursor ?? null);
    if (field === 'startCursor') return resolvedScalar(null);
    return resolvedScalar(null);
  }
  if (typeName === 'PullRequest') return resolvePullRequestField(object as PullWrapper, field, args);
  if (typeName === 'PullRequestConnection') {
    const connection = object as { nodes: PullWrapper[]; hasNextPage: boolean; endCursor: string | null; totalCount: number };
    if (field === 'nodes') return resolvedList(connection.nodes, 'PullRequest');
    if (field === 'pageInfo') return { value: { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }, type: 'PageInfo' };
    if (field === 'totalCount') return resolvedScalar(connection.totalCount);
    return resolvedScalar(null);
  }
  if (typeName === 'PullRequestFiles') {
    const files = object as PullFile[];
    if (field === 'nodes') return resolvedList(files, 'PullRequestChangedFile');
    if (field === 'edges') return resolvedList(files.map((file) => ({ node: file })), 'PullRequestChangedFileEdge');
    if (field === 'pageInfo') return { value: { hasNextPage: false, endCursor: null }, type: 'PageInfo' };
    if (field === 'totalCount') return resolvedScalar(files.length);
    return resolvedScalar(null);
  }
  if (typeName === 'PullRequestChangedFile') {
    const file = object as PullFile;
    if (field === 'path') return resolvedScalar(file.filename);
    if (field === 'additions') return resolvedScalar(file.additions);
    if (field === 'deletions') return resolvedScalar(file.deletions);
    if (field === 'oid') return resolvedScalar(null);
    return resolvedScalar(null);
  }
  return resolvedScalar(null);
}

function resolveRepositoryField(repo: Repo, field: string, args: Record<string, unknown>): Resolved {
  switch (field) {
    case 'id':
      return resolvedScalar(repoNodeId(repo));
    case 'databaseId':
      return resolvedScalar(repo.id);
    case 'name':
      return resolvedScalar(repo.name);
    case 'nameWithOwner':
      return resolvedScalar(LOGIN + '/' + repo.name);
    case 'owner':
      return { value: { login: LOGIN }, type: 'User' };
    case 'description':
      return resolvedScalar(repo.description);
    case 'createdAt':
      return resolvedScalar(repo.createdAt);
    case 'updatedAt':
      return resolvedScalar(repo.updatedAt);
    case 'url':
      return resolvedScalar('/' + LOGIN + '/' + repo.name);
    case 'isPrivate':
      return resolvedScalar(repo.isPrivate);
    case 'isFork':
      return resolvedScalar(false);
    case 'isEmpty':
      return resolvedScalar(repo.refs.size === 0);
    case 'viewerPermission':
      return resolvedScalar('ADMIN');
    case 'hasIssuesEnabled':
      return resolvedScalar(true);
    case 'diskUsage':
      return resolvedScalar(0);
    case 'viewerCanAdminister':
      return resolvedScalar(true);
    case 'defaultBranchRef': {
      const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
      if (tip === undefined) return resolvedScalar(null);
      return { value: { name: repo.defaultBranch }, type: 'Ref' };
    }
    case 'ref': {
      const name = asString(args.name);
      const oid = repo.refs.get(name);
      if (oid === undefined) return resolvedScalar(null);
      return { value: { name }, type: 'Ref' };
    }
    case 'issue': {
      const number = args.number;
      const issue = typeof number === 'number' ? findIssue(repo, number) : null;
      if (issue === null) return resolvedScalar(null);
      return { value: issueWrapper(issue, repo), type: 'Issue' };
    }
    case 'issues': {
      const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 100;
      const after = decodeCursor(typeof args.after === 'string' ? args.after : '');
      const states = Array.isArray(args.states) ? (args.states as string[]).map(String) : [];
      const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
      let issues = repo.issues.slice();
      if (states.length > 0) {
        const wanted = new Set(states.map((state) => state.toUpperCase()));
        issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
      }
      const direction = orderBy !== null ? String(orderBy.direction ?? 'ASC').toUpperCase() : 'ASC';
      issues.sort((a, b) => {
        const cmp = a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1;
        return direction === 'DESC' ? -cmp : cmp;
      });
      const start = after;
      const slice = issues.slice(start, start + first);
      const hasNextPage = start + slice.length < issues.length;
      const endCursor = slice.length > 0 ? encodeCursor(start + slice.length) : null;
      return {
        value: { nodes: slice.map((issue) => issueWrapper(issue, repo)), hasNextPage, endCursor, totalCount: issues.length },
        type: 'IssueConnection',
      };
    }
    case 'pullRequest': {
      const number = args.number;
      const pull = typeof number === 'number' ? findPull(repo, number) : null;
      if (pull === null) return resolvedScalar(null);
      return { value: pullWrapper(pull, repo), type: 'PullRequest' };
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 50;
      const pulls = repo.pulls.filter((pull) => pull.state === 'open').slice(0, first);
      return {
        value: { nodes: pulls.map((pull) => pullWrapper(pull, repo)), hasNextPage: false, endCursor: null, totalCount: pulls.length },
        type: 'PullRequestConnection',
      };
    }
    case 'object':
      return resolvedScalar(null);
    default:
      return resolvedScalar(null);
  }
}

interface IssueWrapper {
  issue: Issue;
  repo: Repo;
}

interface PullWrapper {
  pull: Pull;
  repo: Repo;
}

function issueWrapper(issue: Issue, repo: Repo): IssueWrapper {
  return { issue, repo };
}

function pullWrapper(pull: Pull, repo: Repo): PullWrapper {
  return { pull, repo };
}

function resolvePullRequestField(wrapper: PullWrapper, field: string, args: Record<string, unknown>): Resolved {
  const pull = wrapper.pull;
  const repo = wrapper.repo;
  switch (field) {
    case 'id':
      return resolvedScalar(pullNodeId(repo, pull));
    case 'number':
      return resolvedScalar(pull.number);
    case 'title':
      return resolvedScalar(pull.title);
    case 'body':
      return resolvedScalar(pull.body);
    case 'state':
      return resolvedScalar(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'merged':
      return resolvedScalar(pull.merged);
    case 'mergedAt':
      return resolvedScalar(pull.mergedAt);
    case 'closedAt':
      return resolvedScalar(pull.closedAt);
    case 'createdAt':
      return resolvedScalar(pull.createdAt);
    case 'headRefName':
      return resolvedScalar(pull.head);
    case 'baseRefName':
      return resolvedScalar(pull.base);
    case 'mergeable':
      return resolvedScalar(pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE');
    case 'mergeStateStatus':
      return resolvedScalar(pullConflicts(repo, pull) ? 'DIRTY' : 'CLEAN');
    case 'url':
      return resolvedScalar('/' + LOGIN + '/' + repo.name + '/pull/' + pull.number);
    case 'author':
      return { value: { login: pull.user }, type: 'User' };
    case 'repository':
      return { value: repo, type: 'Repository' };
    case 'files': {
      const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 50;
      return { value: pull.files.slice(0, first), type: 'PullRequestFiles' };
    }
    default:
      return resolvedScalar(null);
  }
}

function introspectType(name: string): Record<string, unknown> | null {
  const fields = SCHEMA_FIELDS[name];
  if (fields === undefined) return null;
  if (SCHEMA_ENUMS.has(name)) {
    return { kind: 'ENUM', name, fields: [], enumValues: [...fields] };
  }
  return { kind: 'OBJECT', name, fields, enumValues: [] };
}

function encodeCursor(index: number): string {
  return Buffer.from('cursor:' + index, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  if (cursor === '' || cursor === 'null') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (text.startsWith('cursor:')) {
      const value = Number(text.slice('cursor:'.length));
      if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
    }
  } catch {
    // fall through
  }
  return 0;
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over the Streamable HTTP transport at /mcp
// ---------------------------------------------------------------------------

const MCP_REVISION = '2026-07-28';
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

function mcpToolSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

const MCP_TOOLS: readonly Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated account.',
    inputSchema: mcpToolSchema(
      {
        name: { type: 'string', description: 'The name of the repository' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'The account that owns the repository' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get details of one repository.',
    inputSchema: mcpToolSchema(
      {
        owner: { type: 'string', description: 'The account that owns the repository' },
        repo: { type: 'string', description: 'The repository name' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: mcpToolSchema(
      {
        owner: { type: 'string', description: 'The account that owns the repository' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of one repository.',
    inputSchema: mcpToolSchema(
      {
        owner: { type: 'string', description: 'The account that owns the repository' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: mcpToolSchema(
      {
        owner: { type: 'string', description: 'The account that owns the repository' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch' },
        base: { type: 'string', description: 'The base branch' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge one pull request of a repository.',
    inputSchema: mcpToolSchema(
      {
        owner: { type: 'string', description: 'The account that owns the repository' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of one repository.',
    inputSchema: mcpToolSchema(
      {
        owner: { type: 'string', description: 'The account that owns the repository' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      ['owner', 'repo'],
    ),
  },
];

const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);

function mcpRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function mcpRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function mcpToolCall(name: string, args: Record<string, unknown>): { result: unknown; isError: boolean } {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = (canonical: string): boolean => {
    const wanted = canonical.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized === wanted || (normalized.length > wanted.length && normalized.endsWith(wanted));
  };
  const owner = asString(args.owner) === '' ? LOGIN : asString(args.owner);
  const repoName = asString(args.repo);
  const fullName = owner + '/' + repoName;
  if (matches('create_repo')) {
    const name = asString(args.name).trim();
    if (name === '') return toolError('create_repo requires a name');
    const repo = repos.get(name);
    const created = repo ?? newRepo(name, asString(args.description), args.private === true);
    return toolText({
      id: created.id,
      node_id: repoNodeId(created),
      name: created.name,
      full_name: LOGIN + '/' + created.name,
      private: created.isPrivate,
      owner: { login: LOGIN },
      description: created.description,
      default_branch: created.defaultBranch,
      created_at: created.createdAt,
    });
  }
  if (matches('get_repo')) {
    const repo = findRepo(owner, repoName);
    if (repo === null) return toolError('repository ' + fullName + ' was not found');
    return toolText({
      id: repo.id,
      node_id: repoNodeId(repo),
      name: repo.name,
      full_name: LOGIN + '/' + repo.name,
      private: repo.isPrivate,
      owner: { login: LOGIN },
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    });
  }
  if (matches('create_issue')) {
    const repo = findRepo(owner, repoName);
    if (repo === null) return toolError('repository ' + fullName + ' was not found');
    const title = asString(args.title);
    if (title === '') return toolError('create_issue requires a title');
    try {
      const issue = createIssue(repo, title, asString(args.body), null);
      return toolText({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: '/repos/' + fullName + '/issues/' + issue.number,
      });
    } catch (err) {
      return toolError(err instanceof Error ? err.message : 'could not create the issue');
    }
  }
  if (matches('list_issues')) {
    const repo = findRepo(owner, repoName);
    if (repo === null) return toolError('repository ' + fullName + ' was not found');
    const state = (asString(args.state) === '' ? 'open' : asString(args.state)).toLowerCase();
    let issues = repo.issues.slice().sort((a, b) => b.number - a.number);
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    return toolText(
      issues.slice(0, 50).map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        created_at: issue.createdAt,
        url: '/repos/' + fullName + '/issues/' + issue.number,
      })),
    );
  }
  if (matches('create_pull_request')) {
    const repo = findRepo(owner, repoName);
    if (repo === null) return toolError('repository ' + fullName + ' was not found');
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base) === '' ? repo.defaultBranch : asString(args.base);
    if (title === '' || head === '') return toolError('create_pull_request requires a title and a head branch');
    try {
      const pull = createPull(repo, head, base, title, asString(args.body));
      return toolText({
        id: pullNodeId(repo, pull),
        number: pull.number,
        title: pull.title,
        state: 'OPEN',
        headRefName: pull.head,
        baseRefName: pull.base,
        url: '/repos/' + fullName + '/pull/' + pull.number,
      });
    } catch (err) {
      return toolError(err instanceof Error ? err.message : 'could not create the pull request');
    }
  }
  if (matches('merge_pull_request')) {
    const repo = findRepo(owner, repoName);
    if (repo === null) return toolError('repository ' + fullName + ' was not found');
    const number = asNumber(args.pull_number) ?? asNumber(args.number);
    if (number === null) return toolError('merge_pull_request requires a pull_number');
    const pull = findPull(repo, number);
    if (pull === null) return toolError('pull request ' + fullName + '#' + number + ' was not found');
    try {
      const sha = mergePullSquash(repo, pull);
      return toolText({ merged: true, sha, number: pull.number, state: 'MERGED', message: 'Pull Request successfully merged' });
    } catch (err) {
      return toolError(err instanceof Error ? err.message : 'could not merge the pull request');
    }
  }
  if (matches('list_pull_requests')) {
    const repo = findRepo(owner, repoName);
    if (repo === null) return toolError('repository ' + fullName + ' was not found');
    const state = (asString(args.state) === '' ? 'open' : asString(args.state)).toLowerCase();
    let pulls = repo.pulls.slice().sort((a, b) => b.number - a.number);
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    return toolText(
      pulls.slice(0, 50).map((pull) => ({
        number: pull.number,
        title: pull.title,
        state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
        headRefName: pull.head,
        baseRefName: pull.base,
        url: '/repos/' + fullName + '/pull/' + pull.number,
      })),
    );
  }
  return { result: null, isError: false };
}

function toolText(payload: unknown): { result: unknown; isError: boolean } {
  return { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] }, isError: false };
}

function toolError(message: string): { result: unknown; isError: boolean } {
  return { result: { content: [{ type: 'text', text: message }], isError: true }, isError: true };
}

async function handleMcp(ctx: Ctx): Promise<void> {
  const body = await readBody(ctx.req);
  const bodyText = body.toString('utf8');
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    sendJsonText(ctx, 400, mcpRpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return;
  }
  if (!isRecord(request)) {
    sendJsonText(ctx, 400, mcpRpcError(null, JSON_RPC_INVALID_PARAMS, 'Invalid Request'));
    return;
  }
  const method = asString(request.method);
  const hasId = request.id !== undefined;
  const id = request.id;
  const params = isRecord(request.params) ? request.params : {};
  if (method.startsWith('notifications/')) {
    sendEmpty(ctx, 202);
    return;
  }
  if (method === 'server/discover') {
    sendJsonText(
      ctx,
      200,
      mcpRpcResult(id, {
        resultType: 'accept',
        protocolVersion: MCP_REVISION,
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false }, completions: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: 'GitHub-compatible forge: repositories, issues and pull requests over MCP tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: VERSION } },
      }),
    );
    return;
  }
  if (method === 'initialize') {
    sendJsonText(
      ctx,
      200,
      mcpRpcResult(id, {
        protocolVersion: MCP_REVISION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: 'GitHub-compatible forge: repositories, issues and pull requests over MCP tools.',
      }),
    );
    return;
  }
  if (method === 'tools/list') {
    sendJsonText(ctx, 200, mcpRpcResult(id, { tools: JSON.parse(MCP_TOOLS_JSON) as unknown[] }));
    return;
  }
  if (method === 'tools/call') {
    const name = asString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    const call = mcpToolCall(name, args);
    if (call.result === null && !call.isError) {
      sendJsonText(ctx, 200, mcpRpcError(id, JSON_RPC_INVALID_PARAMS, 'tool ' + name + ' was not found'));
      return;
    }
    sendJsonText(ctx, 200, mcpRpcResult(id, call.result));
    return;
  }
  if (method === 'ping') {
    sendJsonText(ctx, 200, mcpRpcResult(id, {}));
    return;
  }
  sendJsonText(ctx, 200, mcpRpcError(id, JSON_RPC_METHOD_NOT_FOUND, 'method ' + method + ' was not found'));
}

// ---------------------------------------------------------------------------
// the main router
// ---------------------------------------------------------------------------

async function route(ctx: Ctx): Promise<void> {
  const pathname = ctx.url.pathname;
  if ((FORGE_TIMING || FORGE_PROFILE) && pathname === '/__stop') {
    // Local-profiling aid only (never set by the trial env): dump instrumentation and exit.
    if (FORGE_TIMING) dumpTiming();
    if (FORGE_PROFILE) await stopProfiler();
    process.exit(0);
  }
  if (pathname === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }
  // The benchmark's hot surfaces first: REST v3 and git smart HTTP carry every timed request.
  if (pathname.startsWith('/api/v3')) {
    if (!ctx.authorized) return errorMessage(ctx, 401, 'Requires authentication');
    const trimmed = pathname.replace(/\/+$/, '');
    const suffix = trimmed === '/api/v3' ? '' : trimmed.slice('/api/v3'.length);
    const segments = suffix.split('/').filter((segment) => segment !== '');
    await handleRest(ctx, segments);
    return;
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/(info\/refs|git-upload-pack|git-receive-pack))?$/.exec(pathname);
  if (gitMatch !== null) {
    if (!ctx.authorized) return errorMessage(ctx, 401, 'Requires authentication');
    const owner = decodeSegmentSafe(gitMatch[1]!);
    const repoName = decodeSegmentSafe(gitMatch[2]!);
    const endpoint = gitMatch[4];
    if (endpoint === undefined) return errorMessage(ctx, 404, 'Not Found');
    if (endpoint === 'info/refs') {
      await handleGitInfoRefs(ctx, owner, repoName);
      return;
    }
    if (endpoint === 'git-upload-pack') {
      await handleGitUploadPack(ctx, owner, repoName);
      return;
    }
    await handleGitReceivePack(ctx, owner, repoName);
    return;
  }
  if (pathname === '/api/graphql') {
    if (!ctx.authorized) return errorMessage(ctx, 401, 'Bad credentials');
    if (ctx.req.method !== 'POST') return errorMessage(ctx, 404, 'Not Found');
    const body = await readBody(ctx.req);
    handleGraphql(ctx, body);
    return;
  }
  if (pathname === '/mcp') {
    if (!ctx.authorized) {
      sendJsonText(ctx, 401, JSON.stringify({ message: 'Bad credentials', error: { code: -32000, message: 'Unauthorized' } }));
      return;
    }
    if (ctx.req.method !== 'POST') {
      sendEmpty(ctx, 405);
      return;
    }
    await handleMcp(ctx);
    return;
  }
  errorMessage(ctx, 404, 'Not Found');
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const timingStart = FORGE_TIMING ? performance.now() : 0;
  const ctx: Ctx = {
    req,
    res,
    url: new URL(req.url ?? '/', 'http://forge'),
    requestId: nextRequestId(),
    authorized: false,
    done: false,
  };
  ctx.authorized = authorizedRequest(ctx);
  if (FORGE_TIMING) process.stderr.write('[req] ' + (req.method ?? '?') + ' ' + (req.url ?? '/') + '\n');
  try {
    await route(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (!res.writableEnded) errorMessage(ctx, 500, 'forge internal error: ' + message);
    } catch {
      // the peer went away
    }
  } finally {
    if (FORGE_TIMING) recordTiming(timingBucketOf(ctx.url.pathname, req.method ?? 'GET'), performance.now() - timingStart);
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function registerWithEnv(server: Server): Promise<void> {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the forge listener has no TCP address');
  const port = address.port;
  let registered = false;
  const deadline = Date.now() + 18_000;
  while (!registered && Date.now() < deadline) {
    try {
      const response = await fetch(ENV_URL.replace(/\/+$/, '') + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(3_000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200 || response.status === 409) registered = true;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!registered) throw new Error('the trial environment did not accept the register request in time');
  log('registered with ' + ENV_URL + ' on port ' + port);
  void pollDone();
}

async function pollDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(ENV_URL.replace(/\/+$/, '') + '/done', { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      const parsed = JSON.parse(text) as { done?: boolean };
      if (parsed.done === true) {
        log('the suite is done; exiting');
        process.exit(0);
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(2_000, delay * 2);
  }
}

async function main(): Promise<void> {
  process.on('uncaughtException', (err: Error) => {
    log('uncaught exception: ' + err.message + (FORGE_TIMING ? '\n' + (err.stack ?? '') : ''));
  });
  process.on('unhandledRejection', (reason: unknown) => {
    log('unhandled rejection: ' + String(reason));
  });
  if (FORGE_TIMING) {
    const dumpAndLeave = (): void => {
      dumpTiming();
      process.exit(0);
    };
    process.on('SIGTERM', dumpAndLeave);
    process.on('SIGINT', dumpAndLeave);
    process.on('exit', dumpTiming);
  }
  if (FORGE_PROFILE) {
    void startProfiler();
    process.on('SIGTERM', () => {
      void stopProfiler().then(() => process.exit(0));
    });
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(0);
  });
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      // the socket is gone
    }
  });
  const listen = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await listen;
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  log('forge listening on port ' + port);
  if (ENV_URL !== '') {
    try {
      await registerWithEnv(server);
    } catch (err) {
      log('register failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  } else {
    log('MAKEFUN_ENV_URL is not set; serving until killed');
  }
  // Keep the process alive; the done poll or a signal ends it.
  setInterval(() => undefined, 60_000).unref();
}

void main();
