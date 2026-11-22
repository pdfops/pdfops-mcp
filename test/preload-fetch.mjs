// Test preload: replaces global fetch so no request leaves the machine, and logs what the server asked for.
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
  appendFileSync(process.env.FETCH_LOG, JSON.stringify({ url: String(url), redirect: init?.redirect, hasSignal: Boolean(init?.signal) }) + '\n');
  return new Response('%PDF-1.4\n%%EOF\n', { status: 200, headers: { 'content-type': 'application/pdf' } });
};
