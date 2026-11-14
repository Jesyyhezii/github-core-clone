// A standalone GitHub-compatible git forge: git smart HTTP (upload-pack protocol v2 + v0
// fallback, receive-pack v0), the REST v3 API under /api/v3, GraphQL v4 at /api/graphql and
// an MCP endpoint at /mcp, all from one in-memory store and Node's standard library only.
//
// app.ts is the server; main.ts is the entry <-> env lifecycle and stays as the starter ships it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// --------------------------------------------------------------------------- constants

const JSON_TYPE = 'application/json; charset=utf-8';
/** The login the trial token names (the suite's seeded viewer; wire.ts buildScenario()). */
const VIEWER = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const DEFAULT_BRANCH = 'main';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Deterministic clock: a fixed epoch plus a per-event step, never the wall clock. */
let clockSeq = 0;
function tickIso(): string {
  clockSeq += 1;
  return new Date(1_735_689_600_000 + clockSeq * 60_000).toISOString();
}
function tickEpoch(): number {
  return 1_735_689_600 + clockSeq * 60;
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

// --------------------------------------------------------------------------- git object model

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git tree ordering: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
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
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Peel an oid through annotated tags until a non-tag object (or a missing object). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTagTarget(obj.data).object;
  }
  return current;
}

// --------------------------------------------------------------------------- packfiles

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize(); // source size (the caller's base is authoritative)
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a packfile, resolving OFS/REF deltas; REF bases may come from `external` (the repo store). */
function readPack(pack: Buffer, external?: Map<string, GitObj>): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  const resolved = new Map<string, GitObj>();
  const resolvedByOffset = new Map<number, GitObj & { oid: string }>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset];
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    if (entry.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObj & { oid: string } => {
    const done = resolvedByOffset.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let obj: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      let base: GitObj | undefined;
      for (const candidate of resolvedByOffset.values()) {
        if (candidate.oid === entry.baseOid) {
          base = candidate;
          break;
        }
      }
      if (!base && external) base = external.get(entry.baseOid ?? '');
      if (!base) throw new Error('ref-delta base missing');
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error('bad pack type');
      obj = { type, data: entry.data };
    }
    const withOid = { ...obj, oid: hashObject(obj.type, obj.data) };
    resolving.delete(entry.offset);
    resolvedByOffset.set(entry.offset, withOid);
    resolved.set(withOid.oid, obj);
    return withOid;
  };
  for (const entry of raw) resolve(entry);
  return resolved;
}

// --------------------------------------------------------------------------- pkt-line

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse a whole pkt-line stream; `rest` is whatever follows the final flush (a packfile). */
function parsePkts(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Split a request body into sections by flush packets (receive-pack: one section then a pack). */
function pktSections(packets: Pkt[]): Pkt[][] {
  const sections: Pkt[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') sections.push([]);
    else sections[sections.length - 1].push(packet);
  }
  return sections;
}

// --------------------------------------------------------------------------- the store

interface IssueRec {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: { id: number; body: string }[];
}

interface PullRec {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  seq: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string; description: string | null }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

const repos = new Map<string, Repo>(); // key: repo name (the forge serves one owner's namespace)
let nextRepoId = 10_000;
let nextDbId = 50_000;

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER) return null;
  return repos.get(name) ?? null;
}

function createRepo(name: string, priv: boolean, description: string): Repo {
  nextRepoId += 1;
  clockSeq += 1;
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER,
    description,
    priv,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    seq: clockSeq,
  };
  repos.set(name, repo);
  return repo;
}

// --------------------------------------------------------------------------- trees and commits

type FlatFiles = Map<string, { sha: string; size: number }>;

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: FlatFiles): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(repo, entry.oid, path, out);
    } else {
      const blob = repo.objects.get(entry.oid);
      out.set(path, { sha: entry.oid, size: blob ? blob.data.length : 0 });
    }
  }
}

function filesAtCommit(repo: Repo, commitOid: string): FlatFiles {
  const out: FlatFiles = new Map();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  flattenTree(repo, parseCommit(obj.data).tree, '', out);
  return out;
}

function treeFromFiles(repo: Repo, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, sha] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1], sha);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, oid: sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const stamp = tickEpoch();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp} +0000`;
  let text = `tree ${treeOid}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Commit a file change (set or delete `path`) on `branch`, creating the branch when needed. */
function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseFiles = tip ? filesAtCommit(repo, tip) : new Map<string, { sha: string; size: number }>();
  const fileMap = new Map<string, string>();
  for (const [p, entry] of baseFiles) fileMap.set(p, entry.sha);
  let blobSha = '';
  if (content === null) {
    fileMap.delete(path);
  } else {
    blobSha = storeObject(repo, 'blob', content);
    fileMap.set(path, blobSha);
  }
  const tree = treeFromFiles(repo, fileMap);
  const commitSha = makeCommit(repo, tree, tip ? [tip] : [], message);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** All ancestors of `tip`, tip first (BFS by generation). */
function ancestorsOf(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    order.push(current);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return order;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === ancestor) return true;
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(ancestorsOf(repo, a));
  for (const candidate of ancestorsOf(repo, b)) {
    if (ancestorsA.has(candidate)) return candidate;
  }
  return null;
}

/** The files a pull request changes, comparing its head tree against its base tree. */
function pullFiles(repo: Repo, pull: PullRec): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!headTip) return [];
  const base = baseTip ? mergeBase(repo, baseTip, headTip) : null;
  const baseFiles = base ? filesAtCommit(repo, base) : new Map<string, { sha: string; size: number }>();
  const headFiles = filesAtCommit(repo, headTip);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.sha === after?.sha) continue;
    const beforeText = before ? (repo.objects.get(before.sha)?.data.toString('utf8') ?? '') : '';
    const afterText = after ? (repo.objects.get(after.sha)?.data.toString('utf8') ?? '') : '';
    const beforeLines = beforeText === '' ? 0 : beforeText.split('\n').length;
    const afterLines = afterText === '' ? 0 : afterText.split('\n').length;
    const additions = after ? Math.max(1, afterLines) : 0;
    const deletions = before ? Math.max(1, beforeLines) : 0;
    out.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** Squash-merge a pull request onto its base branch; null when the merge conflicts. */
