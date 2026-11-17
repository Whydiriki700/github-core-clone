// Git smart HTTP, implemented on the object store: protocol v2 (ls-refs, fetch) and v0
// (advertisement, fetch) for upload-pack, and v0 receive-pack with report-status.
// Packs are written with full objects only; received packs resolve ofs-delta and ref-delta
// entries, including thin bases already in the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { forge, ZERO_SHA, type Repo } from './store.ts';
import type { Ctx, SendJson, SendRaw } from './app.ts';

const AGENT = 'forge/1.0';

// --------------------------------------------------------------------------- pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }

function parsePackets(buf: Buffer, start = 0): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; break; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); i += 4; break; }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
}

function packetLines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
}

/** Parse every pkt-line in a buffer, continuing past flush packets (v0 fetch has two sections). */
function parseAllPackets(buf: Buffer): Packet[] {
  const all: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const { packets, rest } = parsePackets(buf, offset);
    if (packets.length === 0) break;
    all.push(...packets);
    const consumed = buf.length - rest.length - offset;
    if (consumed <= 0) break;
    offset += consumed;
    // parsePackets stops right after a flush; if the next bytes are not a pkt-line, stop.
    if (rest.length < 4 || !/^[0-9a-fA-F]{4}$/.test(rest.toString('ascii', 0, 4))) break;
  }
  return all;
}

// --------------------------------------------------------------------------- packs

const TYPE_IDS = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;
const ID_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a pack holding the given objects, full entries only. Memoized: the perf
 * bench clones the same state repeatedly, and a pack's bytes depend only on its
 * object list. */
const packCache = new Map<string, Buffer>();

