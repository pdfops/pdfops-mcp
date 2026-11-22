// Starts the built server over stdio and checks the tool list and the new tools' plumbing.
// The API is a stub on 127.0.0.1 (PDFOPS_BASE_URL), so nothing here touches the network.
// Run: npm run build && npm test

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const NEW_TOOLS = [
  'pdf_edit',
  'pdf_extract_text',
  'pdf_text_to_pdf',
  'pdf_find_text',
  'pdf_html_to_pdf',
  'pdf_image_to_pdf',
  'pdf_add_fields',
  'pdf_add_attachment',
];
const OLD_TOOLS = [
  'pdf_inspect', 'pdf_fill', 'pdf_merge', 'pdf_invoice', 'pdfops_usage', 'pdf_extract_pages', 'pdf_delete_pages',
  'pdf_rotate', 'pdf_split', 'pdf_watermark', 'pdf_page_numbers', 'pdf_unlock', 'pdf_protect', 'pdf_metadata', 'pdf_set_metadata',
];

const FAKE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const FAKE_XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('fake workbook'), Buffer.from([0x50, 0x4b, 5, 6]), Buffer.alloc(18)]);

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pdfops-mcp-test-')));
const calls = [];
let stub;
let client;

before(async () => {
  stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      calls.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/api/extract-text' && body.includes('xlsx')) {
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-pdfops-truncated': 'true', 'x-pdfops-truncated-by': 'pages' });
        res.end(FAKE_XLSX);
      } else if (req.url === '/api/attach') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'x-pdfops-attachment-keys': '[{"name":"data.xml","key":"data.xml"}]' });
        res.end(FAKE_PDF);
      } else {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(FAKE_PDF);
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const { port } = stub.address();
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, '..', 'dist', 'index.js')],
      env: { PATH: process.env.PATH ?? '', PDFOPS_BASE_URL: `http://127.0.0.1:${port}`, PDFOPS_ROOT: root },
    }),
  );
});

after(async () => {
  await client?.close();
  stub?.close();
});

test('tools/list has every old and new tool with an object input schema', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of [...OLD_TOOLS, ...NEW_TOOLS]) {
    const t = byName.get(name);
    assert.ok(t, `missing tool ${name}`);
    assert.equal(t.inputSchema.type, 'object', name);
    assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === 'object', name);
    assert.ok(t.description && t.description.length > 50, name);
  }
  assert.equal(tools.length, OLD_TOOLS.length + NEW_TOOLS.length);
});

test('pdf_extract_text takes tables_format csv and xlsx', async () => {
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === 'pdf_extract_text');
  assert.deepEqual(t.inputSchema.properties.tables_format.enum, ['json', 'csv', 'xlsx']);
});

test('pdf_invoice takes e_invoice factur-x and its extra fields', async () => {
  const { tools } = await client.listTools();
  const inv = tools.find((x) => x.name === 'pdf_invoice').inputSchema.properties.invoice.properties;
  assert.deepEqual(inv.e_invoice.enum, ['factur-x']);
  for (const k of ['tax_category', 'tax_exemption_reason', 'payment_terms', 'iban']) assert.ok(inv[k], k);
  assert.ok(inv.items.items.properties.unit);
  const party = inv.from.anyOf.find((x) => x.type === 'object').properties;
  for (const k of ['country', 'vat_id', 'tax_id', 'registration_id', 'street', 'postcode', 'city']) assert.ok(party[k], k);
});

test('pdf_invoice forwards e_invoice to the API', async () => {
  const before = calls.length;
  const r = await client.callTool({
    name: 'pdf_invoice',
    arguments: { invoice: { e_invoice: 'factur-x', from: { name: 'A', country: 'DE', vat_id: 'DE123456789' }, to: { name: 'B', country: 'FR' }, items: [{ description: 'x', unit_price: 1, unit: 'C62' }], currency: 'EUR' } },
  });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const sent = JSON.parse(calls[before].body);
  assert.equal(sent.e_invoice, 'factur-x');
  assert.equal(sent.from.vat_id, 'DE123456789');
  assert.equal(sent.items[0].unit, 'C62');
});