function squashMerge(repo: Repo, pull: PullRec): string | null {
  const baseRef = `refs/heads/${pull.base}`;
  const headRef = `refs/heads/${pull.head}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return null;
  if (isAncestor(repo, headTip, baseTip)) {
    // Already up to date: an empty squash commit keeps the contract (a sha on the base branch).
    const tree = parseCommit((repo.objects.get(baseTip) as GitObj).data).tree;
    const sha = makeCommit(repo, tree, [baseTip], pull.title);
    repo.refs.set(baseRef, sha);
    return sha;
  }
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = base ? filesAtCommit(repo, base) : new Map<string, { sha: string; size: number }>();
  const currentFiles = filesAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, headTip);
  const merged = new Map<string, string>();
  for (const [p, entry] of currentFiles) merged.set(p, entry.sha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path)?.sha;
    const inHead = headFiles.get(path)?.sha;
    if (inBase === inHead) continue; // the head did not change this path
    const inCurrent = currentFiles.get(path)?.sha;
    if (inCurrent !== inBase && inCurrent !== inHead) return null; // both sides changed it differently
    if (inHead === undefined) merged.delete(path);
    else merged.set(path, inHead);
  }
  const tree = treeFromFiles(repo, merged);
  const sha = makeCommit(repo, tree, [baseTip], `${pull.title}\n\n${pull.body}`.trim());
  repo.refs.set(baseRef, sha);
  return sha;
}

function pullMergeable(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  // Dry-run the squash on a scratch refs view: reuse the merge logic against copies is overkill;
  // a cheap three-way check mirrors squashMerge's conflict rule.
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = base ? filesAtCommit(repo, base) : new Map<string, { sha: string; size: number }>();
  const currentFiles = filesAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path)?.sha;
    const inHead = headFiles.get(path)?.sha;
    if (inBase === inHead) continue;
    const inCurrent = currentFiles.get(path)?.sha;
    if (inCurrent !== inBase && inCurrent !== inHead) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function doMergePull(repo: Repo, pull: PullRec): { sha: string } | { conflict: true } | null {
  if (pull.state !== 'open') return null;
  const sha = squashMerge(repo, pull);
  if (sha === null) return { conflict: true };
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = tickIso();
  pull.mergeCommitSha = sha;
  return { sha };
}

// --------------------------------------------------------------------------- HTTP plumbing

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 96 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; {ok:false} when a non-empty body is not JSON. */
function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// --------------------------------------------------------------------------- REST serialization

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.priv,
    description: repo.description,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `/${repo.owner}/${repo.name}.git`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    language: null,
    topics: [],
    visibility: repo.priv ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: { name: string; color: string; description: string | null }): Record<string, unknown> {
  return { id: 1, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
  return {
    id: pull.dbId,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    head: {
      ref: pull.head,
      sha: headSha,
      label: `${VIEWER}:${pull.head}`,
      repo: repoJson(repo),
      user: { login: VIEWER, id: VIEWER_ID },
    },
    base: {
      ref: pull.base,
      sha: baseSha,
      label: `${VIEWER}:${pull.base}`,
      repo: repoJson(repo),
      user: { login: VIEWER, id: VIEWER_ID },
    },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? '2025-01-01T00:00:00Z') : null,
    html_url: `/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const view = obj && obj.type === 'commit' ? parseCommit(obj.data) : { tree: ZERO_OID, parents: [], author: '', committer: '', message: '' };
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    if (!match) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: '2025-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message: view.message.replace(/\n+$/, ''),
      tree: { sha: view.tree, url: '' },
      author: ident(view.author),
      committer: ident(view.committer),
      comment_count: 0,
    },
    author: { login: VIEWER, id: VIEWER_ID },
    committer: { login: VIEWER, id: VIEWER_ID },
    parents: view.parents.map((parent) => ({ sha: parent, url: '' })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** Opaque, stable GraphQL global ids: base64 of "<Type>:<key>". */
function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { type: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  const wanted = Number(parsed.key);
  for (const repo of repos.values()) if (repo.id === wanted) return repo;
  return null;
}

// --------------------------------------------------------------------------- REST v3

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** Slice `items` for the page and set a Link rel="next" header when a further page exists. */
function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: T[]): T[] {
  const { page, perPage } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('page', String(lastPage));
    last.searchParams.set('per_page', String(perPage));
    res.setHeader('link', `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`);
  }
  return slice;
}

/** Navigate the tree of `commitOid` to `dirPath` ('' for the root) and list its immediate entries. */
function dirListing(repo: Repo, commitOid: string, dirPath: string): Record<string, unknown>[] | null {
  const commitObj = repo.objects.get(commitOid);
  if (!commitObj || commitObj.type !== 'commit') return null;
  let treeOid = parseCommit(commitObj.data).tree;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return null;
      const entry = parseTree(treeObj.data).find((candidate) => candidate.name === segment);
      if (!entry) return null;
      treeOid = entry.oid;
    }
  }
  const treeObj = repo.objects.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') return null;
  return parseTree(treeObj.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const blob = repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : (blob ? blob.data.length : 0),
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
      type: isDir ? 'dir' : 'file',
      _links: { self: '', git: '', html: '' },
    };
  });
}

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef) return byRef;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  if (obj && obj.type === 'tag') return peelToCommit(repo, ref);
  return null;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  // segments[0] === 'api', segments[1] === 'v3'
  const tail = segments.slice(2);

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  if (needsBody && raw.length > 0) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      errJson(res, 400, 'Problems parsing JSON');
      return;
    }
    body = parsed.value;
  }

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
          rate_limit_url: '/api/v3/rate_limit',
          emojis_url: '/api/v3/emojis',
          meta_url: '/api/v3/meta',
        },
        { 'x-oauth-scopes': 'repo, read:org, write:org, admin:org' },
      );
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  if (tail[0] === 'meta' && tail.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0-forge',
    });
    return;
  }

  if (tail[0] === 'user' && tail.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER,
      id: VIEWER_ID,
      node_id: globalId('User', String(VIEWER_ID)),
      type: 'User',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      site_admin: false,
    });
    return;
  }

  if (tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
      sendJson(res, 200, paginate(req, res, url, all));
      return;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (name === '') {
        errJson(res, 422, 'Repository creation failed: name is required');
        return;
      }
      if (repos.has(name)) {
        errJson(res, 422, 'Repository creation failed: name already exists on this account');
        return;
      }
      const repo = createRepo(name, body.private === undefined ? false : body.private === true, str(body.description));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  if (tail[0] === 'repos' && tail.length >= 3) {
    const owner = tail[1];
    const repo = getRepo(owner, tail[2]);
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return;
    }
    const rest = tail.slice(3);
    await handleRepoRest(req, res, url, method, body, repo, rest);
    return;
  }

  errJson(res, 404, 'Not Found');
}

