// Spawns the built server over stdio with raw JSON-RPC, once per protocol era:
// the 2025 initialize handshake (legacy clients) and the stateless 2026-07-28 revision,
// where every request carries its protocol version in _meta and there is no initialize.
// The API base URL points at a closed port, so nothing here reaches the network.
// Run: npm run build && npm test

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const SERVER = join(import.meta.dirname, '..', 'dist', 'index.js');
const SKILL_FILE = join(import.meta.dirname, '..', 'skills', 'pdf-workflows', 'SKILL.md');
const SKILL_URI = 'skill://pdf-workflows/SKILL.md';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pdfops-mcp-skills-')));
// A real PDF that exists OUTSIDE the root: the refusal must come from containment, not from a missing file.
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pdfops-mcp-outside-')));
const OUTSIDE_PDF = join(outside, 'secret.pdf');
writeFileSync(OUTSIDE_PDF, '%PDF-1.4\n%%EOF\n');
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function start() {
  const p = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', PDFOPS_BASE_URL: 'http://127.0.0.1:9', PDFOPS_ROOT: root },
  });
  const waiters = new Map();
  let buf = '';
  let stderr = '';
  p.stderr.on('data', (d) => (stderr += d));
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    }
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${stderr}`)), 10_000);
      waiters.set(n, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  const notify = (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { send, notify, stderr: () => stderr, stop: () => p.kill() };
}

for (const protocolVersion of ['2025-11-25', '2025-06-18', '2025-03-26']) {
  test(`legacy handshake ${protocolVersion}: initialize, 24 tools, a local tool error`, async () => {
    const s = start();
    try {
      const init = await s.send('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'legacy-probe', version: '1' } });
      assert.equal(init.result.protocolVersion, protocolVersion);
      assert.equal(init.result.serverInfo.name, 'pdfops');
      assert.equal(init.result.serverInfo.version, JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
      assert.ok(init.result.capabilities.tools);
      assert.ok(init.result.capabilities.resources);
      s.notify('notifications/initialized');
      const list = await s.send('tools/list', {});
      assert.equal(list.result.tools.length, 24);
      // Schemas are advertised as draft-07 on this era too, as 0.6.1 did.
      for (const t of list.result.tools) {
        assert.equal(t.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#', t.name);
        assert.equal(t.outputSchema.$schema, 'http://json-schema.org/draft-07/schema#', t.name);
      }
      // An existing PDF outside PDFOPS_ROOT is refused before any API call.
      const call = await s.send('tools/call', { name: 'pdf_inspect', arguments: { pdf_path: OUTSIDE_PDF } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /outside the allowed directories/);
    } finally {
      s.stop();
    }
  });
}

test('modern 2026-07-28: discover, skills/list, skills/get, resources/read', async () => {
  const s = start();
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'modern-probe', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const req = (method, params = {}) => s.send(method, { ...params, _meta: meta });
  try {
    const bytes = readFileSync(SKILL_FILE);
    const text = bytes.toString('utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
    const fm = (k) => new RegExp(`^${k}: (.*)$`, 'm').exec(front)[1];

    const discover = await req('server/discover');
    assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
    assert.ok(discover.result.capabilities.resources, 'resources capability');
    assert.ok(discover.result.capabilities.extensions['io.modelcontextprotocol/skills'], 'skills extension');

    const list = await req('skills/list');
    assert.equal(list.result.skills.length, 1);
    const skill = list.result.skills[0];
    assert.equal(skill.uri, SKILL_URI);
    assert.equal(skill.frontmatter.name, fm('name'));
    assert.equal(skill.frontmatter.description, fm('description'));
    assert.equal(skill.resources.length, 1);
    assert.equal(skill.resources[0].uri, SKILL_URI);
    assert.equal(skill.resources[0].digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(skill.resources[0].size, bytes.length);

    const get = await req('skills/get', { uri: SKILL_URI });
    assert.deepEqual(get.result.skill, skill);

    const unknown = await req('skills/get', { uri: 'skill://nope/SKILL.md' });
    assert.equal(unknown.error.code, -32602);

    const read = await req('resources/read', { uri: SKILL_URI });
    assert.equal(read.result.contents[0].mimeType, 'text/markdown');
    assert.equal(read.result.contents[0].text, text);

    const tools = await req('tools/list');
    assert.equal(tools.result.tools.length, 24);
    // Schemas are advertised as draft-07, as 0.6.1 did, so a draft-07 validator accepts them.
    for (const t of tools.result.tools) {
      assert.equal(t.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#', t.name);
      assert.equal(t.outputSchema.$schema, 'http://json-schema.org/draft-07/schema#', t.name);
    }
  } finally {
    s.stop();
  }
});

// Source attribution: the client name/version reach the API as X-Pdfops-Client-Host on both eras.
test('X-Pdfops-Client-Host is sent for a legacy and a modern client, non-ASCII stripped', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const stub = createServer((req, res) => {
    req.resume();
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tier: 'free', limit: 250, used: 1, remaining: 249, period: '2026-11', resets_at: '2026-12-01T00:00:00Z' }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const run = async (hello) => {
    const p = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { PATH: process.env.PATH ?? '', PDFOPS_API_KEY: 'k', PDFOPS_ROOT: root, PDFOPS_BASE_URL: `http://127.0.0.1:${stub.address().port}` },
    });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    for (const m of hello) p.stdin.write(JSON.stringify(m) + '\n');
    const deadline = Date.now() + 10_000;
    while (!buf.includes('"id":9') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    p.kill();
    assert.ok(buf.includes('"id":9'), 'tool call answered');
  };
  try {
    await run([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-app', version: '1.2' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'pdfops_usage', arguments: {} } },
    ]);
    await run([
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'pdfops_usage',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'modern-apép', version: '3.4' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    ]);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]['x-pdfops-client-host'], 'legacy-app/1.2');
    assert.equal(seen[1]['x-pdfops-client-host'], 'modern-app/3.4');
    for (const h of seen) assert.match(h['x-pdfops-client-version'], /^0\.7\./);
  } finally {
    stub.close();
  }
});

