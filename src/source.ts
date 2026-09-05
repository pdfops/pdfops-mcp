// PDF input/output plumbing shared by every tool.
//
// The server was designed around local file paths (bytes never transit the
// model context). That is still the right default beside a local agent — but
// every hosted MCP runtime (Smithery, Glama hosted, cloud IDE gateways) runs
// this process on a machine where the agent's paths do not exist, so inspect/
// fill/merge were broken by construction there (TASK-102). A "source" string is
// now one of three things, told apart by prefix, with no schema change:
//
//   /abs/path/file.pdf                        read from disk (local default)
//   https://host/file.pdf                     fetched (hosted default)
//   data:application/pdf;base64,JVBERi0x...   decoded inline
//
// Outputs mirror it: with `output_path` the PDF is written to disk; without it
// the PDF comes back as an embedded application/pdf resource the client saves.

import { readFile } from 'node:fs/promises';

/** Upper bound on a fetched or inline PDF. The API rejects larger bodies anyway. */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

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

const fetchUrl = async (url: string, fetchImpl: typeof fetch): Promise<Uint8Array> => {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/pdf,*/*' },
  });
  if (!res.ok) throw new Error(`Fetching ${describeSource(url)} failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_INPUT_BYTES) {
    throw new Error(`${describeSource(url)} is ${declared} bytes; limit is ${MAX_INPUT_BYTES}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`${describeSource(url)} is ${buf.byteLength} bytes; limit is ${MAX_INPUT_BYTES}`);
  }
  if (buf.byteLength === 0) throw new Error(`${describeSource(url)} returned an empty body`);
  return buf;
};

/** Resolve a source string (path | https URL | data: URI) to PDF bytes. */
export const resolveSource = async (
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> => {
  switch (classifySource(source)) {
    case 'data':
      return decodeDataUri(source);
    case 'url':
      return fetchUrl(source, fetchImpl);
    default: {
      const buf = await readFile(source);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
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