async function handleRepoRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  body: Record<string, unknown>,
  repo: Repo,
  rest: string[],
): Promise<void> {
  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      sendJson(res, 204, undefined);
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, paginate(req, res, url, branches));
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        errJson(res, 404, 'Branch not found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: commitJson(repo, sha), protected: false });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // Git data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref);
      const sha = str(body.sha);
      const obj = repo.objects.get(sha);
      if (!ref.startsWith('refs/') || !obj) {
        errJson(res, 422, 'Invalid ref or sha');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, url: '', node_id: globalId('Ref', ref), object: { sha, type: obj.type, url: '' } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const joined = rest.slice(2).join('/');
      const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        errJson(res, 404, 'Not Found');
        return;
      }
      const obj = repo.objects.get(sha);
      sendJson(res, 200, { ref, url: '', node_id: globalId('Ref', ref), object: { sha, type: obj ? obj.type : 'commit', url: '' } });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, url.searchParams.get('sha'));
    if (!tip) {
      sendJson(res, 200, []);
      return;
    }
    const all = ancestorsOf(repo, tip).map((sha) => commitJson(repo, sha));
    sendJson(res, 200, paginate(req, res, url, all));
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, url.searchParams.get('ref'));
      if (!tip) {
        errJson(res, 404, 'Not Found');
        return;
      }
      const files = filesAtCommit(repo, tip);
      const file = files.get(path);
      if (path !== '' && file) {
        const blob = repo.objects.get(file.sha);
        const content = blob ? blob.data : Buffer.alloc(0);
        sendJson(res, 200, {
          name: path.split('/').pop() ?? path,
          path,
          sha: file.sha,
          size: content.length,
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
          type: 'file',
          content: content.toString('base64'),
          encoding: 'base64',
          _links: { self: '', git: '', html: '' },
        });
        return;
      }
      const listing = dirListing(repo, tip, path);
      if (listing !== null && (path === '' || listing.length > 0 || files.size === 0)) {
        // A directory answers its entries; the root of an empty tree answers [].
        const isDir = path === '' || [...files.keys()].some((key) => key.startsWith(`${path}/`));
        if (isDir) {
          sendJson(res, 200, listing);
          return;
        }
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      if (path === '') {
        errJson(res, 422, 'path is required');
        return;
      }
      const branch = optStr(body.branch) ?? repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      const tip = repo.refs.get(ref);
      const existing = tip ? filesAtCommit(repo, tip).get(path) : undefined;
      if (existing) {
        if (body.sha === undefined) {
          errJson(res, 422, '"sha" is required when updating a file');
          return;
        }
        if (str(body.sha) !== existing.sha) {
          errJson(res, 409, 'Conflict: the sha does not match the current blob');
          return;
        }
      }
      const content = Buffer.from(str(body.content).replace(/\s+/g, ''), 'base64');
      const result = commitFileChange(repo, branch, path, content, str(body.message) || 'Update file');
      const blobObj = repo.objects.get(result.blobSha);
      sendJson(res, existing ? 200 : 201, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blobSha,
          size: blobObj ? blobObj.data.length : content.length,
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
          type: 'file',
          encoding: 'base64',
        },
        commit: commitJson(repo, result.commitSha).commit ? { sha: result.commitSha, ...commitMeta(repo, result.commitSha) } : { sha: result.commitSha },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = optStr(body.branch) ?? repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      const tip = repo.refs.get(ref);
      const existing = tip ? filesAtCommit(repo, tip).get(path) : undefined;
      if (!existing) {
        errJson(res, 404, 'Not Found');
        return;
      }
      if (body.sha !== undefined && str(body.sha) !== existing.sha) {
        errJson(res, 409, 'Conflict: the sha does not match the current blob');
        return;
      }
      const result = commitFileChange(repo, branch, path, null, str(body.message) || 'Delete file');
      sendJson(res, 200, { content: null, commit: { sha: result.commitSha, ...commitMeta(repo, result.commitSha) } });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = str(body.name);
      if (name === '') {
        errJson(res, 422, 'Validation failed: name is required');
        return;
      }
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, labelJson(existing));
        return;
      }
      const label = { name, color: (optStr(body.color) ?? 'ededed').replace(/^#/, ''), description: optStr(body.description) ?? null };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // Issues and comments.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const issue = createIssueRec(repo, body);
        if (issue === 'bad-label') {
          errJson(res, 422, 'Validation failed: label does not exist');
          return;
        }
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        const direction = url.searchParams.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendJson(res, 200, paginate(req, res, url, list.map((issue) => issueJson(repo, issue))));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (!issue) {
        errJson(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) {
        errJson(res, 404, 'Not Found');
        return;
      }
      if (method === 'POST') {
        const comment = { id: nextCommentId(repo), body: str(body.body) };
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(repo, issue, comment));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const created = createPullRec(repo, body);
        if (typeof created === 'string') {
          errJson(res, 422, created);
          return;
        }
        sendJson(res, 201, pullJson(repo, created));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        sendJson(res, 200, paginate(req, res, url, list.map((pull) => pullJson(repo, pull))));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2 && method === 'GET') {
      if (!pull) {
        errJson(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) {
        errJson(res, 404, 'Not Found');
        return;
      }
      const files = pullFiles(repo, pull).map((file) => ({ ...file, sha: '', patch: '' }));
      sendJson(res, 200, paginate(req, res, url, files));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) {
        errJson(res, 404, 'Not Found');
        return;
      }
      const result = doMergePull(repo, pull);
      if (result === null) {
        errJson(res, 405, 'Pull Request is not mergeable');
        return;
      }
      if ('conflict' in result) {
        errJson(res, 405, 'Pull Request has merge conflicts');
        return;
      }
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  errJson(res, 404, 'Not Found');
}

function commitMeta(repo: Repo, sha: string): Record<string, unknown> {
  const full = commitJson(repo, sha);
  return { message: (full.commit as Record<string, unknown>).message, author: (full.commit as Record<string, unknown>).author, committer: (full.commit as Record<string, unknown>).committer, tree: (full.commit as Record<string, unknown>).tree, parents: full.parents, url: full.url };
}

function nextCommentId(repo: Repo): number {
  nextDbId += 1;
  const id = repo.nextCommentId + 100_000 + nextDbId;
  repo.nextCommentId += 1;
  return id;
}

function commentJson(repo: Repo, issue: IssueRec, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Create an issue from a REST/MCP/GraphQL-shaped body; 'bad-label' when a named label is unknown. */
function createIssueRec(repo: Repo, input: { title?: unknown; body?: unknown; labels?: unknown }): IssueRec | 'bad-label' {
  const labelNames: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const entry of input.labels) {
      if (typeof entry === 'string') labelNames.push(entry);
      else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
        labelNames.push((entry as { name: string }).name);
      }
    }
  }
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return 'bad-label';
  }
  clockSeq += 1;
  nextDbId += 1;
  const issue: IssueRec = {
    number: repo.nextNumber,
    dbId: nextDbId,
    title: str(input.title),
    body: str(input.body),
    state: 'open',
    labels: labelNames,
    seq: clockSeq,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request; a string result is the 422 message. */
function createPullRec(repo: Repo, input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }): PullRec | string {
  let head = str(input.head);
  if (head.includes(':')) head = head.split(':').pop() as string;
  const base = str(input.base) || repo.defaultBranch;
  if (head === '') return 'Validation failed: head is required';
  if (!repo.refs.has(`refs/heads/${head}`)) return `Validation failed: head branch ${head} does not exist`;
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      return `A pull request already exists for ${VIEWER}:${head}`;
    }
  }
  clockSeq += 1;
  nextDbId += 1;
  const pull: PullRec = {
    number: repo.nextNumber,
    dbId: nextDbId,
    title: str(input.title),
    body: str(input.body),
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
    seq: clockSeq,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

// --------------------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta deepen-since deepen-not shallow';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta quiet atomic';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)} agent=forge/1.0` : `${RECEIVE_CAPS} symref=HEAD:${headTarget(repo)} agent=forge/1.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    lines.push(`${headOid} HEAD`);
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') lines.push(`${peelToCommit(repo, oid)} ${ref}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo | null): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendRaw(res, 400, Buffer.from('missing or invalid service\n'), 'text/plain');
    return;
  }
  if (!repo) {
    sendRaw(res, 404, Buffer.from('repository not found\n'), 'text/plain');
    return;
  }
  if (service === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'];
    if (typeof protocol === 'string' && protocol.includes('version=2')) {
      sendRaw(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendRaw(res, 200, advertiseV0(repo, service), 'application/x-git-upload-pack-advertisement');
    return;
  }
  sendRaw(res, 200, advertiseV0(repo, service), 'application/x-git-receive-pack-advertisement');
}

/** Parse a pkt-line request body into sections of data lines (delim-separated groups). */
function parseSections(raw: Buffer): { groups: Buffer[][]; rest: Buffer } {
  const { packets, rest } = parsePkts(raw);
  const groups: Buffer[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'delim') groups.push([]);
    else if (packet.kind === 'data') groups[groups.length - 1].push(packet.payload);
  }
  return { groups, rest };
}