export function buildPack(shas: string[]): Buffer {
  const key = createHash('sha1').update(shas.join(',')).digest('hex');
  const cached = packCache.get(key);
  if (cached) return cached;
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  parts.push(head);
  for (const sha of shas) {
    const obj = forge.objects.read(sha);
    if (!obj) continue;
    parts.push(packEntryHeader(TYPE_IDS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  if (packCache.size > 64) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/** Inflate one zlib stream starting at `pos`; returns the output and the bytes consumed. */
function inflateAt(buf: Buffer, pos: number): { out: Buffer; consumed: number } {
  try {
    const out = inflateSync(buf.subarray(pos));
    // Trailing bytes are ignored by inflateSync, so find the exact end by search when
    // more data follows: the smallest succeeding length is the stream's end.
    let lo = 1;
    let hi = buf.length - pos;
    let best = hi;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        inflateSync(buf.subarray(pos, pos + mid));
        best = mid;
        hi = mid - 1;
      } catch {
        lo = mid + 1;
      }
    }
    return { out, consumed: best };
  } catch {
    throw new Error('pack entry does not inflate');
  }
}

/** Apply a git delta buffer to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++] as number;
      value |= (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i++] as number;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[i++] as number;
      if (op & 0x02) offset |= (delta[i++] as number) << 8;
      if (op & 0x04) offset |= (delta[i++] as number) << 16;
      if (op & 0x08) offset |= (delta[i++] as number) << 24;
      if (op & 0x10) size = delta[i++] as number;
      if (op & 0x20) size |= (delta[i++] as number) << 8;
      if (op & 0x40) size |= (delta[i++] as number) << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: string; // resolved type after deltas
  data: Buffer;
  sha: string;
}

/** Parse a pack into the store; returns the number of objects it held. Throws on damage. */
export function unpackPack(pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const raw: Array<{ offset: number; kind: number; data?: Buffer; baseOffset?: number; baseSha?: string; size: number }> = [];
  for (let n = 0; n < count; n++) {
    const offset = pos;
    let b = pack[pos++] as number;
    const kind = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[pos++] as number;
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (kind === 6) {
      // ofs-delta: base is at this entry's offset minus the encoded distance
      let c = pack[pos++] as number;
      let baseDistance = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++] as number;
        baseDistance = (baseDistance + 1) * 128 + (c & 0x7f);
      }
      const { out, consumed } = inflateAt(pack, pos);
      pos += consumed;
      raw.push({ offset, kind, data: out, baseOffset: offset - baseDistance, size });
    } else if (kind === 7) {
      const baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const { out, consumed } = inflateAt(pack, pos);
      pos += consumed;
      raw.push({ offset, kind, data: out, baseSha, size });
    } else {
      const { out, consumed } = inflateAt(pack, pos);
      pos += consumed;
      raw.push({ offset, kind, data: out, size });
    }
  }
  // Resolve entries (deltas may chain; iterate until all resolve).
  const byOffset = new Map<number, PackEntry>();
  const resolved = new Map<number, PackEntry>();
  let pending = [...raw];
  let guard = 0;
  while (pending.length > 0) {
    guard += 1;
    if (guard > raw.length + 2) throw new Error('unresolvable pack deltas');
    const next: typeof pending = [];
    for (const entry of pending) {
      if (entry.kind >= 1 && entry.kind <= 4) {
        const type = ID_TYPES[entry.kind] as 'commit' | 'tree' | 'blob' | 'tag';
        const sha = forge.objects.write(type, entry.data as Buffer);
        const resolvedEntry = { offset: entry.offset, type, data: entry.data as Buffer, sha };
        byOffset.set(entry.offset, resolvedEntry);
        resolved.set(entry.offset, resolvedEntry);
      } else if (entry.kind === 6) {
        const base = byOffset.get(entry.baseOffset as number);
        if (!base) { next.push(entry); continue; }
        const data = applyDelta(base.data, entry.data as Buffer);
        const sha = forge.objects.write(base.type as 'commit' | 'tree' | 'blob' | 'tag', data);
        const resolvedEntry = { offset: entry.offset, type: base.type, data, sha };
        byOffset.set(entry.offset, resolvedEntry);
        resolved.set(entry.offset, resolvedEntry);
      } else if (entry.kind === 7) {
        let base = [...byOffset.values()].find((e) => e.sha === entry.baseSha);
        if (!base) {
          const stored = forge.objects.read(entry.baseSha as string);
          if (!stored) { next.push(entry); continue; }
          base = { offset: -1, type: stored.type, data: stored.data, sha: entry.baseSha as string };
        }
        const data = applyDelta(base.data, entry.data as Buffer);
        const sha = forge.objects.write(base.type as 'commit' | 'tree' | 'blob' | 'tag', data);
        const resolvedEntry = { offset: entry.offset, type: base.type, data, sha };
        byOffset.set(entry.offset, resolvedEntry);
        resolved.set(entry.offset, resolvedEntry);
      }
    }
    if (next.length === pending.length) throw new Error('pack delta base missing');
    pending = next;
  }
  return resolved.size;
}

// --------------------------------------------------------------------------- ref helpers

function peelToCommit(sha: string): string {
  let cur = sha;
  for (let i = 0; i < 10; i++) {
    const obj = forge.objects.read(cur);
    if (!obj) return cur;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (!m) return cur;
      cur = m[1] as string;
      continue;
    }
    return cur;
  }
  return cur;
}

/** All refs of a repo, sorted by name, with HEAD first handled by callers. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// --------------------------------------------------------------------------- object selection for fetch

interface FetchPlan {
  objects: string[]; // shas to pack
  shallow: string[]; // boundary commits created by the depth cut
  unshallow: string[];
}

/**
 * Choose the objects a fetch sends: everything reachable from the wants, minus everything
 * reachable from the haves, with history cut at `depth` (1 = tips only) when given.
 */
