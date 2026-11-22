// PDF input/output plumbing shared by every tool.
//
// The server was designed around local file paths (bytes never transit the
// model context). That is still the right default beside a local agent — but
// every hosted MCP runtime (Smithery, Glama hosted, cloud IDE gateways) runs
// this process on a machine where the agent's paths do not exist, so inspect/
// fill/merge were broken by construction there (TASK-102). A "source" string is
// now one of three things, told apart by prefix, with no schema change:
//
//   /abs/path/file.pdf                        read from disk (local default, inside PDFOPS_ROOT)
//   https://host/file.pdf                     fetched (hosted default)
//   data:application/pdf;base64,JVBERi0x...   decoded inline
//
// Outputs mirror it: with `output_path` the PDF is written to disk; without it
// the PDF comes back as an embedded application/pdf resource the client saves.

import { lookup as dnsLookup } from 'node:dns/promises';
import { constants as fsc } from 'node:fs';
import { type FileHandle, lstat, open, readlink, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Upper bound on a fetched PDF: the API's per-PDF cap, so oversize fails here with a clear message. */
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;

export type SourceKind = 'path' | 'url' | 'data';

export const classifySource = (s: string): SourceKind => {
  if (/^data:/i.test(s)) return 'data';
  if (/^https?:\/\//i.test(s)) return 'url';
  return 'path';
};

/** Short, safe label for tool output — never echoes inline payloads. */
export const describeSource = (s: string): string => {
  switch (classifySource(s)) {
    case 'data':
      return 'inline data URI';
    case 'url':
      try {
        return new URL(s).host + new URL(s).pathname;
      } catch {
        return 'url';
      }
    default:
      return s;
  }
};

const decodeDataUri = (s: string): Uint8Array => {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(s);
  if (!m) throw new Error('Malformed data: URI');
  const params = m[2].toLowerCase();
  if (!params.includes(';base64')) {
    throw new Error('data: URI must be base64-encoded (data:application/pdf;base64,...)');
  }
  // Refuse before decoding: base64 is 4 chars per 3 bytes.
  if ((m[3].length * 3) / 4 > MAX_INPUT_BYTES + 3) {
    throw new Error(`data: URI is over ${MAX_INPUT_BYTES} bytes decoded; limit is ${MAX_INPUT_BYTES}`);
  }
  const bytes = Buffer.from(m[3].replace(/\s+/g, ''), 'base64');
  if (bytes.byteLength === 0) throw new Error('data: URI decoded to zero bytes');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

// ---- Containment (TASK-409) ------------------------------------------------
// The agent driving this server may be steered by text it read (a web page, an
// email, a PDF), so every path and URL a tool receives is untrusted. Reads and
// writes are confined to PDFOPS_ROOT (one or more directories, joined with the
// platform path delimiter), defaulting to the working directory, or the home
// directory when the client launched us from "/". Only .pdf files are read or
// written, reads must carry a %PDF header, symlinks are resolved before the
// root check, and an existing symlink is never written through.

const MAX_REDIRECTS = 5;

export const allowedRoots = (): string[] => {
  const env = process.env.PDFOPS_ROOT?.trim();
  if (env) return env.split(delimiter).filter(Boolean).map((r) => resolve(r));
  const cwd = process.cwd();
  return [cwd === resolve('/') ? homedir() : cwd];
};

const within = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};

/** The real paths of every root that contains `real`, in configured order. */
const containingRoots = async (real: string): Promise<string[]> => {
  const out: string[] = [];
  for (const r of allowedRoots()) {
    const rootReal = await realpath(r).catch(() => r);
    if (within(rootReal, real)) out.push(rootReal);
  }
  return out;
};

/** Returns the real path of the first root that contains `real`. Every failure is the same generic message. */
const assertInRoot = async (real: string, original: string): Promise<string> => {
  const roots = await containingRoots(real);
  if (roots.length === 0) throw notFound(original);
  return roots[0];
};

// A caller-supplied path is checked lexically BEFORE any filesystem call: realpath on a path
// outside the root would tell an injected agent whether it exists, and on Windows a UNC path
// would open a network connection. Only the configured roots themselves are resolved here.
const lexicallyInRoot = async (abs: string): Promise<boolean> => {
  for (const r of allowedRoots()) {
    if (within(r, abs)) return true;
    if (within(await realpath(r).catch(() => r), abs)) return true;
  }
  return false;
};

const notFound = (p: string): Error =>
  new Error(`${p} was not found or is outside the allowed directories (${allowedRoots().join(', ')}). Set PDFOPS_ROOT to the folder(s) holding your files.`);

/** open() where any failure (missing, no permission, a link swapped in) is the one generic message. */
const openOr404 = async (path: string, flags: number, p: string, mode?: number): Promise<FileHandle> => {
  try {
    return await open(path, flags, mode);
  } catch {
    throw notFound(p);
  }
};

const assertLexical = async (p: string, abs: string): Promise<void> => {
  if (!(await lexicallyInRoot(abs))) throw notFound(p);
};

/** realpath with one generic failure message, whatever the reason (missing, no permission, loop). */
const realpathOr404 = (p: string, abs: string): Promise<string> =>
  realpath(abs).catch(() => {
    throw notFound(p);
  });

/** Refuse over the cap from the open handle's size, before reading a byte. */
const readCappedFile = async (fh: FileHandle, p: string, cap: number): Promise<Buffer> => {
  const { size } = await fh.stat();
  if (size > cap) throw new Error(`${p} is ${size} bytes; limit is ${cap}`);
  return fh.readFile();
};

const assertPdfExt = (p: string): void => {
  if (extname(p).toLowerCase() !== '.pdf') throw new Error(`Only .pdf files are read or written: ${p}`);
};

/** A PDF header may be preceded by up to 1 KB of junk (ISO 32000 tolerance). */
export const looksLikePdf = (b: Uint8Array): boolean =>
  Buffer.from(b.subarray(0, 1024)).includes('%PDF-');

/** Local inputs must also end like a PDF, so a text file that merely mentions "%PDF-" is not uploaded. */
const looksLikeWholePdf = (b: Uint8Array): boolean =>
  looksLikePdf(b) && Buffer.from(b.subarray(Math.max(0, b.byteLength - 1024))).includes('%%EOF');

/** O_NOFOLLOW closes the swap-to-symlink race between the check and the open (0 on Windows). */
const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
/** O_NONBLOCK: a FIFO named x.pdf fails the isFile check instead of hanging open() forever. */
const NONBLOCK = fsc.O_NONBLOCK ?? 0;

/**
 * A hard link shares the inode, so neither realpath nor the root check can see that the
 * file also lives outside the root (TASK-418). Checked on the open handle, so the file
 * read or written is the one checked.
 */
const assertSingleLinkFile = async (fh: FileHandle, path: string, p: string): Promise<void> => {
  const st = await fh.stat();
  if (!st.isFile()) throw new Error(`Not a regular file: ${p}`);
  if (st.nlink > 1) {
    throw new Error(`Refusing: ${p} has ${st.nlink} hard links, so its path does not prove it is inside the allowed directories`);
  }
  // The checked path must still name the opened file: catches an alias unlinked after
  // open (nlink drops back to 1) and, on Windows where O_NOFOLLOW is 0, a final
  // component swapped for a symlink between the check and the open.
  const changed = new Error(`Refusing: ${p} changed while it was being opened`);
  // Linux names the opened file itself, which settles a parent directory swapped for a
  // link during the open (TASK-423) with no window left. Linux only: on Windows the same
  // string is a plain path any local process could plant. Without /proc (a bare sandbox)
  // refuse rather than drop to the weaker check below.
  if (process.platform === 'linux') {
    const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => undefined);
    if (opened === undefined) throw new Error(`Refusing: cannot confirm where ${p} was opened (/proc/self/fd is unreadable)`);
    if (opened !== path) throw changed;
  }
  // Elsewhere (Windows junctions, macOS) the path is re-resolved around the identity check:
  // the parent must still be the directory checked before the open, and the path must
  // still name the opened inode. Each check needs the swap in a different state.
  const parentIntact = async (): Promise<boolean> =>
    (await realpath(dirname(path)).catch(() => undefined)) === dirname(path);
  if (!(await parentIntact())) throw changed;
  const now = await lstat(path).catch(() => undefined);
  if (!now || now.dev !== st.dev || now.ino !== st.ino) throw changed;
  if (!(await parentIntact())) throw changed;
};

const readLocalPdf = async (p: string): Promise<Uint8Array> => {
  assertPdfExt(p);
  await assertLexical(p, resolve(p));
  const real = await realpathOr404(p, resolve(p));
  await assertInRoot(real, p);
  const fh = await openOr404(real, fsc.O_RDONLY | NOFOLLOW | NONBLOCK, p);
  let buf: Buffer;
  try {
    await assertSingleLinkFile(fh, real, p);
    buf = await readCappedFile(fh, p, MAX_INPUT_BYTES);
  } finally {
    await fh.close();
  }
  if (!looksLikeWholePdf(buf)) throw new Error(`${p} is not a PDF (no %PDF header or %%EOF trailer)`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const checkOutputFile = async (p: string, ext: string): Promise<string> => {
  if (extname(p).toLowerCase() !== ext) throw new Error(`Only ${ext} files are ${ext === '.pdf' ? 'read or written' : 'written here'}: ${p}`);
  const abs = resolve(p);
  await assertLexical(p, abs);
  const parent = await realpathOr404(p, dirname(abs));
  const target = join(parent, basename(abs));
  await assertInRoot(target, p);
  const st = await lstat(target).catch(() => undefined);
  if (st?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${p}`);
  if (st && !st.isFile()) throw new Error(`Output path exists and is not a file: ${p}`);
  // Early refusal before the API call; the writer re-checks on the open handle.
  if (st && st.nlink > 1) throw new Error(`Refusing: ${p} has ${st.nlink} hard links, so its path does not prove it is inside the allowed directories`);
  return target;
};

/** Check an output path and return the resolved path to write. Exported for tests. */
export const checkOutputPath = (p: string): Promise<string> => checkOutputFile(p, '.pdf');

/** Early check of an .xlsx output path, before the API call. */
export const checkOutputXlsx = (p: string): Promise<string> => checkOutputFile(p, '.xlsx');

const writeChecked = async (target: string, p: string, bytes: Uint8Array): Promise<string> => {
  // On Linux the parent directory is opened first and every later step goes through that descriptor
  // (/proc/self/fd/N/name), so a parent swapped for a link after this point changes nothing: the create,
  // the check and any cleanup all act on the same directory, never on whatever the path names by then.
  let dir: FileHandle | undefined;
  let via = target;
  if (process.platform === 'linux') {
    dir = await openOr404(dirname(target), fsc.O_RDONLY | fsc.O_DIRECTORY | NOFOLLOW, p);
    const actual = await readlink(`/proc/self/fd/${dir.fd}`).catch(() => undefined);
    if (actual !== dirname(target)) {
      await dir.close();
      throw new Error(`Refusing: ${p} changed while it was being opened`);
    }
    via = join(`/proc/self/fd/${dir.fd}`, basename(target));
  }
  try {
    // O_EXCL says whether THIS call created the file. A lstat beforehand cannot, and only a file this call
    // created may ever be removed again.
    // No O_TRUNC: truncating before the link check would already destroy a hard-linked file.
    let created = true;
    let fh: FileHandle;
    try {
      fh = await open(via, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | NOFOLLOW | NONBLOCK, 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw notFound(p);
      created = false;
      fh = await openOr404(via, fsc.O_WRONLY | NOFOLLOW | NONBLOCK, p);
    }
    try {
      await assertSingleLinkFile(fh, target, p);
      await fh.truncate(0);
      await fh.writeFile(bytes); // position is still 0 after the truncate
    } catch (e) {
      // A failed check must not leave the file this call just created behind. Removed only when the inode
      // at `via` is the one this call opened (without the descriptor, e.g. off Linux, the path itself).
      if (created) {
        const mine = await fh.stat().catch(() => undefined);
        const at = await lstat(via).catch(() => undefined);
        if (mine && at && at.ino === mine.ino && at.dev === mine.dev) await unlink(via).catch(() => {});
      }
      throw e;
    } finally {
      await fh.close();
    }
  } finally {
    await dir?.close();
  }
  return resolve(p);
};

/** Write produced PDF bytes to a checked output path; returns the path written. */
export const writeOutputPdf = async (p: string, bytes: Uint8Array): Promise<string> => {
  const target = await checkOutputPath(p);
  if (!looksLikePdf(bytes)) throw new Error('Refusing to write: the API response is not a PDF');
  return writeChecked(target, p, bytes);
};

/** An API PDF result starts with %PDF- at offset 0 (the tolerant looksLikePdf is for inputs). */
export const startsWithPdf = (b: Uint8Array): boolean =>
  b.byteLength >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

/** A zip with a local file header at offset 0 and an end-of-central-directory record near the end. */
export const looksLikeXlsx = (b: Uint8Array): boolean => {
  if (!(b.byteLength > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4)) return false;
  const tail = Buffer.from(b.subarray(Math.max(0, b.byteLength - 65_557)));
  return tail.includes(Buffer.from([0x50, 0x4b, 5, 6]));
};

/** Write the workbook to a checked .xlsx path; returns the path written. */
export const writeOutputXlsx = async (p: string, bytes: Uint8Array): Promise<string> => {
  const target = await checkOutputXlsx(p);
  if (!looksLikeXlsx(bytes)) throw new Error('Refusing to write: the API response is not an xlsx workbook');
  return writeChecked(target, p, bytes);
};

/** Check an output directory (pdf_split) and return its resolved path. */
export const checkOutputDir = async (d: string): Promise<string> => {
  await assertLexical(d, resolve(d));
  const real = await realpathOr404(d, resolve(d));
  await assertInRoot(real, d);
  const st = await lstat(real).catch(() => null);
  if (!st?.isDirectory()) throw notFound(d);
  return real;
};

// Same host rules as the hosted server (src/api/mcp.ts blockedHost), plus a DNS
// check, since a public name can resolve to a private address.
export const blockedHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 (Oracle Cloud metadata 192.0.0.192)
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
      a >= 224 // multicast and reserved 224/4, 240/4
    );
  }
  if (h.includes(':')) {
    return (
      h.startsWith('::') || // unspecified, loopback, IPv4-compatible and IPv4-mapped
      /^f[cd][0-9a-f]{0,2}:/.test(h) || // fc00::/7
      /^fe[89a-f][0-9a-f]?:/.test(h) || // fe80::/10 link-local, fec0::/10 site-local
      /^64:ff9b:/.test(h) || // NAT64
      /^2002:/.test(h) || // 6to4
      /^0{1,4}:0{1,4}:0{1,4}:0{1,4}:0{1,4}:/.test(h) // uncompressed ::x forms
    );
  }
  return false;
};

export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/** Read a response body with a running byte count, aborting as soon as it passes the cap. */
export const readCapped = async (res: Response, cap: number, label: string): Promise<Uint8Array> => {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${label} is ${declared} bytes; limit is ${cap}`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} is over ${cap} bytes; limit is ${cap}`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

/** Wrap an API response so any body read past the cap fails (a gzip bomb counts decompressed bytes). */
export const capResponse = (res: Response, cap: number): Response => {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > cap) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`The API response is ${declared} bytes; limit is ${cap}`);
  }
  if (!res.body) return res;
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      total += chunk.byteLength;
      if (total > cap) ctl.error(new Error(`The API response is over ${cap} bytes; limit is ${cap}`));
      else ctl.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(limiter), { status: res.status, statusText: res.statusText, headers: res.headers });
};

/**
 * Resolve many sources with at most 4 in flight and a cumulative byte cap, in order. The cap is checked
 * as each one lands, so nothing is uploaded when the set is too big.
 */
export const resolveAll = async (
  sources: string[],
  one: (source: string, index: number) => Promise<Uint8Array>,
  totalCap: number,
  what: string,
): Promise<Uint8Array[]> => {
  const out: Uint8Array[] = new Array(sources.length);
  let next = 0;
  let total = 0;
  let stop = false;
  const worker = async (): Promise<void> => {
    while (!stop) {
      const i = next++;
      if (i >= sources.length) return;
      try {
        out[i] = await one(sources[i], i);
        total += out[i].byteLength;
        if (total > totalCap) throw new Error(`${what} together are over ${totalCap} bytes`);
      } catch (e) {
        stop = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
  return out;
};

const fetchUrl = async (source: string, fetchImpl: typeof fetch, lookupImpl: LookupFn): Promise<Uint8Array> => {
  let url = source;
  let res: Response;
  for (let hop = 0; ; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Malformed URL');
    }
    const label = describeSource(url);
    if (parsed.protocol !== 'https:') throw new Error(`${label}: only https:// URLs are fetched`);
    if (blockedHost(parsed.hostname)) throw new Error(`${label}: local, private and internal addresses are not fetched`);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const addrs = await lookupImpl(host).catch(() => {
      throw new Error(`${label}: host does not resolve`);
    });
    if (addrs.some((a) => blockedHost(a.address))) {
      throw new Error(`${label}: resolves to a local, private or internal address; not fetched`);
    }
    res = await fetchImpl(parsed.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/pdf,*/*' },
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (!location) throw new Error(`${label} redirected without a Location header`);
    // hop counts redirects already followed, so this allows exactly MAX_REDIRECTS of them.
    if (hop >= MAX_REDIRECTS) throw new Error(`${label}: more than ${MAX_REDIRECTS} redirects`);
    url = new URL(location, parsed).href;
  }
  const label = describeSource(url);
  if (!res.ok) throw new Error(`Fetching ${label} failed: HTTP ${res.status}`);
  const buf = await readCapped(res, MAX_INPUT_BYTES, label);
  if (buf.byteLength === 0) throw new Error(`${label} returned an empty body`);
  return buf;
};

/** Resolve a source string (path | https URL | data: URI) to PDF bytes. */
export const resolveSource = async (
  source: string,
  fetchImpl: typeof fetch = fetch,
  lookupImpl: LookupFn = defaultLookup,
): Promise<Uint8Array> => {
  switch (classifySource(source)) {
    case 'data':
      // No %PDF/%%EOF check on purpose: these are bytes the caller supplied, not a
      // filesystem read, so there is nothing to contain and nothing to exfiltrate.
      return decodeDataUri(source);
    case 'url':
      return fetchUrl(source, fetchImpl, lookupImpl);
    default:
      return readLocalPdf(source);
  }
};

/** File types a tool may read from disk besides PDFs: image inputs and attachment payloads. */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];
export const ATTACHMENT_EXTS = ['.xml', '.csv', '.json', '.txt', '.md', '.html', '.xlsx', '.pdf', ...IMAGE_EXTS];

/** PNG (89 50 4E 47) or JPEG (FF D8 FF) magic. */
export const isImageBytes = (b: Uint8Array): boolean =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

/**
 * Non-PDF local read. Stricter than readLocalPdf because the allowlist is by extension: the RESOLVED file
 * must have an allowed extension too (a link named logo.png to .env is refused), nothing below the root
 * may sit in a dot-prefixed file or folder (.env, .config, .docker, .claude, .credentials.json), an
 * image-typed file must carry PNG or JPEG magic and a .pdf must pass the same check as a PDF input.
 */
const readLocalFile = async (p: string, exts: string[]): Promise<Uint8Array> => {
  if (!exts.includes(extname(p).toLowerCase())) throw new Error(`Only ${exts.join(', ')} files are read here: ${p}`);
  await assertLexical(p, resolve(p));
  const real = await realpathOr404(p, resolve(p));
  const roots = await containingRoots(real);
  if (roots.length === 0) throw notFound(p);
  const realExt = extname(real).toLowerCase();
  if (!exts.includes(realExt)) throw new Error(`${p} resolves to a file type that is not read here`);
  // Accepted when ANY containing root reaches the file without a dot-prefixed component.
  if (!roots.some((r) => !relative(r, real).split(sep).some((seg) => seg.startsWith('.')))) {
    throw new Error(`${p}: files and folders whose names start with a dot are not read`);
  }
  const fh = await openOr404(real, fsc.O_RDONLY | NOFOLLOW | NONBLOCK, p);
  let buf: Buffer;
  try {
    await assertSingleLinkFile(fh, real, p);
    buf = await readCappedFile(fh, p, MAX_INPUT_BYTES);
  } finally {
    await fh.close();
  }
  if (buf.byteLength === 0) throw new Error(`${p} is empty`);
  if (realExt === '.pdf' && !looksLikeWholePdf(buf)) throw new Error(`${p} is not a PDF (no %PDF header or %%EOF trailer)`);
  if (IMAGE_EXTS.includes(realExt) && !isImageBytes(buf)) throw new Error(`${p} is not a PNG or JPEG image`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

/** Resolve a non-PDF source (path | https URL | data: URI) to bytes; a local path must end in one of exts. */
export const resolveFile = async (
  source: string,
  exts: string[],
  fetchImpl: typeof fetch = fetch,
  lookupImpl: LookupFn = defaultLookup,
): Promise<Uint8Array> => {
  switch (classifySource(source)) {
    case 'data':
      return decodeDataUri(source);
    case 'url':
      return fetchUrl(source, fetchImpl, lookupImpl);
    default:
      return readLocalFile(source, exts);
  }
};

/** An image source: like resolveFile, and whatever the origin the bytes must be a PNG or JPEG. */
export const resolveImage = async (
  source: string,
  fetchImpl: typeof fetch = fetch,
  lookupImpl: LookupFn = defaultLookup,
): Promise<Uint8Array> => {
  const b = await resolveFile(source, IMAGE_EXTS, fetchImpl, lookupImpl);
  if (!isImageBytes(b)) throw new Error(`${describeSource(source)} is not a PNG or JPEG image`);
  return b;
};

type TextContent = { type: 'text'; text: string };
type ResourceContent = {
  type: 'resource';
  resource: { uri: string; mimeType: string; blob: string };
};

/**
 * Tool result for a produced PDF. With `wroteTo` (the caller already wrote the
 * file) it is a one-line confirmation; without it the bytes travel back inline
 * as an embedded application/pdf resource, which is what a hosted server must
 * do since it has no filesystem the agent can reach.
 */
export const pdfResult = (
  bytes: Uint8Array,
  name: string,
  summary: string,
  wroteTo?: string,
): { content: Array<TextContent | ResourceContent> } => {
  if (wroteTo) {
    return { content: [{ type: 'text', text: `${summary} written to ${wroteTo} (${bytes.byteLength} bytes)` }] };
  }
  const uri = `pdfops://${name}`;
  return {
    content: [
      {
        type: 'text',
        text: `${summary} (${bytes.byteLength} bytes) returned inline as ${uri} — no output_path was given. Save the attached application/pdf resource; pass output_path to write to disk instead.`,
      },
      { type: 'resource', resource: { uri, mimeType: 'application/pdf', blob: Buffer.from(bytes).toString('base64') } },
    ],
  };
};