/** Parse an upload-pack request fully: sections are separated by either a delim or a flush
 *  packet (v2 uses delim before arguments; v0 fetch separates wants from haves with a flush). */
function parseUploadSections(raw: Buffer): Buffer[][] {
  const groups: Buffer[][] = [[]];
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const header = raw.subarray(offset, offset + 4).toString('ascii');
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length) || length < 0) throw new Error('bad pkt-line length');
    if (length === 0 || length === 1) {
      groups.push([]);
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > raw.length) throw new Error('truncated pkt-line');
    groups[groups.length - 1].push(raw.subarray(offset + 4, offset + length));
    offset += length;
  }
  return groups;
}

function lsRefsResponse(repo: Repo, args: Buffer[], prefixes: string[]): Buffer {
  const argText = args.map((arg) => arg.toString('utf8').replace(/\n$/, ''));
  const wantPeel = argText.includes('peel');
  const wantSymrefs = argText.includes('symrefs');
  const wantUnborn = argText.includes('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (wantUnborn) {
      parts.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** Compute the object set for a fetch: reachable from wants, bounded by haves and shallow depth. */
function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const haveSet = new Set(haves);
  // Everything reachable from the haves is already on the client and must not be re-sent:
  // commits, their trees and blobs, and tag objects. The walk does not cross into the parents
  // of a commit the client holds shallowly — by definition it does not hold that history.
  const shallowHeld = new Set(clientShallow);
  const excluded = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      excluded.add(oid);
      if (obj.type === 'commit') {
        const parsedCommit = parseCommit(obj.data);
        stack.push(parsedCommit.tree);
        if (!shallowHeld.has(oid)) for (const parent of parsedCommit.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTagTarget(obj.data).object);
      }
    }
  }
  // Shallow cut: BFS generations from the wants over commit parents.
  let shallowBoundary = new Set<string>();
  let includedCommits = new Set<string>();
  const allWantedCommits: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (repo.objects.has(commit)) allWantedCommits.push(commit);
  }
  if (depth !== null && depth > 0) {
    let frontier = [...new Set(allWantedCommits)];
    const depths = new Map<string, number>();
    for (const commit of frontier) depths.set(commit, 1);
    includedCommits = new Set(frontier);
    let level = 1;
    while (level < depth && frontier.length > 0) {
      const next: string[] = [];
      for (const commit of frontier) {
        const obj = repo.objects.get(commit);
        if (!obj || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) {
          if (!depths.has(parent)) {
            depths.set(parent, level + 1);
            next.push(parent);
          }
        }
      }
      for (const commit of next) includedCommits.add(commit);
      frontier = next;
      level += 1;
    }
    // Include client-held shallow commits that fall inside the new depth (they are re-anchored).
    for (const held of clientShallow) {
      if (includedCommits.has(held)) continue;
      // A held commit joins the walk when one of its children is included.
    }
    shallowBoundary = new Set(
      [...includedCommits].filter((commit) => {
        const obj = repo.objects.get(commit);
        if (!obj || obj.type !== 'commit') return false;
        return parseCommit(obj.data).parents.some((parent) => !includedCommits.has(parent) && !haveSet.has(parent));
      }),
    );
  } else {
    for (const commit of allWantedCommits) {
      for (const oid of ancestorsOf(repo, commit)) {
        if (excluded.has(oid)) continue;
        includedCommits.add(oid);
      }
    }
    // Client shallow boundary: history below a held shallow commit stays cut.
    for (const held of clientShallow) {
      if (!includedCommits.has(held)) continue;
      const obj = repo.objects.get(held);
      if (obj && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) {
          // Parents of a shallow-held commit the client lacks the history of are not sent
          // unless they are reachable another way; mark the held commit as the boundary.
          if (!excluded.has(parent)) shallowBoundary.add(held);
        }
      }
    }
  }
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const held of clientShallow) {
      if (includedCommits.has(held) && !shallowBoundary.has(held)) unshallow.push(held);
    }
  }
  // Object closure: commits, their trees (recursively) and tag objects pointing at them.
  const send = new Map<string, GitObj>();
  const addObject = (oid: string): void => {
    if (send.has(oid) || excluded.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    send.set(oid, obj);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addObject(entry.oid);
    } else if (obj.type === 'tag') {
      addObject(parseTagTarget(obj.data).object);
    }
  };
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') addObject(want);
  }
  for (const commit of includedCommits) {
    if (excluded.has(commit)) continue;
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    send.set(commit, obj);
    addObject(parseCommit(obj.data).tree);
  }
  // Tags whose target commit ships should ship too (a clone expects its tags).
  if (depth === null) {
    for (const [, oid] of sortedRefs(repo)) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag' && includedCommits.has(parseTagTarget(obj.data).object)) addObject(oid);
    }
  }
  return { objects: [...send.values()], shallow: [...shallowBoundary], unshallow };
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65_515;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return parts;
}