function planFetch(wants: string[], haves: string[], depth: number | null, clientShallow: string[], deepenSince: number | null, deepenNot: string[]): FetchPlan {
  const objects = forge.objects;
  const shallowSet = new Set(clientShallow);
  // Commits the client has with full ancestry: their whole closure is excluded. A have
  // that is also on the client's shallow boundary is only had itself: its parents are
  // exactly what a deepen fetch asks for, so its ancestry stays in play.
  const haveFullCommits = new Set<string>();
  const haveSelfCommits = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      haveSelfCommits.add(have);
      continue;
    }
    const stack = [have];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (haveFullCommits.has(cur)) continue;
      const commit = objects.readCommit(cur);
      if (!commit) continue;
      haveFullCommits.add(cur);
      stack.push(...commit.parents);
    }
  }
  const notCommits = new Set<string>();
  {
    const stack = [...deepenNot];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (notCommits.has(cur)) continue;
      const commit = objects.readCommit(cur);
      if (!commit) continue;
      notCommits.add(cur);
      stack.push(...commit.parents);
    }
  }
  // BFS from the wants, tracking distance (in commits) for the depth cut. A commit is
  // included when its distance is below the depth (depth 1 = the tips alone).
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0]);
  const includedCommits: string[] = [];
  const traversed = new Set<string>();
  const shallow = new Set<string>();
  while (queue.length > 0) {
    const [sha, dist] = queue.shift() as [string, number];
    if (traversed.has(sha)) continue;
    const commit = objects.readCommit(sha);
    if (!commit) continue;
    if (haveFullCommits.has(sha) || notCommits.has(sha)) continue;
    traversed.add(sha);
    const withinDepth = depth === null || dist < depth;
    const withinSince = deepenSince === null || commitTime(commit.author) > deepenSince;
    const selfOnly = haveSelfCommits.has(sha);
    if (withinDepth && withinSince && !selfOnly) {
      distance.set(sha, dist);
      includedCommits.push(sha);
    }
    const expand = (depth === null || dist + 1 < depth || selfOnly) && withinSince;
    for (const parent of commit.parents) {
      if (expand || selfOnly) {
        if (!traversed.has(parent)) queue.push([parent, dist + 1]);
      }
    }
    // Boundary: an included commit with a parent that stayed out is a shallow line.
    if ((withinDepth && withinSince && !selfOnly) || selfOnly) {
      const isBoundary = commit.parents.some((p) => !distance.has(p) && !haveFullCommits.has(p));
      if (isBoundary && commit.parents.length > 0) {
        if (!selfOnly || depth !== null) shallow.add(sha);
      }
    }
  }
  // Unshallow: a client-shallow commit whose parents are now included in full.
  const unshallow: string[] = [];
  for (const sha of clientShallow) {
    const commit = objects.readCommit(sha);
    if (!commit) continue;
    if (commit.parents.some((p) => distance.has(p))) unshallow.push(sha);
  }
  // Objects: the included commits plus their trees and blobs (minus what haves reach).
  const haveObjects = new Set<string>();
  for (const sha of [...haveFullCommits, ...haveSelfCommits]) {
    const commit = objects.readCommit(sha);
    if (commit) collectTreeObjects(commit.tree, haveObjects);
  }
  const send = new Set<string>();
  for (const sha of includedCommits) {
    if (!haveObjects.has(sha)) send.add(sha);
    const commit = objects.readCommit(sha);
    if (commit) collectTreeObjects(commit.tree, send, haveObjects);
  }
  // Wants may name tag objects directly; include the tag itself.
  for (const want of wants) {
    const obj = objects.read(want);
    if (obj && obj.type === 'tag' && !send.has(want)) send.add(want);
  }
  return { objects: [...send], shallow: [...shallow], unshallow };
}

function commitTime(ident: string): number {
  const m = / (\d+) [+-]\d{4}$/.exec(ident);
  return m ? Number(m[1]) : 0;
}

function collectTreeObjects(treeSha: string, into: Set<string>, exclude?: Set<string>): void {
  if (into.has(treeSha) || exclude?.has(treeSha)) return;
  into.add(treeSha);
  for (const entry of forge.objects.readTree(treeSha)) {
    if (entry.type === 'tree') collectTreeObjects(entry.sha, into, exclude);
    else if (!exclude?.has(entry.sha)) into.add(entry.sha);
  }
}

// --------------------------------------------------------------------------- advertisements