test('pdf_extract_text xlsx comes back inline with the xlsx media type', async () => {
  const pdf = `data:application/pdf;base64,${FAKE_PDF.toString('base64')}`;
  const r = await client.callTool({ name: 'pdf_extract_text', arguments: { pdf_path: pdf, tables_format: 'xlsx' } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const res = r.content.find((c) => c.type === 'resource').resource;
  assert.equal(res.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.deepEqual(Buffer.from(res.blob, 'base64'), FAKE_XLSX);
  assert.equal(r.structuredContent.resource_uri, 'pdfops://tables.xlsx');
  assert.equal(r.structuredContent.truncated, true);
  assert.deepEqual(r.structuredContent.truncated_by, ['pages']);
});

test('pdf_extract_text xlsx writes a .xlsx output_path and refuses other targets', async () => {
  const pdf = `data:application/pdf;base64,${FAKE_PDF.toString('base64')}`;
  const out = join(root, 'tables.xlsx');
  const r = await client.callTool({ name: 'pdf_extract_text', arguments: { pdf_path: pdf, tables_format: 'xlsx', output_path: out } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.deepEqual(readFileSync(out), FAKE_XLSX);
  assert.equal(r.structuredContent.output_path, out);
  const bad = await client.callTool({ name: 'pdf_extract_text', arguments: { pdf_path: pdf, tables_format: 'xlsx', output_path: join(root, 'tables.pdf') } });
  assert.equal(bad.isError, true);
  const notXlsx = await client.callTool({ name: 'pdf_extract_text', arguments: { pdf_path: pdf, output_path: join(root, 'x.xlsx') } });
  assert.equal(notXlsx.isError, true);
});

test('pdf_text_to_pdf writes the PDF to output_path', async () => {
  const out = join(root, 'doc.pdf');
  const before = calls.length;
  const r = await client.callTool({ name: 'pdf_text_to_pdf', arguments: { content: '# Hi', output_path: out } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.deepEqual(readFileSync(out), FAKE_PDF);
  assert.deepEqual(JSON.parse(calls[before].body), { content: '# Hi' });
});

test('pdf_add_attachment reads a local file, names it and sends the client headers', async () => {
  const pdfPath = join(root, 'in.pdf');
  writeFileSync(pdfPath, FAKE_PDF);
  writeFileSync(join(root, 'data.xml'), '<a/>');
  const before = calls.length;
  const r = await client.callTool({
    name: 'pdf_add_attachment',
    arguments: { pdf_path: pdfPath, files: [{ source: join(root, 'data.xml'), relationship: 'Data' }], output_path: join(root, 'out.pdf') },
  });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const c = calls[before];
  assert.equal(c.url, '/api/attach');
  assert.equal(c.headers['x-pdfops-client'], 'mcp');
  assert.match(c.body, /"name":"data\.xml"/);
  assert.match(c.body, /"relationship":"Data"/);
  assert.deepEqual(r.structuredContent.keys, [{ name: 'data.xml', key: 'data.xml' }]);
});

test('advertised schemas use only JSON Schema keywords from the known-safe set', async () => {
  // Same set as tests/mcp-npm-tools.test.ts: some MCP clients reject any other keyword.
  const SAFE = new Set(['$schema', 'additionalProperties', 'anyOf', 'const', 'description', 'enum', 'exclusiveMinimum',
    'items', 'maxItems', 'maxLength', 'maximum', 'minItems', 'minimum', 'pattern', 'properties', 'required', 'type']);
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      seen.add(k);
      if (k === 'properties') Object.values(v).forEach(walk);
      else if (k === 'items' || k === 'additionalProperties') walk(v);
      else if (k === 'anyOf') v.forEach(walk);
    }
  };
  const { tools } = await client.listTools();
  for (const t of tools) {
    walk(t.inputSchema);
    walk(t.outputSchema);
  }
  assert.deepEqual([...seen].filter((k) => !SAFE.has(k)), []);
});

test('local file inputs are confined to PDFOPS_ROOT and to allowed types', async () => {
  const outside = await client.callTool({ name: 'pdf_image_to_pdf', arguments: { image_paths: ['/etc/hostname.png'] } });
  assert.equal(outside.isError, true);
  writeFileSync(join(root, 'notes.exe'), 'x');
  const wrongType = await client.callTool({ name: 'pdf_add_attachment', arguments: { pdf_path: `data:application/pdf;base64,${FAKE_PDF.toString('base64')}`, files: [{ source: join(root, 'notes.exe') }] } });
  assert.equal(wrongType.isError, true);
});