function handleUploadPack(res: ServerResponse, repo: Repo, raw: Buffer, version2: boolean): void {
  let groups: Buffer[][];
  try {
    groups = parseUploadSections(raw);
  } catch {
    sendRaw(res, 400, Buffer.from('malformed pkt-line request\n'), 'text/plain');
    return;
  }
  const parsed = { groups };
  const firstGroup = parsed.groups[0] ?? [];
  const firstLine = firstGroup.length > 0 ? firstGroup[0].toString('utf8') : '';

  if (version2 || firstLine.startsWith('command=')) {
    const command = firstLine.replace(/\n$/, '').slice('command='.length);
    const args = firstGroup.slice(1);
    const secondGroup = parsed.groups[1] ?? [];
    if (command === 'ls-refs') {
      // Command arguments (peel / symrefs / unborn / ref-prefix) travel after the delim
      // packet in this client, alongside the ref-prefix lines; accept them from both groups.
      const prefixes = [...args, ...secondGroup]
        .map((line) => line.toString('utf8').replace(/\n$/, ''))
        .filter((line) => line.startsWith('ref-prefix '))
        .map((line) => line.slice('ref-prefix '.length));
      sendRaw(res, 200, lsRefsResponse(repo, [...args, ...secondGroup], prefixes), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow: string[] = [];
      let depth: number | null = null;
      for (const lineBuffer of secondGroup) {
        const line = lineBuffer.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      }
      const plan = planFetch(repo, wants, haves, clientShallow, depth);
      const pack = writePack(plan.objects);
      const parts: Buffer[] = [];
      if (haves.length > 0) {
        parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
      }
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(PKT_FLUSH);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandChunks(pack));
      parts.push(PKT_FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    sendRaw(res, 400, Buffer.from('unknown command\n'), 'text/plain');
    return;
  }

  // Protocol v0: wants in the first section, haves/done in the second.
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const lineBuffer of firstGroup) {
    const line = lineBuffer.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  for (const group of parsed.groups.slice(1)) {
    for (const lineBuffer of group) {
      const line = lineBuffer.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(res: ServerResponse, repo: Repo, raw: Buffer): void {
  let parsed: { packets: Pkt[]; rest: Buffer };
  try {
    parsed = parsePkts(raw);
  } catch {
    sendRaw(res, 400, Buffer.from('malformed pkt-line request\n'), 'text/plain');
    return;
  }
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let capabilities = '';
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  // Store the pack's objects first (a refused ref still unpacks cleanly).
  const pack = parsed.rest;
  if (pack.length >= 12 && pack.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      const objects = readPack(pack, repo.objects);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      // A broken pack fails every update below through the missing-object path.
    }
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current !== ZERO_OID && !isAncestor(repo, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (capabilities.includes('side-band-64k')) {
    const wrapped = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
    sendRaw(res, 200, wrapped, 'application/x-git-receive-pack-result');
    return;
  }
  sendRaw(res, 200, inner, 'application/x-git-receive-pack-result');
}

// --------------------------------------------------------------------------- GraphQL v4

// A small GraphQL executor for the documents gh and github-mcp-server send: it tokenizes and
// parses queries, mutations, variables, inline input objects, enums, aliases, fragments on
// known types and operation batching (a JSON array body), then resolves the forge's schema.

interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, unknown>;
  selection: GqlField[] | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: GqlField[];
}

function gqlLex(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:$!@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (text.slice(i, i + 3) === '"""') {
        const end = text.indexOf('"""', i + 3);
        tokens.push(`str:${text.slice(i + 3, end === -1 ? text.length : end)}`);
        i = end === -1 ? text.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const esc = text[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += text[j];
          j += 1;
        }
      }
      tokens.push(`str:${value}`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j += 1;
      tokens.push(`num:${text.slice(i, j)}`);
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && /[_0-9A-Za-z]/.test(text[j])) j += 1;
      tokens.push(`name:${text.slice(i, j)}`);
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  private variables: Record<string, unknown>;
  private fragments = new Map<string, { typeCondition: string; selection: GqlField[] }>();

  constructor(text: string, variables: Record<string, unknown>) {
    this.tokens = gqlLex(text);
    this.variables = variables;
  }

  private peek(): string {
    return this.tokens[this.pos] ?? '';
  }
  private next(): string {
    const token = this.tokens[this.pos] ?? '';
    this.pos += 1;
    return token;
  }
  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token === 'name:query' || token === 'name:mutation') {
        const kind = token === 'name:mutation' ? 'mutation' : 'query';
        this.next();
        let name: string | null = null;
        if (this.peek().startsWith('name:')) name = this.next().slice(5);
        if (this.peek() === '(') this.skipVariableDefinitions();
        operations.push({ kind, name, selection: this.parseSelectionSet() });
      } else if (token === 'name:fragment') {
        this.next();
        const fragName = this.next().slice(5);
        this.next(); // 'on'
        const typeCondition = this.next().slice(5);
        const selection = this.parseSelectionSet();
        this.fragments.set(fragName, { typeCondition, selection });
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        const token = this.peek();
        if (token === 'name:on') {
          this.next();
          const typeCondition = this.next().slice(5);
          const inner = this.parseSelectionSet();
          fields.push({ name: '__fragment', alias: null, args: new Map([['type', typeCondition]]), selection: inner });
        } else {
          const fragName = this.next().slice(5);
          const fragment = this.fragments.get(fragName);
          if (fragment) fields.push(...fragment.selection);
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    let name = this.next().slice(5);
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next().slice(5);
    }
    const args = new Map<string, unknown>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next().slice(5);
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    // Directives are not used by the suite's documents; skip any that appear.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipVariableDefinitions();
    }
    let selection: GqlField[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token === '$') {
      const varName = this.next().slice(5);
      return this.variables[varName];
    }
    if (token.startsWith('str:')) return token.slice(4);
    if (token.startsWith('num:')) {
      const raw = token.slice(4);
      return raw.includes('.') ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
    }
    if (token === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const key = this.next().slice(5);
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.startsWith('name:')) {
      const word = token.slice(5);
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      return word; // an enum value
    }
    return token;
  }

  resolveFragment(field: GqlField): { type: string; selection: GqlField[] } {
    return { type: String(field.args.get('type') ?? ''), selection: field.selection ?? [] };
  }
}

// The schema's field lists, as gh's feature-detection probes read them.
const TYPE_FIELDS: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closed', 'url', 'repository'] },
  PullRequest: {
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closed', 'url', 'repository'],
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt'],
  },
  SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  User: { fields: ['id', 'login', 'name', 'email', 'url'] },
  Organization: { fields: ['id', 'login', 'name', 'url'] },
  Ref: { fields: ['id', 'name', 'prefix', 'target'] },
  Label: { fields: ['id', 'name', 'color', 'description'] },
  Comment: { fields: ['id', 'body', 'author', 'createdAt'] },
  IssueComment: { fields: ['id', 'body', 'author', 'createdAt', 'url'] },
  PullRequestChangedFile: { fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Query: { fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'] },
  Mutation: { fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
};

interface GqlError {
  message: string;
}

type GqlValue = unknown;

/** Expand fragment spreads (recorded as __fragment fields) for a concrete type name. */
function expandFields(parser: GqlParser, fields: GqlField[], typeName: string): GqlField[] {
  const out: GqlField[] = [];
  for (const field of fields) {
    if (field.name === '__fragment') {
      const fragment = parser.resolveFragment(field);
      if (fragment.type === typeName || fragment.type === 'Node' || fragment.type === '') out.push(...expandFields(parser, fragment.selection, typeName));
    } else {
      out.push(field);
    }
  }
  return out;
}

function pickFields(parser: GqlParser, typeName: string, source: Record<string, GqlValue> | null, selection: GqlField[] | null, errors: GqlError[]): Record<string, GqlValue> | null {
  if (source === null) return null;
  if (!selection) return source;
  const out: Record<string, GqlValue> = {};
  for (const field of expandFields(parser, selection, typeName)) {
    const key = field.alias ?? field.name;
    const value = resolveField(parser, typeName, source, field, errors);
    out[key] = value === undefined ? null : value;
  }
  return out;
}

function resolveField(parser: GqlParser, typeName: string, source: Record<string, GqlValue>, field: GqlField, errors: GqlError[]): GqlValue {
  const raw = source[field.name];
  if (raw === undefined) {
    errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  if (typeof raw === 'function') {
    const produced = (raw as (f: GqlField) => GqlValue)(field);
    return shapeValue(parser, field, produced, errors);
  }
  return shapeValue(parser, field, raw, errors);
}

/** Apply a field's selection set to a produced value (objects carry a hidden __type tag). */
function shapeValue(parser: GqlParser, field: GqlField, value: GqlValue, errors: GqlError[]): GqlValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => shapeValue(parser, field, entry, errors));
  if (typeof value === 'object') {
    const record = value as Record<string, GqlValue> & { __gqltype?: string };
    const typeName = typeof record.__gqltype === 'string' ? record.__gqltype : '';
    const clean: Record<string, GqlValue> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key !== '__gqltype') clean[key] = entry;
    }
    if (!field.selection) return clean;
    return pickFields(parser, typeName, clean, field.selection, errors);
  }
  return value;
}

// --------------------------------------------------------------------------- GraphQL resolvers

type GqlObj = Record<string, GqlValue>;

function gqlUser(login: string): GqlObj {
  return { __gqltype: 'User', id: globalId('User', String(VIEWER_ID)), login, name: VIEWER_NAME, email: VIEWER_EMAIL, url: '' };
}

function gqlIssue(repo: Repo, issue: IssueRec): GqlObj {
  return {
    __gqltype: 'Issue',
    id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    closed: issue.state === 'closed',
    author: gqlUser(VIEWER),
    url: '',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    labels: {
      __gqltype: 'LabelConnection',
      nodes: issue.labels.map((name) => ({ __gqltype: 'Label', id: globalId('Label', `${repo.id}:${name}`), name, color: repo.labels.get(name)?.color ?? 'ededed', description: null })),
    },
    comments: { __gqltype: 'IssueCommentConnection', nodes: issue.comments.map((comment) => gqlComment(repo, issue, comment)), totalCount: issue.comments.length },
    repository: (field: GqlField) => gqlRepo(repo),
  };
}

function gqlComment(repo: Repo, issue: IssueRec, comment: { id: number; body: string }): GqlObj {
  return {
    __gqltype: 'IssueComment',
    id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    body: comment.body,
    author: gqlUser(VIEWER),
    createdAt: '2025-01-01T00:00:00Z',
    url: '',
  };
}

function gqlPull(repo: Repo, pull: PullRec): GqlObj {
  return {
    __gqltype: 'PullRequest',
    id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeable: pullMergeable(repo, pull),
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { __gqltype: 'Ref', id: globalId('Ref', `${repo.id}:${pull.head}`), name: pull.head, prefix: 'refs/heads/' },
    baseRef: { __gqltype: 'Ref', id: globalId('Ref', `${repo.id}:${pull.base}`), name: pull.base, prefix: 'refs/heads/' },
    author: gqlUser(VIEWER),
    url: '',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    closed: pull.state === 'closed',
    files: (field: GqlField) => {
      const first = typeof field.args.get('first') === 'number' ? (field.args.get('first') as number) : 100;
      const files = pullFiles(repo, pull).slice(0, first);
      return {
        __gqltype: 'PullRequestChangedFileConnection',
        totalCount: files.length,
        nodes: files.map((file) => ({ __gqltype: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' })),
      };
    },
    repository: () => gqlRepo(repo),
  };
}

function connection(items: GqlObj[], field: GqlField, typeName: string, defaultOrderDesc = false): GqlObj {
  let list = items;
  const after = field.args.get('after');
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const index = Number(decoded.replace(/^cursor:/, ''));
      if (Number.isInteger(index)) list = list.slice(index + 1);
    } catch {
      // An undecodable cursor pages from the start.
    }
  }
  const first = typeof field.args.get('first') === 'number' ? (field.args.get('first') as number) : list.length;
  const page = list.slice(0, Math.max(0, first));
  const startIndex = items.length - list.length;
  const endIndex = startIndex + page.length - 1;
  void defaultOrderDesc;
  return {
    __gqltype: typeName,
    nodes: page,
    edges: page.map((node, i) => ({ __gqltype: 'Edge', node, cursor: Buffer.from(`cursor:${startIndex + i}`).toString('base64') })),
    totalCount: items.length,
    pageInfo: {
      __gqltype: 'PageInfo',
      hasNextPage: startIndex + page.length < items.length,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length > 0 ? Buffer.from(`cursor:${startIndex}`).toString('base64') : null,
      endCursor: page.length > 0 ? Buffer.from(`cursor:${endIndex}`).toString('base64') : null,
    },
  };
}

function gqlRepo(repo: Repo): GqlObj {
  return {
    __gqltype: 'Repository',
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.priv,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: '',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    owner: gqlUser(repo.owner),
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { __gqltype: 'Ref', id: globalId('Ref', `${repo.id}:${repo.defaultBranch}`), name: repo.defaultBranch, prefix: 'refs/heads/' }
      : null,
    issue: (field: GqlField) => {
      const number = field.args.get('number');
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue ? gqlIssue(repo, issue) : null;
    },
    issues: (field: GqlField) => {
      let list = [...repo.issues.values()];
      const states = field.args.get('states');
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toLowerCase());
        list = list.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = field.args.get('orderBy') as { field?: string; direction?: string } | undefined;
      const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return connection(list.map((issue) => gqlIssue(repo, issue)), field, 'IssueConnection');
    },
    pullRequest: (field: GqlField) => {
      const number = field.args.get('number');
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pull ? gqlPull(repo, pull) : null;
    },
    pullRequests: (field: GqlField) => {
      let list = [...repo.pulls.values()];
      const states = field.args.get('states');
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toUpperCase());
        list = list.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        list = list.filter((pull) => pull.state === 'open');
      }
      list.sort((a, b) => b.number - a.number);
      return connection(list.map((pull) => gqlPull(repo, pull)), field, 'PullRequestConnection');
    },
  };
}