// stdin EOF must not drop in-flight answers: the v2 stdio transport alone closes and aborts them.
test('stdin EOF with a slow tool call in flight: both answers arrive, exit code 0', { timeout: 20_000 }, async () => {
  const { createServer } = await import('node:http');
  const stub = createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tier: 'free', limit: 250, used: 1, remaining: 249, period: '2026-11', resets_at: '2026-12-01T00:00:00Z' }));
    }, 500);
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  let p;
  try {
    p = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { PATH: process.env.PATH ?? '', PDFOPS_API_KEY: 'dummy', PDFOPS_ROOT: root, PDFOPS_BASE_URL: `http://127.0.0.1:${stub.address().port}` },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const code = new Promise((r) => p.on('close', r));
    p.stdin.end(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eof', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pdfops_usage', arguments: {} } },
      ]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n',
    );
    assert.equal(await code, 0);
    const ids = out.trim().split('\n').map((l) => JSON.parse(l).id).sort();
    assert.deepEqual(ids, [1, 2]);
  } finally {
    p?.kill();
    stub.close();
  }
});

// The server must still exit when its transport closes for a reason other than stdin EOF.
const INIT_LINE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) + '\n';

test('a line over the 10 MiB bound with stdin left open: the server exits within 5 s', { timeout: 20_000 }, async () => {
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', PDFOPS_ROOT: root } });
  try {
    const exited = new Promise((r) => p.on('close', (c) => r(c)));
    p.stdin.on('error', () => {});
    p.stdout.resume();
    p.stdin.write(INIT_LINE);
    p.stdin.write(Buffer.alloc(11 * 1024 * 1024, 0x61));
    p.stdin.write('\n');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 5000))]);
    assert.notEqual(code, 'still running', 'process must exit once its transport has closed');
    assert.equal(code, 0);
  } finally {
    p.kill();
  }
});

test('client closes its read end of stdout, stdin open, then sends a call: the server exits within 5 s', { timeout: 20_000 }, async () => {
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', PDFOPS_ROOT: root } });
  try {
    const exited = new Promise((r) => p.on('close', (c) => r(c)));
    p.stdin.on('error', () => {});
    p.stdout.destroy();
    p.stdin.write(INIT_LINE);
    await new Promise((r) => setTimeout(r, 300));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 5000))]);
    assert.notEqual(code, 'still running', 'process must exit once its transport has closed');
  } finally {
    p.kill();
  }
});