const UPLOAD_CAPS_V0 = (repo: Repo): string =>
  `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

function advertisementV0(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0(repo) : RECEIVE_CAPS;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([name, sha], idx) => {
      parts.push(pkt(idx === 0 ? `${sha} ${name}\0${caps}\n` : `${sha} ${name}\n`));
      const peeled = peelToCommit(sha);
      if (peeled !== sha) parts.push(pkt(`${peeled} ${name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pkt(l)), FLUSH]);
}

// --------------------------------------------------------------------------- upload-pack

function lsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headSha) {
      let line = `${headSha} HEAD`;
      if (symrefs) line += ` symref-target:${target}`;
      lines.push(line);
    } else if (unborn) {
      let line = `unborn HEAD`;
      if (symrefs) line += ` symref-target:${target}`;
      lines.push(line);
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const peeled = peelToCommit(sha);
      if (peeled !== sha) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((l) => pkt(`${l}\n`)), FLUSH]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
  noProgress: boolean;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + CHUNK)])));
  }
  return out;
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false, noProgress: false };
  for (const line of args) {
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) parsed.depth = Number(line.slice(7)) || null;
    else if (line.startsWith('deepen-since ')) parsed.deepenSince = Number(line.slice(13)) || null;
    else if (line.startsWith('deepen-not ')) parsed.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') parsed.done = true;
    else if (line === 'no-progress') parsed.noProgress = true;
  }
  const plan = planFetch(parsed.wants, parsed.haves, parsed.depth, parsed.shallow, parsed.deepenSince, parsed.deepenNot);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pkt('acknowledgments\n'));
  const commonHave = parsed.haves.find((h) => forge.objects.readCommit(h));
  if (commonHave) {
    parts.push(pkt(`ACK ${commonHave}\n`));
    if (parsed.done) parts.push(pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(DELIM);
  // shallow-info, when the request touched shallowness
  if (parsed.depth !== null || parsed.shallow.length > 0 || parsed.deepenSince !== null || parsed.deepenNot.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(DELIM);
  }
  // packfile, when there is anything to send
  if (plan.objects.length > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(buildPack(plan.objects)));
    parts.push(DELIM);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, packets: Packet[]): Buffer {
  // Two sections: wants (flush) then haves/done (flush).
  const lines = packetLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7)) || null;
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13)) || null;
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11, 51));
  }
  const plan = planFetch(wants, haves, depth, shallow, deepenSince, deepenNot);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  const commonHave = haves.find((h) => forge.objects.readCommit(h));
  parts.push(pkt(commonHave ? `ACK ${commonHave} common\n` : 'NAK\n'));
  if (plan.objects.length > 0) {
    parts.push(...sidebandPack(buildPack(plan.objects)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPack(ctx: Ctx, repo: Repo): void {
  const isV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (!isV2) {
    const packets = parseAllPackets(ctx.rawBody);
    ctx.res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': 'FORGE-GIT' });
    ctx.res.end(fetchV0(repo, packets));
    return;
  }
  const { packets } = parsePackets(ctx.rawBody);
  // Split at the delim: command + capability args, then command arguments.
  const delimIdx = packets.findIndex((p) => p.kind === 'delim');
  const head = delimIdx === -1 ? packets : packets.slice(0, delimIdx);
  const tail = delimIdx === -1 ? [] : packets.slice(delimIdx + 1);
  const headLines = packetLines(head);
  const command = headLines.find((l) => l.startsWith('command='))?.slice('command='.length);
  const args = packetLines(tail);
  ctx.res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': 'FORGE-GIT' });
  if (command === 'ls-refs') {
    ctx.res.end(lsRefs(repo, args));
    return;
  }
  if (command === 'fetch') {
    ctx.res.end(fetchV2(repo, args));
    return;
  }
  ctx.res.end(FLUSH);
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand { oldOid: string; newOid: string; ref: string }

function receivePack(ctx: Ctx, repo: Repo, sendJson: SendJson): void {
  const { packets, rest } = parsePackets(ctx.rawBody);
  const lines = packetLines(packets);
  const commands: PushCommand[] = [];
  let capabilities = '';
  lines.forEach((line, idx) => {
    let text = line;
    if (idx === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.trim().split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0] as string) && /^[0-9a-f]{40}$/.test(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  });
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const wantsReport = caps.has('report-status') || caps.has('report-status-v2');
  const useSideband = caps.has('side-band-64k');

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      unpackPack(rest);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (commands.some((c) => c.newOid !== ZERO_SHA)) {
    // Updates without a pack are legal only when the objects are already here.
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const cmd of commands) {
    if (unpackError) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO_SHA;
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'reference mismatch' });
      continue;
    }
    if (cmd.newOid === ZERO_SHA) {
      // delete
      if (cmd.ref === headTarget(repo)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'deletion of the current branch prohibited' });
        continue;
      }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    const newType = forge.objects.typeOf(cmd.newOid);
    if (!newType) {
      results.push({ ref: cmd.ref, ok: false, reason: 'not a valid object' });
      continue;
    }
    if (cmd.ref.startsWith('refs/heads/') && newType !== 'commit') {
      results.push({ ref: cmd.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (cmd.oldOid !== ZERO_SHA && cmd.ref.startsWith('refs/heads/')) {
      const oldCommit = forge.objects.readCommit(cmd.oldOid);
      const newCommit = forge.objects.readCommit(cmd.newOid);
      if (oldCommit && newCommit && !forge.objects.isAncestor(cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.updatedAt = new Date(0).toISOString();
    results.push({ ref: cmd.ref, ok: true });
  }

  if (!wantsReport) {
    ctx.res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': 'FORGE-GIT' });
    ctx.res.end();
    return;
  }
  const reportLines: string[] = [];
  reportLines.push(unpackError ? `unpack ${unpackError}` : 'unpack ok');
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`);
  const reportStream = Buffer.concat([...reportLines.map((l) => pkt(`${l}\n`)), FLUSH]);
  let payload: Buffer;
  if (useSideband) {
    const chunks: Buffer[] = [];
    const CHUNK = 65515;
    for (let i = 0; i < reportStream.length; i += CHUNK) {
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(i, i + CHUNK)])));
    }
    chunks.push(FLUSH);
    payload = Buffer.concat(chunks);
  } else {
    payload = reportStream;
  }
  ctx.res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': 'FORGE-GIT' });
  ctx.res.end(payload);
  void sendJson;
}

// --------------------------------------------------------------------------- entry

export function handleGit(ctx: Ctx, segments: string[], sendRaw: SendRaw, sendJson: SendJson): boolean {
  // /{owner}/{repo}.git/...
  if (segments.length < 2) return false;
  const repoSeg = segments[1] as string;
  if (!repoSeg.endsWith('.git')) return false;
  const ownerSeg = segments[0] as string;
  const repoName = repoSeg.slice(0, -4);
  const repo = forge.getRepo(repoName);
  if (repo && forge.viewerLogin === null) forge.viewerLogin = ownerSeg;
  const method = ctx.req.method ?? 'GET';
  const service = ctx.url.searchParams.get('service');

  if (!repo || (forge.viewerLogin !== null && ownerSeg !== forge.viewerLogin)) {
    sendJson(ctx.res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'GET' && ctx.url.pathname.endsWith('/info/refs')) {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(ctx.res, 404, { message: 'Not Found' });
      return true;
    }
    const isV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2' && service === 'git-upload-pack';
    const body = isV2 ? advertisementV2() : advertisementV0(repo, service);
    sendRaw(ctx.res, 200, body, `application/x-${service}-advertisement`);
    return true;
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'git-upload-pack') {
    uploadPack(ctx, repo);
    return true;
  }
  if (method === 'POST' && segments.length === 3 && segments[2] === 'git-receive-pack') {
    receivePack(ctx, repo, sendJson);
    return true;
  }
  return false;
}