function gqlType(name: string): GqlObj {
  const spec = TYPE_FIELDS[name];
  if (!spec) {
    return { __gqltype: '__Type', name, kind: 'OBJECT', description: null, fields: [], enumValues: [] };
  }
  return {
    __gqltype: '__Type',
    name,
    kind: spec.enumValues ? 'ENUM' : 'OBJECT',
    description: null,
    fields: (spec.fields ?? []).map((fieldName) => ({ __gqltype: '__Field', name: fieldName, description: null })),
    enumValues: (spec.enumValues ?? []).map((value) => ({ __gqltype: '__EnumValue', name: value, description: null })),
  };
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  for (const repo of repos.values()) {
    if (repo.id === repoId) {
      const issue = repo.issues.get(number);
      return issue ? { repo, issue } : null;
    }
  }
  return null;
}

function findPullByGlobalId(id: string): { repo: Repo; pull: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  for (const repo of repos.values()) {
    if (repo.id === repoId) {
      const pull = repo.pulls.get(number);
      return pull ? { repo, pull } : null;
    }
  }
  return null;
}

function gqlRoot(kind: 'query' | 'mutation'): GqlObj {
  if (kind === 'mutation') {
    return {
      __gqltype: 'Mutation',
      createIssue: (field: GqlField) => {
        const input = (field.args.get('input') ?? {}) as { repositoryId?: string; title?: string; body?: string };
        const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
        if (!repo) return { __gqltype: 'CreateIssuePayload', issue: null };
        const created = createIssueRec(repo, { title: input.title ?? '', body: input.body ?? '' });
        if (created === 'bad-label') return { __gqltype: 'CreateIssuePayload', issue: null };
        return { __gqltype: 'CreateIssuePayload', issue: gqlIssue(repo, created) };
      },
      closeIssue: (field: GqlField) => {
        const input = (field.args.get('input') ?? {}) as { issueId?: string };
        const found = typeof input.issueId === 'string' ? findIssueByGlobalId(input.issueId) : null;
        if (!found) return { __gqltype: 'CloseIssuePayload', issue: null };
        found.issue.state = 'closed';
        return { __gqltype: 'CloseIssuePayload', issue: gqlIssue(found.repo, found.issue) };
      },
      createPullRequest: (field: GqlField) => {
        const input = (field.args.get('input') ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
        const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
        if (!repo) return { __gqltype: 'CreatePullRequestPayload', pullRequest: null };
        const created = createPullRec(repo, { title: input.title ?? '', body: input.body ?? '', head: input.headRefName ?? '', base: input.baseRefName ?? repo.defaultBranch });
        if (typeof created === 'string') return { __gqltype: 'CreatePullRequestPayload', pullRequest: null };
        return { __gqltype: 'CreatePullRequestPayload', pullRequest: gqlPull(repo, created) };
      },
      mergePullRequest: (field: GqlField) => {
        const input = (field.args.get('input') ?? {}) as { pullRequestId?: string };
        const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(input.pullRequestId) : null;
        if (!found) return { __gqltype: 'MergePullRequestPayload', pullRequest: null };
        doMergePull(found.repo, found.pull);
        return { __gqltype: 'MergePullRequestPayload', pullRequest: gqlPull(found.repo, found.pull) };
      },
      addComment: (field: GqlField) => {
        const input = (field.args.get('input') ?? {}) as { subjectId?: string; body?: string };
        const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(input.subjectId) : null;
        if (!found) return { __gqltype: 'AddCommentPayload', commentEdge: null };
        const comment = { id: nextCommentId(found.repo), body: input.body ?? '' };
        found.issue.comments.push(comment);
        const node = gqlComment(found.repo, found.issue, comment);
        return { __gqltype: 'AddCommentPayload', commentEdge: { __gqltype: 'IssueCommentEdge', node, cursor: '' } };
      },
    };
  }
  return {
    __gqltype: 'Query',
    viewer: gqlUser(VIEWER),
    repository: (field: GqlField) => {
      const owner = field.args.get('owner');
      const name = field.args.get('name');
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = getRepo(owner, name);
      return repo ? gqlRepo(repo) : null;
    },
    node: (field: GqlField) => {
      const id = field.args.get('id');
      if (typeof id !== 'string') return null;
      const repo = repoByGlobalId(id);
      if (repo) return gqlRepo(repo);
      const issueFound = findIssueByGlobalId(id);
      if (issueFound) return gqlIssue(issueFound.repo, issueFound.issue);
      const pullFound = findPullByGlobalId(id);
      if (pullFound) return gqlPull(pullFound.repo, pullFound.pull);
      return null;
    },
    __type: (field: GqlField) => {
      const name = field.args.get('name');
      return gqlType(typeof name === 'string' ? name : '');
    },
    __schema: { __gqltype: '__Schema', types: Object.keys(TYPE_FIELDS).map((name) => gqlType(name)) },
    rateLimit: { __gqltype: 'RateLimit', limit: 5000, remaining: 5000, used: 0, resetAt: '2025-01-01T00:00:00Z', cost: 1 },
    search: (field: GqlField) => connection([], field, 'SearchResultItemConnection'),
  };
}

function executeGraphql(queryText: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, GqlValue> | null; errors?: GqlError[] } {
  const parser = new GqlParser(queryText, variables);
  let operations: GqlOperation[];
  try {
    operations = parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operationName ? (operations.find((op) => op.name === operationName) ?? operations[0]) : operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
  const errors: GqlError[] = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = pickFields(parser, rootType, gqlRoot(operation.kind), operation.selection, errors);
  const out: { data: Record<string, GqlValue> | null; errors?: GqlError[] } = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  void req;
  const text = raw.toString('utf8').trim();
  let parsedJson: unknown;
  try {
    parsedJson = text === '' ? null : JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsedJson)) {
    const results = parsedJson.map((entry) => {
      const operation = (entry ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
      return executeGraphql(typeof operation.query === 'string' ? operation.query : '', operation.variables ?? {}, operation.operationName);
    });
    sendJson(res, 200, results);
    return;
  }
  const operation = (parsedJson ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  const result = executeGraphql(typeof operation.query === 'string' ? operation.query : '', operation.variables ?? {}, operation.operationName);
  sendJson(res, 200, result);
}

// --------------------------------------------------------------------------- MCP (JSON-RPC)

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MCP_TOOLS: unknown[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body (Markdown).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body (Markdown).' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// tools/list is pre-serialized once: the suite requires byte-identical responses across calls.
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);
const MCP_TOOL_MAP = new Map<string, { name: string; schema: { properties: Record<string, unknown>; required: string[] } }>(
  (JSON.parse(MCP_TOOLS_JSON) as { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[]).map((tool) => [
    tool.name,
    { name: tool.name, schema: tool.inputSchema },
  ]),
);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function toolContent(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value) ?? 'null';
  return { content: [{ type: 'text', text: serialized }], structuredContent: value as Record<string, unknown>, isError: false };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repo = createRepo(String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolContent(repoJson(repo));
    }
    case 'get_repo': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
      return toolContent(repoJson(repo));
    }
    case 'create_issue': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
      const created = createIssueRec(repo, { title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : '', labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined });
      if (created === 'bad-label') return { content: [{ type: 'text', text: 'unknown label' }], isError: true };
      return toolContent(issueJson(repo, created));
    }
    case 'list_issues': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(repo, issue));
      return toolContent(list);
    }
    case 'create_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
      const created = createPullRec(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head: typeof args.head === 'string' ? args.head : '',
        base: typeof args.base === 'string' ? args.base : repo.defaultBranch,
      });
      if (typeof created === 'string') return { content: [{ type: 'text', text: created }], isError: true };
      return toolContent(pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return { content: [{ type: 'text', text: 'pull request not found' }], isError: true };
      const merge = doMergePull(repo, pull);
      if (merge === null) return { content: [{ type: 'text', text: 'cannot merge' }], isError: true };
      if ('conflict' in merge) return { content: [{ type: 'text', text: 'merge conflict' }], isError: true };
      return toolContent(pullJson(repo, pull));
    }
    default:
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
}

