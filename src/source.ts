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
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
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

const assertInRoot = async (real: string, original: string): Promise<void> => {
  for (const r of allowedRoots()) {
    const rootReal = await realpath(r).catch(() => r);
    if (within(rootReal, real)) return;
  }
  throw new Error(
    `${original} is outside the allowed directories (${allowedRoots().join(', ')}). Set PDFOPS_ROOT to the folder(s) holding your PDFs.`,
  );
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
  const now = await lstat(path).catch(() => undefined);
  if (!now || now.dev !== st.dev || now.ino !== st.ino) throw new Error(`Refusing: ${p} changed while it was being opened`);
};

const readLocalPdf = async (p: string): Promise<Uint8Array> => {
  assertPdfExt(p);
  const real = await realpath(resolve(p));
  await assertInRoot(real, p);
  const fh = await open(real, fsc.O_RDONLY | NOFOLLOW | NONBLOCK);
  let buf: Buffer;
  try {
    await assertSingleLinkFile(fh, real, p);
    buf = await fh.readFile();
  } finally {
    await fh.close();
  }
  if (!looksLikeWholePdf(buf)) throw new Error(`${p} is not a PDF (no %PDF header or %%EOF trailer)`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

/** Check an output path and return the resolved path to write. Exported for tests. */
export const checkOutputPath = async (p: string): Promise<string> => {
  assertPdfExt(p);
  const abs = resolve(p);
  const parent = await realpath(dirname(abs)).catch(() => {
    throw new Error(`Output directory does not exist: ${dirname(abs)}`);
  });
  const target = join(parent, basename(abs));
  await assertInRoot(target, p);
  const st = await lstat(target).catch(() => undefined);
  if (st?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${p}`);
  if (st && !st.isFile()) throw new Error(`Output path exists and is not a file: ${p}`);
  // Early refusal before the API call; writeOutputPdf re-checks on the open handle.
  if (st && st.nlink > 1) throw new Error(`Refusing: ${p} has ${st.nlink} hard links, so its path does not prove it is inside the allowed directories`);
  return target;
};

/** Write produced PDF bytes to a checked output path; returns the path written. */
export const writeOutputPdf = async (p: string, bytes: Uint8Array): Promise<string> => {
  const target = await checkOutputPath(p);
  if (!looksLikePdf(bytes)) throw new Error('Refusing to write: the API response is not a PDF');
  // No O_TRUNC: truncating before the link check would already destroy a hard-linked file.
  const fh = await open(target, fsc.O_WRONLY | fsc.O_CREAT | NOFOLLOW | NONBLOCK, 0o644);
  try {
    await assertSingleLinkFile(fh, target, p);
    await fh.truncate(0);
    await fh.writeFile(bytes); // position is still 0 after the truncate
  } finally {
    await fh.close();
  }
  return resolve(p);
};

/** Check an output directory (pdf_split) and return its resolved path. */
export const checkOutputDir = async (d: string): Promise<string> => {
  const real = await realpath(resolve(d)).catch(() => {
    throw new Error(`output_dir is not an existing directory: ${d}`);
  });
  await assertInRoot(real, d);
  const st = await lstat(real);
  if (!st.isDirectory()) throw new Error(`output_dir is not an existing directory: ${d}`);
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
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_INPUT_BYTES) {
    throw new Error(`${label} is ${declared} bytes; limit is ${MAX_INPUT_BYTES}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`${label} is ${buf.byteLength} bytes; limit is ${MAX_INPUT_BYTES}`);
  }
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