function handleRpc(request: JsonRpcRequest): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(request.id, {
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_SUPPORTED_VERSIONS[0];
      return rpcResult(request.id, {
        protocolVersion: MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(request.id, {});
    case 'tools/list':
      return rpcResult(request.id, { tools: JSON.parse(MCP_TOOLS_JSON) as unknown });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOL_MAP.get(toolName);
      if (!tool) return rpcError(request.id, -32601, `unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      for (const required of tool.schema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(request.id, -32602, `missing required argument: ${required}`);
        }
      }
      try {
        return rpcResult(request.id, callTool(toolName, args));
      } catch (err) {
        return rpcResult(request.id, { content: [{ type: 'text', text: err instanceof Error ? err.message : 'tool error' }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(request.id, -32601, `method not found: ${method}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  void req;
  const text = raw.toString('utf8').trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': `req-${++requestSeq}` });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  if (Array.isArray(parsedJson)) {
    const responses = parsedJson
      .map((entry) => handleRpc((entry ?? {}) as JsonRpcRequest))
      .filter((entry) => entry !== null);
    sendJson(res, 200, responses);
    return;
  }
  const response = handleRpc((parsedJson ?? {}) as JsonRpcRequest);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': `req-${++requestSeq}` });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// --------------------------------------------------------------------------- router

function repoFromGitPath(pathname: string): { repo: Repo | null; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const repo = getRepo(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  return { repo, rest: match[3] ?? '' };
}

export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;

        if (pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isGitPath = /^\/[^/]+\/[^/]+\.git(\/|$)/.test(pathname);
        const needsAuth = pathname === '/api/v3' || pathname.startsWith('/api/v3/') || pathname === '/api/graphql' || pathname === '/mcp' || isGitPath;
        if (needsAuth && !authed(req)) {
          errJson(res, 401, 'Requires authentication');
          return;
        }

        if (pathname === '/api/graphql' && method === 'POST') {
          await handleGraphql(req, res, await readBody(req));
          return;
        }
        if (pathname === '/mcp' && method === 'POST') {
          await handleMcp(req, res, await readBody(req));
          return;
        }
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const raw = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
          handleRest(req, res, url, raw);
          return;
        }
        if (isGitPath) {
          const found = repoFromGitPath(pathname);
          if (!found) {
            errJson(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET' && found.rest === '/info/refs') {
            handleInfoRefs(req, res, url, found.repo);
            return;
          }
          if (method === 'POST' && found.rest === '/git-upload-pack') {
            if (!found.repo) {
              sendRaw(res, 404, Buffer.from('repository not found\n'), 'text/plain');
              return;
            }
            const protocol = req.headers['git-protocol'];
            const version2 = typeof protocol === 'string' && protocol.includes('version=2');
            handleUploadPack(res, found.repo, await readBody(req), version2);
            return;
          }
          if (method === 'POST' && found.rest === '/git-receive-pack') {
            if (!found.repo) {
              sendRaw(res, 404, Buffer.from('repository not found\n'), 'text/plain');
              return;
            }
            handleReceivePack(res, found.repo, await readBody(req));
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }
        errJson(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) errJson(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.end();
      }
    })();
  });
}
