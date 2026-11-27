#!/usr/bin/env node
// pdfops-mcp — MCP server exposing the PDFops API as agent tools.
//
// Design: tools take PDF *sources* and return files or inline PDFs.
// Beside a local agent (npx pdfops-mcp) the filesystem is the natural
// interface — "fill /tmp/form.pdf and save to /tmp/out.pdf" — and the PDF
// bytes never transit the model context. On a hosted runtime (Smithery,
// Glama hosted, cloud IDE gateways) the agent's paths do not exist on this
// machine, so every source also accepts an https:// URL or a
// data:application/pdf;base64 URI, and omitting output_path returns the
// result inline as an application/pdf resource. See src/source.ts.
//
// Tools: pdf_inspect, pdf_fill, pdf_merge, pdf_invoice, pdfops_usage,
// pdf_extract_pages, pdf_delete_pages, pdf_rotate, pdf_split, pdf_watermark,
// pdf_page_numbers, pdf_unlock, pdf_protect, pdf_metadata, pdf_set_metadata,
// pdf_edit, pdf_extract_text, pdf_text_to_pdf, pdf_find_text, pdf_detect_fields,
// pdf_add_fields, pdf_image_to_pdf, pdf_add_attachment, pdf_html_to_pdf.
//
// Env:
//   PDFOPS_API_KEY  optional — free key from https://pdfops.dev/pricing
//                   (250 req/mo; keyless works at 100 req/IP/mo)
//   PDFOPS_BASE_URL optional — API origin override (testing)

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/server';
// Tool annotations (title + readOnlyHint/destructiveHint) are mandatory for the
// Claude Connectors Directory and help every client show what a tool does.
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PdfOps, PdfOpsError } from 'pdfops-sdk';
import {
  ATTACHMENT_EXTS,
  capResponse,
  checkOutputDir,
  assertWritable,
  checkOutputPath,
  checkOutputXlsx,
  describeSource,
  looksLikeXlsx,
  pdfResult,
  resolveAll,
  resolveFile,
  resolveImage,
  resolveSource,
  startsWithPdf,
  writeOutputPdf,
  writeOutputXlsx,
} from './source.js';

// Version comes from package.json so the string MCP clients display can no
// longer drift from the published one (0.2.0 shipped reporting 0.1.1).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Everything below, up to the final "return server", runs once per connection (serveStdio
// calls the factory), so a server instance never shares state with another. The body is
// deliberately not re-indented.
//
// The one Agent Skill ships beside dist/ (see "files" in package.json). This is the only file
// index.ts reads: a constant path, no caller input reaches it, read once at startup. The bytes
// go into an in-memory source, so nothing else under skills/ can ever be served. The path must
// be a regular file (lstat: a FIFO would block startup forever, a symlink would be followed).
// Any failure (not a regular file, missing, bad frontmatter) costs only the skill: a pdfops-mcp
// line on stderr (the SDK may print its own warnings too), and all tools still serve.
const SKILL_NAME = 'pdf-workflows';
const skills = await (async () => {
  try {
    const skillPath = fileURLToPath(new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url));
    if (!lstatSync(skillPath).isFile()) throw new Error('SKILL.md is not a regular file');
    const bytes = readFileSync(skillPath);
    const catalog = await SkillsExtension.load(memorySkillFiles({ [`${SKILL_NAME}/SKILL.md`]: bytes }), { strict: true });
    if (catalog.entries.length !== 1) throw new Error(`expected 1 skill, got ${catalog.entries.length}`);
    return catalog;
  } catch (e) {
    process.stderr.write(`pdfops-mcp: skill not loaded, serving tools only: ${e instanceof Error ? e.message : String(e)}\n`);
    return undefined;
  }
})();

function createServer(): McpServer {
const server = new McpServer({ name: 'pdfops', version });
skills?.attach(server);

// v2 SDK plumbing (TASK-635), both done once here so no tool registration changes.
// 1. The SDK always advertises JSON Schema 2020-12. 0.6.1 advertised draft-07, and a client
//    that compiles tool schemas with a draft-07 validator rejects an unknown meta-schema, so
//    every schema is wrapped to ask zod for draft-07 instead.
// 2. A 2026-07-28 client sends no initialize, so getClientVersion() is empty; its identity is
//    in each request's _meta envelope. Each tool call runs inside a store holding that identity.
type JsonSchemaStd = { jsonSchema: Record<'input' | 'output', (o: object) => unknown> };
type ToolConfig = { inputSchema?: unknown; outputSchema?: unknown };
type ToolCb = (...a: unknown[]) => unknown;
type RegisterTool = (name: string, config: ToolConfig, cb: ToolCb) => unknown;
const draft07 = (schema: z.ZodType): z.ZodType => {
  const std = schema['~standard'] as unknown as JsonSchemaStd;
  const convert = (io: 'input' | 'output') => (o: object) => std.jsonSchema[io]({ ...o, target: 'draft-07' });
  return new Proxy(schema, {
    get: (t, p) => (p === '~standard' ? { ...std, jsonSchema: { input: convert('input'), output: convert('output') } } : Reflect.get(t, p, t)),
  });
};
const asObject = (s: unknown): z.ZodType | undefined => (s === undefined ? undefined : draft07('~standard' in (s as object) ? (s as z.ZodType) : z.object(s as z.ZodRawShape)));
const clientStore = new AsyncLocalStorage<{ name?: unknown; version?: unknown } | undefined>();
const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
(server as unknown as { registerTool: RegisterTool }).registerTool = (name, config, cb) =>
  registerTool(name, { ...config, inputSchema: asObject(config.inputSchema), outputSchema: asObject(config.outputSchema) }, (...a) => {
    const ctx = a[a.length - 1] as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined;
    return clientStore.run(ctx?.mcpReq?.envelope?.['io.modelcontextprotocol/clientInfo'] as { name?: unknown; version?: unknown } | undefined, () => cb(...a));
  });
// Source attribution: every API call carries this server's version and the
// MCP host app ("claude-ai/0.1.0", "cursor-vscode/1.0.0", …) taken from the
// initialize handshake's clientInfo. Added via a fetch wrapper rather than
// SDK options because clientInfo only exists after connect.
const API_TIMEOUT_MS = 60_000; // html-to-pdf can take 15 s
const MAX_API_RESPONSE_BYTES = 32 * 1024 * 1024;
// The MCP stdio transport buffers a message in memory (10 MB), and base64 adds a third.
const MAX_INLINE_BYTES = 7 * 1024 * 1024;
const MAX_ERROR_TEXT = 500;
// Cumulative upload caps across a tool's sources, checked before anything is sent.
const MAX_UPLOAD_BYTES = 4_500_000;
const MAX_ATTACH_BYTES = 3 * 1024 * 1024;
// Measured multipart framing per part (boundary, Content-Disposition, Content-Type): 129 to 175 bytes, rounded up.
const MULTIPART_PART_BYTES = 200;
/** The PDF plus its extra files must stay under the combined upload cap, checked before anything is sent. */
const assertUploadFits = (pdf: Uint8Array, extra: Uint8Array[], what: string, text: string[]): void => {
  const textBytes = text.reduce((n, t) => n + Buffer.byteLength(t), 0);
  const framing = (1 + extra.length + text.length) * MULTIPART_PART_BYTES;
  if (pdf.byteLength + extra.reduce((n, b) => n + b.byteLength, 0) + textBytes + framing > MAX_UPLOAD_BYTES) {
    throw new Error(`${what} together are over ${MAX_UPLOAD_BYTES} bytes`);
  }
};

// clientInfo comes from the connecting app; a non-ASCII name would make every API call throw on the header.
const hostTag = (): string | undefined => {
  const host = clientStore.getStore() ?? server.server.getClientVersion();
  const clean = (v: unknown) => String(v).replace(/[^\x20-\x7e]/g, '').slice(0, 100);
  return host ? `${clean(host.name)}/${clean(host.version)}` : undefined;
};

const BASE_URL = process.env.PDFOPS_BASE_URL?.trim() || undefined;

const REDIRECT_MESSAGE = 'The API answered with a redirect, which is refused so the API key is never sent to another host. Check PDFOPS_BASE_URL.';

// redirect: 'error' so X-API-Key and the body are never forwarded to another origin.
const apiFetch = async (url: string | URL | Request, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (e) {
    const why = String((e as { cause?: { message?: unknown } })?.cause?.message ?? (e as Error)?.message ?? e);
    if (/redirect/i.test(why)) throw new Error(REDIRECT_MESSAGE);
    throw e;
  }
};

const client = new PdfOps({
  apiKey: process.env.PDFOPS_API_KEY,
  baseUrl: BASE_URL,
  clientTag: 'mcp',
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Pdfops-Client-Version', version);
    const host = hostTag();
    if (host) headers.set('X-Pdfops-Client-Host', host);
    return capResponse(await apiFetch(input, { ...init, headers }), MAX_API_RESPONSE_BYTES);
  },
});

const SOURCE_DOC =
  'PDF source: a path to a .pdf file inside the allowed directories (PDFOPS_ROOT, default the working directory), an https:// URL, or a data:application/pdf;base64,… URI. A URL or data URI works when this server runs remotely (Smithery, hosted gateways), where local paths do not exist.';
const OUTPUT_DOC =
  'Path of a .pdf file to write the result to, inside the allowed directories (PDFOPS_ROOT, default the working directory); an existing file there is overwritten. Without it (as when running remotely) the PDF is returned inline as an application/pdf resource for the client to save.';

const PASSWORD_DOC =
  'Password to open the input, only needed for a user-password PDF (owner-locked files with an empty user password open without it).';

const capText = (v: string): string => (v.length > MAX_ERROR_TEXT ? `${v.slice(0, MAX_ERROR_TEXT)}...` : v);

const errText = (e: unknown): string =>
  e instanceof PdfOpsError
    ? `PDFops API error ${e.status} (${capText(e.code)}): ${capText(e.message)}` +
      (e.code === 'rate_limited'
        ? ' — get a free API key (250/mo) at https://pdfops.dev/pricing and set PDFOPS_API_KEY'
        : '')
    : e instanceof Error
      ? e.message
      : String(e);

const INVOICE_PARTY = z.looseObject({
  name: z.string(),
  lines: z.array(z.string()).optional(),
  country: z
    .string()
    .regex(/^([A-Z]{2}|1A)$/)
    .optional()
    .describe('ISO 3166-1 alpha-2 country code in capitals (1A for Kosovo, as in the EN 16931 list). Required when e_invoice is set.'),
  street: z.string().max(200).optional(),
  postcode: z.string().max(35).optional(),
  city: z.string().max(35).optional(),
  vat_id: z
    .string()
    .max(35)
    .optional()
    .describe('VAT identification number. With e_invoice it must start with a two-letter capital country prefix, such as DE123456789 (EL for Greece), and the seller needs vat_id, or tax_id plus registration_id.'),
  tax_id: z
    .string()
    .max(35)
    .optional()
    .describe('National tax number. With e_invoice it is accepted for the seller only: EN 16931 has no buyer tax number, so to.tax_id is refused (to.vat_id carries the VAT number of the buyer).'),
  registration_id: z.string().max(35).optional().describe('Legal registration number, for example a commercial register number.'),
});

const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: errText(e) }], isError: true });

// Declared as outputSchema on every PDF-emitting tool so an agent knows what it
// gets back without calling first. Both delivery modes are represented: a path
// when output_path was given, a pdfops:// resource uri when it was not.
const PDF_OUTPUT = {
  bytes: z.number().int().describe('Size of the produced PDF in bytes'),
  output_path: z.string().optional().describe('Absolute path written, when output_path was supplied'),
  resource_uri: z.string().optional().describe('pdfops:// uri of the inline application/pdf resource, when output_path was omitted'),
};

const tooBigInline = (n: number) =>
  new Error(`The result is ${n} bytes, over the ${MAX_INLINE_BYTES} byte limit for inline results. Pass output_path to write it to disk instead.`);

const emit = async (bytes: Uint8Array, name: string, summary: string, output_path?: string) => {
  if (!startsWithPdf(bytes)) throw new Error('The API response is not a PDF; refusing to use it');
  if (!output_path && bytes.byteLength > MAX_INLINE_BYTES) throw tooBigInline(bytes.byteLength);
  if (output_path) output_path = await writeOutputPdf(output_path, bytes);
  const base = pdfResult(bytes, name, summary, output_path);
  return {
    ...base,
    structuredContent: output_path
      ? { bytes: bytes.byteLength, output_path }
      : { bytes: bytes.byteLength, resource_uri: `pdfops://${name}` },
  };
};

server.registerTool(
  'pdf_inspect',
  {
    title: 'Inspect PDF form fields',
    description: 'List the form fields (AcroForm) of a PDF: names, types, options, current values and per-field maxLength where declared, plus a fillTemplate object ready to pass to pdf_fill and a hasXFA flag (hybrid AcroForm/XFA inputs lose their XFA layer when filled). A PDF with no fillable form returns count 0. Read-only: the PDF is fetched or read but never modified. pdf_fill rejects unknown field names and over-length values; this tool lists the names and the maxLength values it checks against.',
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
    },
    outputSchema: {
      count: z.number().int().describe('Number of form fields found; 0 when the PDF has no fillable form'),
      hasXFA: z.boolean().describe('True for hybrid AcroForm/XFA documents, whose XFA layer is dropped when filled'),
      truncated: z.boolean().describe('True when the form exceeded an API enumeration cap; fields is then a prefix, not the full list'),
      fields: z
        .array(
          z.object({
            name: z.string(),
            label: z.string().optional().describe('Alternate (tooltip) name, present only when the form declares one'),
            type: z.string().describe('text, checkbox, dropdown, radio, optionlist, or unsupported'),
            readOnly: z.boolean(),
            value: z.string().optional(),
            options: z.array(z.string()).optional().describe('Permitted values for radio/dropdown/optionlist fields'),
            checked: z.boolean().optional(),
            maxLength: z.number().int().optional().describe('Longer values are rejected by pdf_fill'),
            raw: z.unknown().optional(),
          }),
        )
        .describe('One entry per form field, in document order'),
      fillTemplate: z.object({}).catchall(z.string()).describe('Field name to empty-or-current value, ready to edit and pass to pdf_fill'),
    },
    annotations: { title: 'Inspect PDF form fields', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, password }) => {
    try {
      const result = await client.inspect(await resolveSource(pdf_path), { password });
      return jsonResult({ ...result }, true);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_fill',
  {
    title: 'Fill PDF form',
    description: 'Fill form fields (AcroForm) in a PDF and save or return the filled PDF. Field names must exist in the PDF (pdf_inspect lists them). All values are strings; checkboxes take "true"/"false"; dropdown/radio/optionlist values must be one of the field\'s options; text values must respect the field\'s maxLength from pdf_inspect. The source PDF is never modified. Returns the filled PDF written to output_path, or inline as an application/pdf resource when output_path is omitted; an existing file at output_path is overwritten. Owner-locked PDFs (empty user password, common for government blanks) fill without a password; a user-password PDF needs the password parameter, otherwise it is rejected with encrypted_pdf. A rejected fill writes no file at all.',
    inputSchema: {
      pdf_path: z.string().describe(`Template ${SOURCE_DOC}`),
      fields: z
        .object({})
        .catchall(z.string())
        .describe('Field name → string value (from pdf_inspect\'s fillTemplate)'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
      flatten: z
        .boolean()
        .optional()
        .describe('Bake values into page content and drop the AcroForm so fields are no longer editable'),
      password: z.string().optional().describe(PASSWORD_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { title: 'Fill PDF form', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, fields, output_path, flatten, password }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.fillForm(await resolveSource(pdf_path), fields, { flatten, password });
      return await emit(bytes, 'filled.pdf', `Filled ${describeSource(pdf_path)}`, output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_merge',
  {
    title: 'Merge PDFs',
    description: 'Merge two or more PDFs into one, in the order given, and save or return the result. Source files are read only and never modified; an existing file at output_path is overwritten. Returns the merged PDF written to output_path, or inline as an application/pdf resource when output_path is omitted. This tool only concatenates whole documents: it does not reorder, rotate or delete pages within them (pdf_extract_pages, pdf_rotate and pdf_delete_pages do), does not fill forms (pdf_fill does) and does not build documents from data (pdf_invoice does). An unreadable or rejected input fails with an error and writes no file, so a partial merge is never left behind.',
    inputSchema: {
      pdf_paths: z.array(z.string()).min(2).max(20).describe(`In order, each a ${SOURCE_DOC}`),
      password: z.string().optional().describe(`${PASSWORD_DOC} Applies to every input.`),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { title: 'Merge PDFs', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_paths, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const inputs = await resolveAll(pdf_paths, (p) => resolveSource(p), MAX_UPLOAD_BYTES, 'The PDFs');
      const bytes = await client.merge(inputs, { password });
      return await emit(bytes, 'merged.pdf', `Merged ${pdf_paths.length} PDFs`, output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_invoice',
  {
    title: 'Generate invoice PDF',
    description: 'Generate an invoice PDF from structured data (seller, buyer, line items, tax); no template needed. Deterministic: the same input produces byte-identical output. Without a paid PDFops key the output carries a small "Generated with pdfops.dev" footer line. Returns the invoice written to output_path, or inline as an application/pdf resource when output_path is omitted; an existing file at output_path is overwritten. An existing invoice PDF or a fillable template is populated with pdf_fill instead. Setting invoice.e_invoice to "factur-x" produces an e-invoice instead: a PDF/A-3 file with the invoice data embedded as factur-x.xml (UN/CEFACT Cross Industry Invoice, profile EN 16931, also called COMFORT). Several more fields then become required, and a missing one fails with einvoice_fields_required naming every missing field: invoice_number, date, currency (no default), due or payment_terms, from.country and to.country (ISO 3166-1 alpha-2 codes), from.vat_id (or from.tax_id with from.registration_id), tax_category when tax_rate is 0, and a UN/ECE Recommendation 20 unit code on every item. Amounts in the XML and on the page come from the same exact decimal arithmetic: each line is rounded to 2 decimals, VAT is computed once on the summed basis. On that path text is limited to Latin letters, Latin Extended-A, the euro sign and common punctuation (other characters fail with unrenderable_text); leading and trailing whitespace is trimmed, over-long or control-character text is refused with a 400, and long text wraps onto further lines or pages on the page and is carried in full in the XML. Per-item tax fields and other unknown fields are refused, and a buyer tax_id is refused (to.vat_id carries the buyer\'s VAT number). Checked in testing with the Mustang validator 2.26.0 (PDF/A-3 via veraPDF, XSD, EN 16931 schematron); this is not a statement of legal compliance, and XRechnung and Peppol output are not produced.',
    inputSchema: {
      invoice: z
        .looseObject({
          from: z.union([z.string(), INVOICE_PARTY]),
          to: z.union([z.string(), INVOICE_PARTY]),
          items: z
            .array(
              z.looseObject({
                description: z.string(),
                quantity: z.number().positive().optional(),
                unit_price: z.number().nonnegative(),
                unit: z.string().max(3).optional().describe('UN/ECE Recommendation 20 unit code, for example C62 (one), HUR (hour), KGM (kilogram). Required when e_invoice is set.'),
              }),
            )
            .min(1)
            .max(100),
          invoice_number: z.string().optional(),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe('Calendar date in YYYY-MM-DD form (other formats are rejected with invalid_date). Shown on the invoice; also pins metadata for determinism'),
          due: z.string().optional().describe('Shown as given. With e_invoice it must be a calendar date in YYYY-MM-DD form.'),
          currency: z.string().regex(/^[A-Z]{3}$/).optional(),
          tax_rate: z.number().min(0).max(100).optional(),
          notes: z.string().max(1000).optional(),
          e_invoice: z.enum(['factur-x']).optional().describe('Produce a Factur-X (ZUGFeRD) EN 16931 e-invoice: PDF/A-3 with factur-x.xml embedded. Makes several fields required, see the tool description.'),
          tax_category: z
            .enum(['S', 'Z', 'E', 'AE', 'O'])
            .optional()
            .describe('EN 16931 VAT category: S standard rate (the default when tax_rate is above 0), Z zero rate, E exempt, AE reverse charge, O not subject to VAT. Required with e_invoice when tax_rate is 0 or omitted. Ignored without e_invoice.'),
          tax_exemption_reason: z.string().max(200).optional().describe('Reason text, required with e_invoice for tax_category E, AE and O.'),
          payment_terms: z.string().max(200).optional().describe('Payment terms text. With e_invoice, either this or a due date is required.'),
          iban: z.string().optional().describe('IBAN to pay into; the checksum is verified. Used only with e_invoice: written as SEPA credit transfer (code 58) for a EUR invoice and a SEPA-area IBAN, otherwise as credit transfer (code 30).'),
      })
        .describe('Invoice data'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { title: 'Generate invoice PDF', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ invoice, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.invoice(invoice);
      const name = invoice.invoice_number ? `invoice-${invoice.invoice_number.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)}.pdf` : 'invoice.pdf';
      return await emit(bytes, name, 'Invoice', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdfops_usage',
  {
    title: 'Check PDFops quota',
    description: 'Check the current PDFops API quota for the configured key: tier, limit, used, remaining, the billing period, and the reset timestamp. Read-only and safe to call before a batch to confirm there is headroom. Requires PDFOPS_API_KEY.',
    inputSchema: {},
    outputSchema: {
      tier: z.string().describe('Plan name, e.g. free'),
      limit: z.number().int().describe('Calls allowed in the current period'),
      used: z.number().int(),
      remaining: z.number().int(),
      period: z.string().describe('Billing period the counts belong to, YYYY-MM'),
      resets_at: z.string().describe('ISO 8601 timestamp when used resets to 0'),
    },
    annotations: { title: 'Check PDFops quota', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const usage = await client.usage();
      return jsonResult({ ...usage }, true);
    } catch (e) {
      return fail(e);
    }
  },
);

const PAGES_DOC = '1-based page spec such as "1-3,5"; default all pages';
const OUT_TAIL =
  'Returns the result written to output_path, or inline as an application/pdf resource when output_path is omitted (results over 7 MB are never returned inline and need output_path); an existing file at output_path is overwritten. The source is never modified.';
// destructiveHint: true because output_path / output_dir overwrite existing files (TASK-409).
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

server.registerTool(
  'pdf_extract_pages',
  {
    title: 'Extract pages from PDF',
    description: `Extract pages from a PDF: keep only the listed pages, in the order given, and return them as a new PDF. Because order follows the spec, it also reorders pages ("3,1,2") and can duplicate them. It pulls a section out of a document; pdf_delete_pages removes pages instead, pdf_split makes several output files and pdf_merge joins documents. ${OUT_TAIL} Fails with invalid_pages if a page is out of range.`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      pages: z.string().describe('1-based page spec, e.g. "1-3,5,8-" (open-ended range runs to the last page)'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Extract pages from PDF' },
  },
  async ({ pdf_path, pages, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.extractPages(await resolveSource(pdf_path), pages, { password });
      return await emit(bytes, 'extracted.pdf', 'Extracted pages', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_delete_pages',
  {
    title: 'Delete pages from PDF',
    description: `Delete pages from a PDF: remove the listed pages and return the remaining pages in their original order, for example to drop a cover, blank or sensitive pages. pdf_extract_pages takes the opposite approach and names the pages to keep. ${OUT_TAIL} Deleting every page fails with no_pages_left.`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      pages: z.string().describe('1-based pages to REMOVE, e.g. "2,4-6,9-"'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Delete pages from PDF' },
  },
  async ({ pdf_path, pages, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.deletePages(await resolveSource(pdf_path), pages, { password });
      return await emit(bytes, 'trimmed.pdf', 'PDF with pages deleted', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_rotate',
  {
    title: 'Rotate PDF pages',
    description: `Rotate pages of a PDF clockwise by 90, 180 or 270 degrees (or -90). Rotation adds to each page's existing rotation. Omit pages to rotate every page. It fixes sideways scans. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      degrees: z
        .union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)])
        .describe('Clockwise rotation to add'),
      pages: z.string().optional().describe(PAGES_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Rotate PDF pages' },
  },
  async ({ pdf_path, degrees, pages, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.rotate(await resolveSource(pdf_path), degrees, { pages, password });
      return await emit(bytes, 'rotated.pdf', 'Rotated PDF', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_split',
  {
    title: 'Split PDF into parts',
    description:
      'Split one PDF into several PDFs, either by explicit ranges (each comma group becomes one part: "1-2,3-5" gives two parts) or into fixed-size chunks (every=2 on 5 pages gives 1-2, 3-4, 5). Give exactly one of ranges or every. With output_dir the parts are written there as part-1.pdf, part-2.pdf, …; otherwise each part comes back inline as an application/pdf resource. Either way the result also includes a structured parts list (pages, page_count, bytes, and output_path or resource_uri). Existing part-N.pdf files with those names are overwritten, and part-N.pdf files from earlier runs in that directory are left as they are; the source is never modified. Limited to 100 parts and about 4 MB of total output; pdf_extract_pages returns a single range as one PDF.',
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      ranges: z.string().optional().describe('1-based page spec; each comma group becomes one part, e.g. "1-2,3-5"'),
      every: z.number().int().min(1).optional().describe('Chunk size in pages; the last part may be shorter'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_dir: z
        .string()
        .optional()
        .describe('Path of an existing directory inside the allowed directories (PDFOPS_ROOT, default the working directory) to write part-1.pdf, part-2.pdf, … into. Without it (as when running remotely) the parts are returned inline as application/pdf resources.'),
    },
    outputSchema: {
      count: z.number().int().describe('Number of parts produced'),
      parts: z.array(
        z.object({
          pages: z.string(),
          page_count: z.number().int(),
          bytes: z.number().int(),
          output_path: z.string().optional().describe('Absolute path written, when output_dir was supplied'),
          resource_uri: z.string().optional().describe("pdfops:// uri of this part's inline application/pdf resource, when output_dir was omitted"),
        }),
      ),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Split PDF into parts' },
  },
  async ({ pdf_path, ranges, every, password, output_dir }) => {
    try {
      if (output_dir) output_dir = await checkOutputDir(output_dir);
      const input = await resolveSource(pdf_path);
      // Neither/both given is passed through so the API answers with invalid_split.
      const opts = { ranges, every, password } as { ranges: string; password?: string };
      const result = await client.split(input, opts);
      if (!result.parts.every((p) => startsWithPdf(p.pdf))) throw new Error('The API response is not a PDF; refusing to use it');
      // Response, part paths and write access are checked before the first part is written. A failure in the
      // middle of the writes (a full disk, say) can still leave the earlier parts behind.
      if (
        result.parts.length === 0 ||
        result.parts.length > 100 ||
        result.count !== result.parts.length ||
        !result.parts.every((p) => typeof p.pages === 'string' && Number.isSafeInteger(p.page_count) && p.page_count > 0)
      ) {
        throw new Error('The API response is not a valid split result; refusing to use it');
      }
      if (output_dir) {
        for (const i of result.parts.keys()) {
          const target = join(output_dir, `part-${i + 1}.pdf`);
          await checkOutputPath(target);
          assertWritable(target, output_dir);
        }
      }
      if (!output_dir && result.parts.reduce((n, p) => n + p.pdf.byteLength, 0) > MAX_INLINE_BYTES) {
        throw tooBigInline(result.parts.reduce((n, p) => n + p.pdf.byteLength, 0));
      }
      if (output_dir) {
        const parts = [];
        for (const [i, p] of result.parts.entries()) {
          const output_path = join(output_dir, `part-${i + 1}.pdf`);
          try {
            await writeOutputPdf(output_path, p.pdf);
          } catch (e) {
            const done = parts.length ? parts.map((x) => x.output_path).join(', ') : 'none';
            throw new Error(`Writing ${output_path} failed (${e instanceof Error ? e.message : String(e)}). Parts written before the failure: ${done}.`);
          }
          parts.push({ pages: p.pages, page_count: p.page_count, bytes: p.pdf.byteLength, output_path });
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Split into ${result.count} PDFs written to ${output_dir}: ${parts.map((p) => p.output_path).join(', ')}`,
            },
          ],
          structuredContent: { count: result.count, parts },
        };
      }
      const parts = result.parts.map((p, i) => ({
        pages: p.pages,
        page_count: p.page_count,
        bytes: p.pdf.byteLength,
        resource_uri: `pdfops://part-${i + 1}.pdf`,
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Split into ${result.count} PDFs, returned inline as ${parts.map((p) => p.resource_uri).join(', ')} — no output_dir was given. Save the attached application/pdf resources; pass output_dir to write to disk instead.`,
          },
          ...result.parts.map((p, i) => ({
            type: 'resource' as const,
            resource: {
              uri: parts[i].resource_uri,
              mimeType: 'application/pdf',
              blob: Buffer.from(p.pdf).toString('base64'),
            },
          })),
        ],
        structuredContent: { count: result.count, parts },
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_watermark',
  {
    title: 'Add text watermark to PDF',
    description: `Add a diagonal text watermark to pages of a PDF (default: centered, 45 degrees, grey, 15% opacity). Text is upright and centered for any page size or existing page rotation. Standard Helvetica only: characters outside WinAnsi (e.g. CJK, emoji) fail with unsupported_characters. Typical text is DRAFT or CONFIDENTIAL; pdf_page_numbers adds page numbers instead. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      text: z.string().max(200).describe('Watermark text, WinAnsi characters only'),
      opacity: z.number().min(0.05).max(1).optional().describe('Default 0.15'),
      size: z.number().min(6).max(200).optional().describe('Font size in points, default 48'),
      color: z.string().optional().describe('Hex #rgb or #rrggbb, default #808080'),
      rotation: z.number().optional().describe('Degrees counter-clockwise as the viewer sees it, default 45'),
      position: z.enum(['center', 'top', 'bottom']).optional().describe('Default center'),
      pages: z.string().optional().describe(PAGES_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Add text watermark to PDF' },
  },
  async ({ pdf_path, text, output_path, ...opts }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.watermark(await resolveSource(pdf_path), text, opts);
      return await emit(bytes, 'watermarked.pdf', 'Watermarked PDF', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_page_numbers',
  {
    title: 'Add page numbers to PDF',
    description: `Add page numbers to a PDF using a format template with {n} (page number) and {total} (page count), e.g. "Page {n} of {total}". Default is "{n} / {total}" at bottom-center, 10 pt. Numbers sit upright for any page size or rotation. Standard Helvetica only (WinAnsi characters). Page i always shows start+i-1 even when pages selects only some pages. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      format: z.string().max(100).optional().describe('Template with {n} and {total}, default "{n} / {total}"'),
      position: z
        .enum(['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'])
        .optional()
        .describe('Default bottom-center'),
      size: z.number().min(4).max(72).optional().describe('Font size in points, default 10'),
      start: z.number().int().min(0).max(100000).optional().describe('Number shown on page 1, default 1'),
      margin: z.number().min(0).max(200).optional().describe('Distance in points from the page edge, default 24'),
      pages: z.string().optional().describe(PAGES_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Add page numbers to PDF' },
  },
  async ({ pdf_path, output_path, ...opts }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.pageNumbers(await resolveSource(pdf_path), opts);
      return await emit(bytes, 'numbered.pdf', 'Numbered PDF', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_unlock',
  {
    title: 'Remove PDF restrictions',
    description: `Remove a PDF's password protection and its print/copy/modify restrictions by saving an unencrypted copy. Works for owner-locked files (empty user password) with no password, and for user-password files when you pass the password. It does NOT crack unknown passwords: a wrong or missing user password fails with encrypted_pdf. A PDF that was not encrypted is returned re-saved, with note "not-encrypted". ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: {
      ...PDF_OUTPUT,
      note: z.string().optional().describe('Present as "not-encrypted" when the input had no encryption'),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Remove PDF restrictions' },
  },
  async ({ pdf_path, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const { pdf: bytes, note } = await client.unlock(await resolveSource(pdf_path), password);
      const out = await emit(bytes, 'unlocked.pdf', 'Unlocked PDF', output_path);
      return note === 'not-encrypted' ? { ...out, structuredContent: { ...out.structuredContent, note } } : out;
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_protect',
  {
    title: 'Password-protect PDF',
    description: `Encrypt a PDF with a password. user_password is required to open the result; owner_password lifts the permission restrictions. Give at least one (each 1 to 32 Latin-1 chars). permissions lists what stays ALLOWED from print, copy, modify, annotate, fill-forms (default all, except modify when an owner password is set; an empty list allows none). Restrictions only bind viewers when an owner password is set. Not byte-deterministic (random salts). ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      user_password: z.string().max(32).optional().describe('Password required to open the output'),
      owner_password: z.string().max(32).optional().describe('Password that lifts the restrictions'),
      permissions: z
        .array(z.enum(['print', 'copy', 'modify', 'annotate', 'fill-forms']))
        .optional()
        .describe('Actions to ALLOW; omit for the default, [] for none'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false, title: 'Password-protect PDF' },
  },
  async ({ pdf_path, user_password, owner_password, permissions, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await client.protect(await resolveSource(pdf_path), {
        userPassword: user_password,
        ownerPassword: owner_password,
        permissions,
        password,
      });
      return await emit(bytes, 'protected.pdf', 'Protected PDF', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_metadata',
  {
    title: 'Read PDF metadata',
    description:
      "Read a PDF's document info: page_count, per-page width/height (points) and rotation, title, author, subject, keywords, creator, producer, creation_date, modification_date (ISO 8601, null when absent), whether it was encrypted, and has_form / form_field_count. The page count and per-page sizes describe a document's shape for splitting, rotating or filling. Read-only: the PDF is fetched or read but never modified.",
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
    },
    outputSchema: z
      .object({
        page_count: z.number().int(),
        pages: z.array(z.object({ width: z.number(), height: z.number(), rotation: z.number() })),
        title: z.string().nullable(),
        author: z.string().nullable(),
        subject: z.string().nullable(),
        keywords: z.string().nullable(),
        creator: z.string().nullable(),
        producer: z.string().nullable(),
        creation_date: z.string().nullable(),
        modification_date: z.string().nullable(),
        encrypted: z.boolean(),
        has_form: z.boolean(),
        form_field_count: z.number().int(),
        form_field_count_capped: z.boolean().optional().describe('True when the form-field count stopped at the 2,000 cap, so the real number may be higher'),
      })
      .loose(),
    annotations: { title: 'Read PDF metadata', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, password }) => {
    try {
      const result = await client.metadata(await resolveSource(pdf_path), { password });
      return jsonResult({ ...result }, true);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_set_metadata',
  {
    title: 'Set PDF metadata',
    description: `Write document info fields (title, author, subject, creator, keywords) into a PDF. Give at least one; an empty string sets an empty value. Unicode is fine. Keywords may be a list or a comma-separated string. The output is saved unencrypted. pdf_metadata reads the current values. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      title: z.string().max(1000).optional(),
      author: z.string().max(1000).optional(),
      subject: z.string().max(1000).optional(),
      creator: z.string().max(1000).optional(),
      keywords: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated string or list of keywords'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Set PDF metadata' },
  },
  async ({ pdf_path, output_path, keywords, ...opts }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const list = typeof keywords === 'string' ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : keywords;
      const bytes = await client.setMetadata(await resolveSource(pdf_path), { ...opts, keywords: list });
      return await emit(bytes, 'retitled.pdf', 'PDF with updated metadata', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- Tools backed by endpoints the pdfops-sdk has no method for ----
// The SDK stops at /api/metadata and /api/set-metadata, so these call the REST routes directly with
// the same headers and error type the SDK uses. Every body is built the way the hosted server
// (src/api/mcp.ts) builds it, so both servers send the API identical requests.

const API_BASE = (BASE_URL || 'https://pdfops.dev').replace(/\/$/, '');

const api = async (path: string, init: { body: FormData | string; json?: boolean }): Promise<Response> => {
  const headers = new Headers({ 'X-Pdfops-Client': 'mcp', 'X-Pdfops-Client-Version': version });
  if (process.env.PDFOPS_API_KEY) headers.set('X-API-Key', process.env.PDFOPS_API_KEY);
  const host = hostTag();
  if (host) headers.set('X-Pdfops-Client-Host', host);
  if (init.json) headers.set('content-type', 'application/json');
  const res = capResponse(await apiFetch(`${API_BASE}${path}`, { method: 'POST', headers, body: init.body }), MAX_API_RESPONSE_BYTES);
  if (!res.ok) {
    let code = `http_${res.status}`;
    let details = res.statusText;
    let errBody: unknown;
    try {
      const body = (await res.json()) as { error?: string; details?: string };
      errBody = body;
      if (typeof body.error === 'string' && body.error) code = body.error;
      if (typeof body.details === 'string' && body.details) details = body.details;
    } catch {
      // not JSON: keep the status text
    }
    // The parsed body is untrusted: callers read it key by key and validate every value (see pdf_add_fields detect).
    throw Object.assign(new PdfOpsError(res.status, capText(code), capText(details)), { body: errBody });
  }
  return res;
};

const bytesOf = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());
const pdfBlob = (b: Uint8Array): Blob => new Blob([Uint8Array.from(b)], { type: 'application/pdf' });
const fileBlob = (b: Uint8Array): Blob => new Blob([Uint8Array.from(b)]);

// A JSON result travels twice (text and structuredContent) and the MCP stdio transport buffers 10 MB per
// message, so a large result would kill the session instead of failing the call.
const MAX_JSON_BYTES = 3_500_000;
const jsonResult = (value: Record<string, unknown>, pretty = false) => {
  const text = JSON.stringify(value, null, pretty ? 2 : undefined);
  const bytes = new TextEncoder().encode(text).length; // bytes, not UTF-16 units: multi-byte text is what overflows
  if (bytes > MAX_JSON_BYTES) {
    throw new Error(`The result is ${bytes} bytes of JSON, over the ${MAX_JSON_BYTES} byte limit this server can return. Ask for less (pages, max_hits, include_lines).`);
  }
  return { content: [{ type: 'text' as const, text }], structuredContent: value };
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Response headers are untrusted. Each validator returns a safe value (or nothing), so the caller can
// compute every extra before any file is written and none of them can fail a call afterwards.
// A page spec ("1-3,5,9-") from the API. Up to 2,000 pages can be left, so the odd pages of a long file are about 9 KB.
const SPEC = /^[0-9,-]{1,10000}$/;
// Page numbers (untrusted) as the {page, reason} entries pdf_detect_fields returns.
const skippedPages = (items: { page?: unknown; reason?: unknown }[]): { page: number; reason: 'too_complex' | 'deadline' }[] =>
  items
    .map((k) => ({ page: Number(k.page), reason: k.reason === 'deadline' ? ('deadline' as const) : ('too_complex' as const) }))
    .filter((k) => Number.isInteger(k.page) && k.page > 0 && k.page <= 100000)
    .slice(0, 2000);
const intHeader = (v: string | null): number | undefined => (v !== null && /^\d{1,9}$/.test(v) ? Number(v) : undefined);

const warningHeader = (v: string | null): string | undefined =>
  v === null ? undefined : /^xfa-layer-dropped(;|$)/.test(v) ? 'xfa-layer-dropped' : 'The API sent a warning this server does not recognise.';

// Attachment lookup keys: exactly one per file sent, each printable ASCII without spaces. The header is
// untrusted, so only the keys are taken from it and they are paired with the caller's own file names.
const keysHeader = (v: string | null, count: number): string[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(v ?? '[]');
    if (!Array.isArray(parsed) || parsed.length !== count) return undefined;
    const keys: string[] = [];
    for (const k of parsed) {
      const key = k && typeof k === 'object' ? (k as { key?: unknown }).key : undefined;
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(key)) return undefined;
      keys.push(key);
    }
    return keys;
  } catch {
    return undefined;
  }
};

const TRUNCATED_BY = ['pages', 'output', 'sheets', 'columns', 'rows'] as const;
const truncatedByHeader = (v: string | null): (typeof TRUNCATED_BY)[number][] =>
  (v ?? '').split(',').filter((k): k is (typeof TRUNCATED_BY)[number] => (TRUNCATED_BY as readonly string[]).includes(k));

// A produced PDF plus extra structured fields (warning, keys, pages, ...).
const emitWith = async (bytes: Uint8Array, name: string, summary: string, output_path: string | undefined, extra: Record<string, unknown>) => {
  const out = await emit(bytes, name, summary, output_path);
  return Object.keys(extra).length ? { ...out, structuredContent: { ...out.structuredContent, ...extra } } : out;
};

const FILE_SOURCE_DOC =
  'Image source: a path to a .png, .jpg or .jpeg file inside the allowed directories (PDFOPS_ROOT, default the working directory), an https:// URL, or a data:image/png;base64,… or data:image/jpeg;base64,… URI. A URL or data URI works when this server runs remotely.';

server.registerTool(
  'pdf_edit',
  {
    title: 'Add text, images or barcodes to a PDF',
    description: `Add text, images (logos, signature images, photos) and barcodes or QR codes to specific pages of an existing PDF at exact positions. Coordinates are PDF points measured from the bottom-left corner of the page as the viewer sees it (1 inch = 72 pt; US Letter is 612 x 792), so stamps land upright on any page size or rotation. Text uses standard fonts (WinAnsi characters only: CJK and emoji fail with unsupported_characters) and can wrap to max_width. Images are PNG or JPEG, up to 2 MB each and 10 distinct images per call (the PDF and all images together must stay under 4.5 MB), given as a local path, an https:// URL or a data:image/png;base64,... URI. Barcodes (QR, Data Matrix, PDF417, Aztec, Code 128, Code 39, EAN-13/8, UPC-A, ITF-14, Interleaved 2 of 5, GS1-128) are generated from a value and drawn as vector paths, so they scan at any print size (up to 25 per call). pdf_fill sets fillable form fields and pdf_watermark stamps a diagonal text on every page. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      items: z
        .array(
          z.strictObject({
            type: z.enum(['text', 'image', 'barcode']),
            page: z.number().int().min(1).describe('1-based page number'),
            x: z.number().describe("Points from the left edge. Text: left of the first line's baseline. Image or barcode: left edge."),
            y: z.number().describe("Points from the bottom edge. Text: the first line's baseline. Image or barcode: bottom edge."),
            text: z.string().max(2000).optional().describe('type=text: the text; \\n starts a new line'),
            size: z.number().min(4).max(200).optional().describe('type=text: font size in points, default 12'),
            color: z.string().optional().describe('type=text or barcode: hex #rgb or #rrggbb, default #000000'),
            font: z
              .enum(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Times-Roman', 'Times-Bold', 'Courier'])
              .optional()
              .describe('type=text: default Helvetica'),
            rotation: z.number().min(-360).max(360).optional().describe('type=text: degrees counter-clockwise as the viewer sees it, default 0'),
            max_width: z.number().min(1).optional().describe('type=text: wrap words to this width in points'),
            line_height: z.number().min(0.5).max(5).optional().describe('type=text: line spacing as a multiple of size, default 1.2'),
            image: z.string().optional().describe(`type=image: PNG or JPEG. ${FILE_SOURCE_DOC}`),
            format: z
              .enum(['qrcode', 'datamatrix', 'pdf417', 'azteccode', 'code128', 'code39', 'ean13', 'ean8', 'upca', 'itf14', 'interleaved2of5', 'gs1-128'])
              .optional()
              .describe('type=barcode: symbology'),
            value: z
              .string()
              .max(3000)
              .optional()
              .describe('type=barcode: data to encode; format rules apply (ean13 = 12 or 13 digits, gs1-128 = bracketed AIs like (01)09506000134352)'),
            include_text: z.boolean().optional().describe('type=barcode: print the human-readable value under linear codes, default false'),
            error_correction: z.enum(['L', 'M', 'Q', 'H']).optional().describe('type=barcode, qrcode only: error correction level, default M'),
            background: z.string().optional().describe('type=barcode: optional hex fill behind the symbol; no quiet zone is added, so leave a margin'),
            width: z
              .number()
              .min(0.1)
              .optional()
              .describe('type=image or barcode: width in points. Images and 2D codes: give only width or height to keep the aspect ratio (2D codes default to 72 pt). Linear codes: a missing side keeps 1 pt per module and 1 inch tall'),
            height: z.number().min(0.1).optional().describe('type=image or barcode: height in points'),
            opacity: z.number().min(0.05).max(1).optional().describe('Default 1'),
          }),
        )
        .min(1)
        .max(100)
        .describe('Stamps to draw, in order (later items draw on top).'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Add text, images or barcodes to a PDF' },
  },
  async ({ pdf_path, items, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      // minLength is not advertised in the schema (some MCP clients reject it), so it is enforced here.
      items.forEach((it, i) => {
        if (it.text === '') throw new Error(`items[${i}].text must not be empty`);
        if (it.value === '') throw new Error(`items[${i}].value must not be empty`);
      });
      // REST takes images as extra multipart file fields named by each item.
      const fields = new Map<string, string>();
      const apiItems = items.map(({ max_width, line_height, include_text, error_correction, image, ...rest }) => {
        const out: Record<string, unknown> = { ...rest };
        if (max_width !== undefined) out.maxWidth = max_width;
        if (line_height !== undefined) out.lineHeight = line_height;
        if (include_text !== undefined) out.includeText = include_text;
        if (error_correction !== undefined) out.errorCorrection = error_correction;
        if (out.type === 'image' && image !== undefined) {
          if (!fields.has(image)) fields.set(image, `img${fields.size + 1}`);
          out.image = fields.get(image);
        }
        return out;
      });
      if (fields.size > 10) throw new Error('too_many_items: at most 10 distinct images per call');
      const fd = new FormData();
      const pdf = await resolveSource(pdf_path);
      fd.append('pdf', pdfBlob(pdf), 'input.pdf');
      if (password !== undefined) fd.append('password', password);
      fd.append('items', JSON.stringify(apiItems));
      const entries = [...fields];
      const images = await resolveAll(entries.map(([src]) => src), (src) => resolveImage(src), MAX_UPLOAD_BYTES, 'The images');
      assertUploadFits(pdf, images, 'The PDF and images', [JSON.stringify(apiItems), password ?? '']);
      entries.forEach(([, field], i) => fd.append(field, fileBlob(images[i]), field));
      const bytes = await bytesOf(await api('/api/edit', { body: fd }));
      return await emit(bytes, 'edited.pdf', 'Edited PDF', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

server.registerTool(
  'pdf_extract_text',
  {
    title: 'Extract text and tables from a PDF',
    description: `Extract text and tables from a born-digital PDF (one made by software: invoices, statements, reports, contracts, forms), page by page, in reading order, plus any tables found from the text layout as rows of cells. Scanned PDFs (images of pages) have no text layer and come back listed in pages_without_text: OCR is not supported. Set include_lines to also get each line with its position in PDF points from the bottom-left of the page as the viewer sees it, the same frame pdf_edit uses, so you can stamp text next to something you found. Up to 200 pages per call; pass pages to read a large document in parts. pdf_find_text searches for specific text. With tables_format xlsx the tables come back as one Excel workbook instead (one sheet per table, all cells text): written to output_path (a .xlsx file) when given, otherwise returned inline as an application/vnd.openxmlformats-officedocument.spreadsheetml.sheet resource (a workbook over 7 MB is never returned inline and needs output_path). The source PDF is never modified; output_path is only written with tables_format xlsx.`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      pages: z.string().optional().describe('Pages to read, 1-based: "1-3,5,8-". Default: all pages.'),
      include_lines: z.boolean().optional().describe('Also return every line of text with x, y, width and font size in points. Default false (smaller output).'),
      tables_format: z
        .enum(['json', 'csv', 'xlsx'])
        .optional()
        .describe(
          'csv adds a csv string (RFC 4180, CRLF line ends) to each table next to rows. xlsx instead returns one Excel workbook, one sheet per table ("Page 3 Table 1"), with a short summary (no text, lines or rows); every cell is a text string, never a formula, and numbers are not converted. xlsx fails with no_tables when the pages read have no table (if the read stopped early the error says so and names the pages value to continue with). Default json. In csv cell values are returned verbatim: a cell starting with = + - or @ can run as a formula if the CSV is opened in a spreadsheet, so sanitise before opening.',
        ),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z
        .string()
        .optional()
        .describe('Only with tables_format xlsx: path of a .xlsx file to write the workbook to, inside the allowed directories (PDFOPS_ROOT, default the working directory); an existing file there is overwritten. Without it (as when running remotely) the workbook is returned inline as a resource for the client to save.'),
    },
    outputSchema: {
      page_count: z.number().int().optional().describe('Pages in the document'),
      pages: z
        .array(
          z.object({
            page: z.number().int(),
            width: z.number(),
            height: z.number(),
            text: z.string(),
            tables: z.array(
              z.object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
                rows: z.array(z.array(z.string())),
                csv: z.string().optional().describe('Present only with tables_format=csv'),
              }),
            ),
            lines: z
              .array(z.object({ text: z.string(), x: z.number(), y: z.number(), width: z.number(), font_size: z.number() }))
              .optional()
              .describe('Present only with include_lines'),
          }),
        )
        .optional(),
      pages_without_text: z.array(z.number().int()).optional(),
      truncated: z.boolean().optional(),
      bytes: z.number().int().optional().describe('Only with tables_format=xlsx: size of the workbook'),
      output_path: z.string().optional().describe('Only with tables_format=xlsx: absolute path written, when output_path was supplied'),
      resource_uri: z.string().optional().describe('Only with tables_format=xlsx: where the workbook resource is attached, when output_path was omitted'),
      cells_truncated: z.boolean().optional().describe('Only with tables_format=xlsx: a cell over 32,767 characters was cut'),
      truncated_by: z.array(z.enum(['pages', 'output', 'sheets', 'columns', 'rows'])).optional().describe('Only with tables_format=xlsx and truncated: which cap stopped the read or cut the workbook'),
    },
    annotations: { title: 'Extract text and tables from a PDF', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, pages, include_lines, tables_format, password, output_path }) => {
    try {
      if (output_path && tables_format !== 'xlsx') throw new Error('output_path is only used with tables_format xlsx');
      if (output_path) await checkOutputXlsx(output_path);
      const fd = new FormData();
      fd.append('pdf', pdfBlob(await resolveSource(pdf_path)), 'input.pdf');
      if (pages !== undefined) fd.append('pages', pages);
      if (password !== undefined) fd.append('password', password);
      if (tables_format !== undefined) fd.append('tables_format', tables_format);
      const res = await api('/api/extract-text', { body: fd });
      if (tables_format === 'xlsx') {
        // The one non-PDF output. It is written to an .xlsx output_path, or attached inline with the
        // xlsx media type, so it never goes through the PDF-only writer.
        const xlsx = await bytesOf(res);
        if (!looksLikeXlsx(xlsx)) throw new Error('The API response is not an xlsx workbook; refusing to use it');
        if (!output_path && xlsx.byteLength > MAX_INLINE_BYTES) throw tooBigInline(xlsx.byteLength);
        const truncated = res.headers.get('x-pdfops-truncated') === 'true';
        const by = truncatedByHeader(res.headers.get('x-pdfops-truncated-by'));
        const cellsTruncated = res.headers.get('x-pdfops-cells-truncated') === 'true';
        const capWhy: Record<string, string> = {
          pages: 'the 200-page cap',
          output: 'the output size cap',
          sheets: 'the 1,000-sheet cap',
          columns: 'the 16,384-column cap (wider tables lost their extra columns)',
          rows: 'the 1,048,576-row cap',
        };
        const stopped = by.filter((k) => k === 'pages' || k === 'output');
        const notes =
          (truncated ? ` Truncated by ${by.map((k) => capWhy[k] ?? k).join(' and ')}.${stopped.length > 0 ? ' Read the rest with pages.' : ''}` : '') +
          (cellsTruncated ? ' A cell over 32,767 characters was cut.' : '');
        const shared = { bytes: xlsx.byteLength, truncated, cells_truncated: cellsTruncated, ...(by.length > 0 ? { truncated_by: by } : {}) };
        const what = `Tables as an Excel workbook, one sheet per table, every cell text (${xlsx.byteLength} bytes)`;
        if (output_path) {
          const written = await writeOutputXlsx(output_path, xlsx);
          return {
            content: [{ type: 'text' as const, text: `${what} written to ${written}.${notes}` }],
            structuredContent: { ...shared, output_path: written },
          };
        }
        const uri = 'pdfops://tables.xlsx';
        return {
          content: [
            { type: 'text' as const, text: `${what}, returned inline as ${uri}. Save the attached resource as .xlsx; pass output_path to write to disk instead.${notes}` },
            { type: 'resource' as const, resource: { uri, mimeType: XLSX_MIME, blob: Buffer.from(xlsx).toString('base64') } },
          ],
          structuredContent: { ...shared, resource_uri: uri },
        };
      }
      const body = (await res.json()) as {
        pageCount: number;
        pages: { lines: { fontSize: number }[]; [k: string]: unknown }[];
        pagesWithoutText: number[];
        truncated: boolean;
      };
      return jsonResult({
        page_count: body.pageCount,
        pages: body.pages.map(({ lines, ...p }) =>
          include_lines === true ? { ...p, lines: lines.map(({ fontSize, ...l }) => ({ ...l, font_size: fontSize })) } : p,
        ),
        pages_without_text: body.pagesWithoutText,
        truncated: body.truncated,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_text_to_pdf',
  {
    title: 'Create a PDF from Markdown, plain text or CSV',
    description: `Create a new PDF from Markdown, plain text or a CSV table, with no template and no input PDF. This is NOT HTML-to-PDF: it does not render HTML or CSS, and it has no custom fonts or images (images in Markdown stay literal text). Text is set in the standard Helvetica family, code and monospace text in Courier, on Letter or A4 pages. Markdown supports headings 1-6, bold, italic, inline code, links (printed as text plus the URL; http(s) and mailto links are also clickable), fenced code blocks, bullet and numbered lists, one-level blockquotes, horizontal rules, pipe tables (header shaded and repeated per page; column alignment ignored) and \\pagebreak; anything else prints as typed. format text keeps spaces and line breaks exactly. format csv draws a table whose first row is the header (up to 20 columns, 10,000 rows, 100,000 cells). content is capped at 512 KiB and the output at 200 pages. WinAnsi characters only (English and Western European letters and common punctuation): emoji, Cyrillic, Greek and CJK fail with unsupported_characters, naming the character and its line and column. Very large tables or heavy inline formatting fail with content_too_complex. Deterministic: the same input gives byte-identical output, and the PDF carries no PDFops footer. pdf_edit adds text to an existing PDF and pdf_invoice builds an invoice from data. ${OUT_TAIL}`,
    inputSchema: {
      content: z.string().describe('The document: Markdown (default), plain text or CSV, up to 512 KiB of UTF-8.'),
      format: z.enum(['markdown', 'text', 'csv']).optional().describe('How to read content. Default markdown.'),
      page_size: z.enum(['a4', 'letter']).optional().describe('Default letter.'),
      margin: z.number().min(18).max(144).optional().describe('Page margin in points, 18-144. Default 54.'),
      font_size: z.number().min(6).max(36).optional().describe('Body text size in points, 6-36. Default 11.'),
      title: z.string().max(200).optional().describe('PDF Title metadata (not printed on the page), up to 200 characters.'),
      page_numbers: z.boolean().optional().describe('Print "Page n of N" at the bottom of every page. Default false.'),
      monospace: z.boolean().optional().describe('Set the text in Courier. Only used with format text. Default false.'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Create a PDF from Markdown, plain text or CSV' },
  },
  async ({ output_path, ...body }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const bytes = await bytesOf(await api('/api/text-to-pdf', { body: JSON.stringify(body), json: true }));
      return await emit(bytes, 'document.pdf', 'PDF', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_find_text',
  {
    title: 'Find text in a PDF',
    description:
      "Find text in a PDF: search a born-digital PDF (one made by software: invoices, statements, reports, contracts, forms) for a word, phrase or pattern and get each hit with its page and box in PDF points from the bottom-left of the page as the viewer sees it, y on the text baseline: the same frame pdf_edit uses, so a hit's x, y, width and height tell you where to stamp. Case-insensitive unless case_sensitive is true. Set regex to treat query as a regular expression from a safe subset (literals, classes, dot, anchors, word boundaries, groups, alternation, quantifiers including lazy ones); backreferences, lookahead, lookbehind, named groups, property escapes and inline flags are rejected. A match never spans lines. Scanned PDFs have no text layer: their pages are listed in pages_without_text (no OCR). A long search continues across calls through next_page (see the pages argument). Read-only: the source is never modified.",
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      query: z.string().max(200).describe('Text to find, or a pattern when regex is true. At most 200 characters.'),
      regex: z.boolean().optional().describe('Treat query as a regular expression (the supported subset). Default false.'),
      case_sensitive: z.boolean().optional().describe('Default false: matching ignores case.'),
      whole_word: z.boolean().optional().describe('Only report matches with no letter, digit, underscore or combining mark directly before or after. Default false.'),
      pages: z.string().optional().describe('Pages to search, 1-based: "1-3,5,8-". Default: all pages. At most 200 pages per call. While next_page in the result is not null, calling again with pages set to next_page followed by a dash (for example 4-) continues with no gaps or repeated hits.'),
      max_hits: z.number().int().min(1).max(1000).optional().describe('Stop once more hits than this exist. Default 100. If truncated is true but next_page is null, hits on a page listed in pages_skipped beyond max_hits can be retrieved only by raising max_hits or narrowing the query.'),
      password: z.string().optional().describe(PASSWORD_DOC),
    },
    outputSchema: {
      count: z.number().int().describe('Hits returned'),
      truncated: z
        .boolean()
        .describe('The scan stopped before every selected page was searched; continue from next_page while it is not null; null with truncated means hits beyond max_hits on a page in pages_skipped were dropped'),
      hits: z.array(
        z.object({
          page: z.number().int(),
          text: z.string().describe('The matched text as it appears on the page'),
          line: z.string().describe('The line the match is on'),
          line_truncated: z.boolean().optional().describe('Present only when line was cut'),
          x: z.number(),
          y: z.number().describe('Baseline'),
          width: z.number(),
          height: z.number().describe('Font size; the box spans y to y + height'),
        }),
      ),
      pages_without_text: z.array(z.number().int()),
      pages_scanned: z.number().int(),
      next_page: z.number().int().nullable().describe('First page not fully searched, or null when finished'),
      pages_skipped: z.array(z.object({ page: z.number().int(), reason: z.enum(['max_hits', 'output_cap', 'work_budget', 'page_output_cap']) })).optional(),
      lines_skipped: z.number().int().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Find text in a PDF' },
  },
  async ({ pdf_path, query, regex, case_sensitive, whole_word, pages, max_hits, password }) => {
    try {
      const fd = new FormData();
      fd.append('pdf', pdfBlob(await resolveSource(pdf_path)), 'input.pdf');
      fd.append('query', query);
      for (const [k, v] of Object.entries({ regex, case_sensitive, whole_word, pages, max_hits, password })) {
        if (v !== undefined) fd.append(k, String(v));
      }
      const b = (await (await api('/api/find-text', { body: fd })).json()) as Record<string, unknown>;
      return jsonResult({
        count: b.count,
        truncated: b.truncated,
        hits: b.hits,
        pages_without_text: b.pagesWithoutText,
        pages_scanned: b.pagesScanned,
        next_page: b.nextPage,
        ...(b.pagesSkipped ? { pages_skipped: b.pagesSkipped } : {}),
        ...(b.linesSkipped ? { lines_skipped: b.linesSkipped } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_detect_fields',
  {
    title: 'Detect fillable fields in a flat PDF',
    description:
      "Detect fillable form fields in a flat PDF (one with no form fields; pdf_inspect lists none): finds blanks drawn on the page as lines, boxes, underscores and checkboxes and returns a text or checkbox field for each, named from the nearest printed label, with a confidence from 0 to 1. Each entry has type, name, page, x, y, width, height in PDF points from the bottom-left of the page as the viewer sees it, the frame pdf_add_fields and pdf_edit use. The entries can be reviewed (wrong ones dropped, others renamed or adjusted) and passed to pdf_add_fields as fields (label and confidence are ignored there), and pdf_fill then fills the result; pdf_add_fields with detect true does detection and adding in one call. Only drawn blanks are found: not a blank area with no line or box, a scanned image, or shaded cells with no outline. Results are suggestions: confidence scores are estimates, low-confidence entries can be wrong, and some detections are table cells or rules that are not blanks. Pages are read with min_confidence (default 0.4; 0.6 gives fewer but surer fields) and max_pages (default 40, at most 100). Zero fields is a normal answer with a note. At most 200 fields per call; the pages argument describes continuing a large form. Read-only: the source is never modified.",
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      pages: z.string().optional().describe('Pages to analyse, 1-based: "1-3,5,8-". Default: all pages (up to max_pages). Large forms: a call stops at its time and work limit, so while truncated is true the returned fields can be added with pdf_add_fields, after which pdf_detect_fields run on the resulting PDF with pages set to next_pages (exactly the pages not done, including a page cut at 200 fields; a sparse selection stays sparse) continues until truncated is false. Sending the original PDF again repeats the same names and is not supported. pages_skipped lists pages not analysed: reason too_complex (more drawn shapes or text than the per-page limits; sending them again gives the same answer) or deadline (the call stopped first; they are in next_pages).'),
      max_pages: z.number().int().min(1).max(100).optional().describe('Analyse at most this many pages. Default 40. At most 100.'),
      min_confidence: z.number().min(0).max(1).optional().describe('Drop fields below this confidence. Default 0.4 (drops only the weakest candidates, such as unlabelled shapes); 0.6 gives slightly higher precision and about a quarter fewer checkboxes.'),
      password: z.string().optional().describe(PASSWORD_DOC),
    },
    outputSchema: {
      count: z.number().int().describe('Fields returned'),
      truncated: z.boolean().describe('The answer is incomplete (more pages than max_pages, more than 200 fields, or the call stopped at its limit): a further call on the PDF with the returned fields added and pages set to next_pages continues from there, and each call again covers at most max_pages pages. False means no page is left to continue; a page listed in pages_skipped as too_complex was not analysed and is never continued'),
      next_page: z.number().int().nullable().describe('First page not returned, or null when finished'),
      next_pages: z.string().nullable().describe('Page spec of exactly the pages not done (including a page cut at 200 fields), or null when finished'),
      pages_skipped: z.array(z.object({ page: z.number().int(), reason: z.enum(['too_complex', 'deadline']) })).optional().describe('Pages not analysed: too_complex (more drawn shapes or text than the per-page limits; sending them again gives the same answer) or deadline (the call stopped first; they are in next_pages)'),
      pages: z.array(z.object({ page: z.number().int(), width: z.number(), height: z.number(), fields: z.number().int() })),
      fields: z.array(
        z.object({
          type: z.enum(['text', 'checkbox']),
          name: z.string().describe('Taken from the nearest printed label; unique, no dot'),
          page: z.number().int(),
          x: z.number().describe("Left edge in points from the page's left"),
          y: z.number().describe("Bottom edge in points from the page's bottom"),
          width: z.number(),
          height: z.number(),
          label: z.string().describe('The printed label the name came from, empty if none'),
          confidence: z.number().describe('0 to 1'),
        }),
      ),
      note: z.string().optional().describe('Present when no fields were found or pages were skipped'),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Detect fillable fields in a flat PDF' },
  },
  async ({ pdf_path, pages, max_pages, min_confidence, password }) => {
    try {
      const fd = new FormData();
      fd.append('pdf', pdfBlob(await resolveSource(pdf_path)), 'input.pdf');
      for (const [k, v] of Object.entries({ pages, max_pages, min_confidence, password })) {
        if (v !== undefined) fd.append(k, String(v));
      }
      const b = (await (await api('/api/detect-fields', { body: fd })).json()) as Record<string, unknown>;
      return jsonResult({
        count: b.count,
        truncated: b.truncated,
        next_page: b.nextPage ?? null,
        next_pages: b.nextPages ?? null,
        ...(b.pagesSkipped ? { pages_skipped: b.pagesSkipped } : {}),
        pages: b.pages,
        fields: b.fields,
        ...(b.note ? { note: String(b.note).replaceAll('pagesSkipped', 'pages_skipped') } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_add_fields',
  {
    title: 'Add fillable form fields to a PDF',
    description: `Add fillable form fields (AcroForm) to an existing PDF at exact positions, or (detect true) find them on a flat PDF automatically: text, multiline text, checkbox, radio group, dropdown and signature box. Coordinates are PDF points measured from the bottom-left corner of the page as the viewer sees it (1 inch = 72 pt; US Letter is 612 x 792), the same frame and 1-based page numbers as pdf_edit; x and y are the field's bottom-left corner and the whole rectangle must lie inside the page (each side at least 4 pt). Every entry needs type, name and page; every type except radio also needs x, y, width and height; radio and dropdown need options. Unknown keys are rejected. A radio entry is one group whose options each carry their own value, x, y, width and height. Text takes multiline, max_length, default and font_size; checkbox takes checked; dropdown takes options (strings), default and font_size. All entries also take required, read_only, border (default true) and background (default false). The signature type creates an EMPTY signature field for a signing tool to use: nothing is signed, it is not an e-signature. At most 200 entries and 200 widgets per call, and 2,000 fields in the finished form. Fields are plain AcroForm with no JavaScript. pdf_fill fills the result and pdf_inspect lists the new fields. For a flat PDF, pdf_detect_fields returns suggested fields that can be passed as fields; detect true does both steps in one call. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      fields: z
        .array(
          z.strictObject({
            type: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'signature']),
            label: z.string().optional().describe('Ignored. Lets an entry from pdf_detect_fields be passed as it is.'),
            confidence: z.number().optional().describe('Ignored. Lets an entry from pdf_detect_fields be passed as it is.'),
            name: z.string().max(200).regex(/^[^.]+$/).describe('Field name: 1-200 characters, no dot, unique in the request and not already a field name in the PDF (a name equal to the first part of an existing dotted name is also taken).'),
            page: z.number().int().min(1).describe('1-based page number.'),
            x: z.number().optional().describe("Left edge in points from the page's left. Not used by radio."),
            y: z.number().optional().describe("Bottom edge in points from the page's bottom. Not used by radio."),
            width: z.number().min(4).optional().describe('Width in points. Not used by radio.'),
            height: z.number().min(4).optional().describe('Height in points. Not used by radio.'),
            required: z.boolean().optional().describe("Set the field's Required flag. Default false."),
            read_only: z.boolean().optional().describe("Set the field's ReadOnly flag. Default false."),
            border: z.boolean().optional().describe('Draw a black 1 pt outline. Default true.'),
            background: z.boolean().optional().describe('Paint an opaque white background. Default false (none).'),
            multiline: z.boolean().optional().describe('Text only: allow several lines. Default false.'),
            max_length: z.number().int().min(1).max(65535).optional().describe('Text only: maximum characters.'),
            default: z.string().optional().describe('Text, radio (one option value) or dropdown (one option): the starting value. Defaults and dropdown options use standard fonts (WinAnsi characters only: euro sign and curly quotes work, Polish L-stroke and CJK fail).'),
            checked: z.boolean().optional().describe('Checkbox only: start ticked. Default false.'),
            font_size: z
              .union([z.number().min(1).max(200), z.literal('auto')])
              .optional()
              .describe('Text and dropdown: points (1-200), or "auto" (size chosen at the first fill, then kept). Omitted: a fixed min(12, largest size that fits one line in the height), at least 4. "auto" stores size 0 and pdf_fill then sizes the text to the box when the blank field is first filled (a short value is enlarged, a long one shrunk) and keeps that size, so a later, longer value is clipped; a fixed size draws predictably, and a value longer than the box is clipped, not shrunk.'),
            options: z
              .array(
                z.union([
                  z.string(),
                  z.strictObject({
                    value: z.string().max(200).describe('Option value, unique in the group, not "Off".'),
                    x: z.number(),
                    y: z.number(),
                    width: z.number().min(4),
                    height: z.number().min(4),
                  }),
                ]),
              )
              .min(1)
              .max(100)
              .optional()
              .describe('Dropdown: strings. Radio: objects with value, x, y, width and height.'),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('Fields to create. Required unless detect is true. Nothing is added unless every entry is valid. Required keys: every entry type, name, page; text, checkbox, dropdown and signature also x, y, width, height; radio and dropdown also options (radio options carry their own rectangles).'),
      detect: z.boolean().optional().describe('Instead of fields: detect the blanks drawn on a flat PDF (lines, boxes, underscores, checkboxes) and add a text or checkbox field for each, in one request. The answer reports how many fields were added; pdf_detect_fields returns the suggestions for review first. pages, max_pages and min_confidence apply as in pdf_detect_fields. Cannot be combined with fields. Default false.'),
      pages: z.string().optional().describe('With detect: pages to analyse, "1-3,5,8-". Default all.'),
      max_pages: z.number().int().min(1).max(100).optional().describe('With detect: analyse at most this many pages. Default 40.'),
      min_confidence: z.number().min(0).max(1).optional().describe('With detect: drop fields below this confidence. Default 0.4.'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: {
      ...PDF_OUTPUT,
      warning: z.string().optional().describe('Present as xfa-layer-dropped when a hybrid AcroForm/XFA input lost its XFA layer'),
      fields_detected: z.number().int().optional().describe('With detect: how many fields were detected and added (0 leaves the PDF unchanged)'),
      next_pages: z.string().optional().describe('With detect: pages not done (page spec, including a page cut at 200 fields); a further call on the returned PDF with detect true and pages set to this value continues with them, at most max_pages pages per call'),
      detect_truncated: z.boolean().optional().describe('With detect: the answer is incomplete (more than 200 fields, more than max_pages pages, or the call stopped at its limit); a further call on the returned PDF with detect true and pages set to next_pages continues, at most max_pages pages per call. Absent means no page is left to continue; a page in pages_skipped as too_complex was not analysed and is never continued'),
      pages_skipped: z.array(z.object({ page: z.number().int(), reason: z.enum(['too_complex', 'deadline']) })).optional().describe('With detect: pages not analysed because they hold more drawn shapes or text than the per-page limits'),
      note: z.string().optional().describe('With detect and no fields found'),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Add fillable form fields to a PDF' },
  },
  async ({ pdf_path, fields, detect, pages, max_pages, min_confidence, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      if (detect && fields !== undefined) throw new Error('detect cannot be combined with fields: send one or the other');
      if (!detect && fields === undefined) throw new Error('fields is required unless detect is true');
      fields?.forEach((f, i) =>
        f.options?.forEach((o, k) => {
          if (typeof o === 'object' && o.value === '') throw new Error(`fields[${i}].options[${k}].value must not be empty`);
        }),
      );
      const source = await resolveSource(pdf_path);
      if (detect) {
        // One request: /api/detect-fields with format=pdf detects and adds, metered once.
        const dfd = new FormData();
        dfd.append('pdf', pdfBlob(source), 'input.pdf');
        dfd.append('format', 'pdf');
        for (const [k, v] of Object.entries({ pages, max_pages, min_confidence, password })) {
          if (v !== undefined) dfd.append(k, String(v));
        }
        let res: Response;
        try {
          res = await api('/api/detect-fields', { body: dfd });
        } catch (e) {
          // Nothing detected is a 400 no_fields (no PDF is made); here it is the PDF unchanged, with the reason and the
          // same structured keys as pdf_detect_fields. Matched on the error code.
          if (e instanceof PdfOpsError && e.code === 'no_fields') {
            const b = ((e as { body?: Record<string, unknown> }).body ?? {}) as Record<string, unknown>;
            return await emitWith(source, 'fillable.pdf', 'PDF unchanged, no fields detected', output_path, {
              fields_detected: 0,
              ...(b.truncated === true ? { detect_truncated: true } : {}),
              ...(typeof b.nextPages === 'string' && SPEC.test(b.nextPages) ? { next_pages: b.nextPages } : {}),
              ...(Array.isArray(b.pagesSkipped) && b.pagesSkipped.length ? { pages_skipped: skippedPages(b.pagesSkipped.map((k) => (k ?? {}) as { page?: unknown; reason?: unknown })) } : {}),
              note: e.message.replace(/^no_fields: /, '').replaceAll('pagesSkipped', 'pages_skipped'),
            });
          }
          throw e;
        }
        const warning = warningHeader(res.headers.get('x-pdfops-warning'));
        const n = intHeader(res.headers.get('x-pdfops-fields')) ?? 0;
        const next = res.headers.get('x-pdfops-next-pages');
        const skipped = skippedPages((res.headers.get('x-pdfops-pages-skipped') ?? '').split(',').map((page) => ({ page })));
        return await emitWith(await bytesOf(res), 'fillable.pdf', `PDF with ${n} detected fields`, output_path, {
          ...(warning ? { warning } : {}),
          fields_detected: n,
          ...(res.headers.get('x-pdfops-truncated') === 'true' ? { detect_truncated: true } : {}),
          ...(next !== null && SPEC.test(next) ? { next_pages: next } : {}),
          ...(skipped.length ? { pages_skipped: skipped } : {}),
          ...(skipped.length || res.headers.get('x-pdfops-truncated') === 'true'
            ? { note: [skipped.length ? 'Some pages were not analysed because they hold more drawn shapes or text than this endpoint reads (see pages_skipped); fields on them are not in the result.' : '', res.headers.get('x-pdfops-truncated') === 'true' && next !== null && SPEC.test(next) ? `The result is incomplete: a further call on this PDF with detect true and pages=${next} continues from there, and detect_truncated is absent once no page is left to continue.` : ''].filter(Boolean).join(' ') }
            : {}),
        });
      }
      const fd = new FormData();
      fd.append('pdf', pdfBlob(source), 'input.pdf');
      fd.append('fields', JSON.stringify(fields));
      if (password !== undefined) fd.append('password', password);
      const res = await api('/api/add-fields', { body: fd });
      const warning = warningHeader(res.headers.get('x-pdfops-warning'));
      return await emitWith(await bytesOf(res), 'fillable.pdf', 'PDF with the new fields', output_path, warning ? { warning } : {});
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_image_to_pdf',
  {
    title: 'Make a PDF from JPG and PNG images',
    description: `Make a PDF from JPG and PNG images: one image per page, in the order given. Each image is a local path (.png, .jpg, .jpeg), an https:// URL or a data:image/jpeg;base64,… or data:image/png;base64,… URI; the type is detected from the bytes, not the name. At most 100 images, each up to 4 MB, 4.5 MB in total. page_size "fit" (default) makes each page the image's own size at 72 dpi (1 px = 1 pt; pages longer than 5,000 pt on a side are scaled down, tiny images are enlarged to a 3 pt minimum); "a4" or "letter" put the image on a standard page, centred, shrunk to fit inside the margin and never enlarged. orientation (auto, portrait, landscape; default auto picks per image) applies to a4 and letter only. margin is 0-200 pt (default 0 for fit, where the page grows by the margin on every side; 36 for a4 and letter). A JPEG's EXIF orientation is applied, so phone photos come out upright. PNG: 8-bit and 16-bit, palette, grey, interlaced and transparent files work (transparency is kept); animated PNGs, other formats (GIF, WebP, HEIC, TIFF, SVG) and PDFs are rejected. JPEG: baseline and progressive, grey, RGB and Adobe-style CMYK. Very large images fail with image_too_large (PNG over 10 megapixels or a memory estimate; JPEG over 250 megapixels), and many large PNGs in one call with images_too_large_together. Deterministic: the same images give byte-identical output. pdf_merge joins images with existing PDFs when each image is an https:// URL or a data URI (it reads local paths for .pdf files only). ${OUT_TAIL}`,
    inputSchema: {
      image_paths: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe('In order, one page each: a local path (.png, .jpg, .jpeg) inside the allowed directories (PDFOPS_ROOT, default the working directory), an https:// URL, or a data:image/jpeg;base64,… / data:image/png;base64,… URI.'),
      page_size: z.enum(['fit', 'a4', 'letter']).optional().describe('fit (default): page = image size. a4 or letter: standard page, image centred and shrunk to fit.'),
      orientation: z.enum(['auto', 'portrait', 'landscape']).optional().describe('a4 and letter only; auto (default) picks portrait or landscape per image.'),
      margin: z.number().min(0).max(200).optional().describe('Points, 0-200. Default 0 for fit, 36 for a4 and letter.'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, title: 'Make a PDF from JPG and PNG images' },
  },
  async ({ image_paths, page_size, orientation, margin, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const fd = new FormData();
      const images = await resolveAll(
        image_paths,
        async (src, i) => {
          try {
            return await resolveImage(src);
          } catch (e) {
            throw new Error(`image_paths[${i}]: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
        MAX_UPLOAD_BYTES,
        'The images',
      );
      images.forEach((b, i) => fd.append('pdf', fileBlob(b), `image-${i}`));
      for (const [k, v] of Object.entries({ page_size, orientation, margin })) {
        if (v !== undefined) fd.append(k, String(v));
      }
      const bytes = await bytesOf(await api('/api/image-to-pdf', { body: fd }));
      return await emit(bytes, 'images.pdf', `PDF from ${image_paths.length} image${image_paths.length === 1 ? '' : 's'}`, output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_add_attachment',
  {
    title: 'Embed files in a PDF',
    description: `Embed one or more files (for example an XML or CSV data file) in a PDF as attachments. Each entry in files has a source (a local path, an https:// URL or a data: URI with base64) and optional name, mime_type, description (at most 1,000 characters) and relationship (Alternative, Data, Source, Supplement or Unspecified, default Unspecified; the PDF/A-3 AFRelationship value). A local path must end in .xml, .csv, .json, .txt, .md, .html, .xlsx, .pdf, .png, .jpg or .jpeg and lie inside the allowed directories (PDFOPS_ROOT, default the working directory). name is 1-255 characters and at most 255 UTF-8 bytes with no / or backslash or control characters, and defaults to the file name of a path or the last part of an https:// URL path (a data: URI needs a name). mime_type looks like text/xml, with no parameters and no #. At most 10 files and 3 MB in total per call, and at most 200 attachments in the finished PDF. A PDF whose list of embedded files has over 2,000 entries (name_tree_too_large) or an unreadable existing name (attachments_too_complex) is refused. A name already used by an attachment in the PDF (as a key or as an entry's /UF or /F), or twice in the call, is refused. Existing content, including any existing attachments, is kept. Each file keeps its full name; a plain-ASCII lookup key for each is returned in the result as keys. Unknown keys are rejected. The whole file is saved again, so an existing digital signature on the PDF stops validating. ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      files: z
        .array(
          z.strictObject({
            source: z.string().describe('File source: a local path, an https:// URL or a data:<type>;base64,… URI.'),
            name: z.string().max(255).optional().describe('Attachment name. Default: the file name of the path or URL.'),
            mime_type: z.string().optional().describe('For example text/xml.'),
            description: z.string().max(1000).optional(),
            relationship: z.enum(['Alternative', 'Data', 'Source', 'Supplement', 'Unspecified']).optional().describe('PDF/A-3 AFRelationship. Default Unspecified.'),
          }),
        )
        .min(1)
        .max(10)
        .describe('Files to embed. Nothing is added unless every entry is valid.'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: {
      ...PDF_OUTPUT,
      keys: z
        .array(z.object({ name: z.string().describe('The file name, cut to 40 characters'), key: z.string().describe('The name tree key') }))
        .optional()
        .describe('One entry per added file, in order: the plain-ASCII lookup key of the attachment'),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Embed files in a PDF' },
  },
  async ({ pdf_path, files, password, output_path }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const fd = new FormData();
      const pdf = await resolveSource(pdf_path);
      fd.append('pdf', pdfBlob(pdf), 'input.pdf');
      if (password !== undefined) fd.append('password', password);
      const options: Record<string, unknown>[] = [];
      const names = files.map((f, i) => {
        let name = f.name;
        if (name === undefined && !/^data:/i.test(f.source)) {
          try {
            const last = /^https?:\/\//i.test(f.source) ? new URL(f.source).pathname.split('/').pop() : f.source.split(/[\\/]/).pop();
            name = decodeURIComponent(last ?? '') || undefined;
          } catch {
            name = undefined;
          }
        }
        if (!name) throw new Error(`files[${i}].name is required unless source is a path or an https:// URL that ends in a file name`);
        return name;
      });
      const blobs = await resolveAll(
        files.map((f) => f.source),
        async (src, i) => {
          try {
            return await resolveFile(src, ATTACHMENT_EXTS);
          } catch (e) {
            throw new Error(`files[${i}].source: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
        MAX_ATTACH_BYTES,
        'The files',
      );
      files.forEach((f, i) => {
        fd.append('file', fileBlob(blobs[i]), 'file');
        const { source: _source, ...rest } = f;
        options.push({ ...rest, name: names[i] });
      });
      assertUploadFits(pdf, blobs, 'The PDF and files', [JSON.stringify(options), password ?? '']);
      fd.append('options', JSON.stringify(options));
      const res = await api('/api/attach', { body: fd });
      const found = keysHeader(res.headers.get('x-pdfops-attachment-keys'), files.length);
      const keys = (found ?? []).map((key, i) => ({ name: names[i].slice(0, 40), key }));
      const out = await emitWith(await bytesOf(res), 'attached.pdf', 'PDF with the files embedded', output_path, { keys });
      (out.content[0] as { text: string }).text += found
        ? ` Lookup keys for qpdf --show-attachment: ${keys.map((k) => `${k.name} -> key ${k.key}`).join('; ')}.`
        : ' The API returned attachment keys in an unexpected form, so none are reported.';
      return out;
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_html_to_pdf',
  {
    title: 'Create a PDF from HTML',
    description: `Render an HTML string to a PDF with a headless browser, so layout, CSS (flexbox, grid, print styles), images and web fonts come out as in a browser print. It takes HTML text only: there is no URL input, and JavaScript is switched off, so scripts do not run and pages that build themselves with JavaScript render empty. External resources (images, stylesheets, fonts) load only over https from public hosts; anything else (http, file, private or internal addresses, redirects to them) is blocked and skipped, and the PDF is still made. Data URIs work and are the safest way to include images. Letter or A4, portrait or landscape, margin in points (default 36), backgrounds printed by default, optional scale. html is capped at 1 MB, the document at 50 pages and 16 MB, external resources at 50 requests and 40 MB, and rendering at 15 seconds. A render that reaches the renderer counts as 5 requests against the monthly quota, not 1, whether it succeeds or fails; the html argument lists the cases that count for less. Resource, image and font details are in the html argument. pdf_text_to_pdf handles Markdown, text or CSV with no HTML, and pdf_invoice builds an invoice from data. ${OUT_TAIL}`,
    inputSchema: {
      html: z.string().describe('The document as HTML text, up to 1 MB of UTF-8. A full document or a fragment. Frames, iframes, objects, embeds, audio and video are not rendered, and an inline or fetched image is decoded and checked first. Common fonts (Helvetica, Arial, Times, Courier and generic families) render as Liberation faces, metric-compatible with the originals. Images: 16 megapixels at most each (96 in total); PNG, JPEG, GIF, WebP or SVG (simplified: scripts, style sheets, filters, masks, embedded images and links are removed; inline style colours are kept); AVIF, BMP, ICO, TIFF, animated PNG and colour-bitmap fonts are not supported, and an image in an unsupported format or over a limit fails the request (a missing image, such as a 404 or a tracking pixel, is skipped). Quota: once the renderer is reached every outcome counts as 5 requests, failures included; a refusal before a browser starts (for example an inline image refused with image_too_large or unsupported_image, with the image named in the message) counts as 1; only input validation errors and a busy or unreachable renderer count nothing.'),
      page_size: z.enum(['a4', 'letter']).optional().describe('Default letter.'),
      landscape: z.boolean().optional().describe('Landscape orientation. Default false.'),
      margin: z.number().min(0).max(144).optional().describe('Margin on every side in points, 0-144. Default 36.'),
      print_background: z.boolean().optional().describe('Print background colors and images. Default true.'),
      scale: z.number().min(0.1).max(2).optional().describe('Page content scale, 0.1-2. Default 1.'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: {
      ...PDF_OUTPUT,
      pages: z.number().int().optional().describe('Pages in the PDF'),
      blocked_requests: z.number().int().optional().describe('External requests the page made that were blocked by the network policy'),
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Create a PDF from HTML' },
  },
  async ({ output_path, ...body }) => {
    try {
      if (output_path) await checkOutputPath(output_path);
      const res = await api('/api/html-to-pdf', { body: JSON.stringify(body), json: true });
      const pages = intHeader(res.headers.get('x-pdfops-pages'));
      const blocked = intHeader(res.headers.get('x-pdfops-blocked-requests'));
      return await emitWith(await bytesOf(res), 'document.pdf', 'PDF', output_path, {
        ...(pages !== undefined && pages > 0 ? { pages } : {}),
        ...(blocked !== undefined ? { blocked_requests: blocked } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

  return server;
}

// serveStdio serves both protocol eras: 2025-era clients (initialize handshake) and
// clients on the 2026-07-28 revision. It builds one server per connection.
//
// The v2 stdio transport closes on stdin EOF and aborts requests still in flight, so a client
// that writes its requests and closes stdin (as 0.6.1 supported) never got the last answers.
// Here real stdin is piped through a PassThrough that is ended only once every request the
// transport has already parsed has been answered, so those answers are flushed before the
// process exits. Pending ids come from the transport's own parsed messages (no second parse of
// stdin, nothing buffered here). A request that is never answered (a cancelled one is dropped
// from the count) cannot hold the process longer than DRAIN_LIMIT_MS after EOF.
// When the transport closes for any other reason (a line over its 10 MiB bound, a stdout
// error), stdin is unpiped and paused so the process exits, as it did before this wrapper.
const DRAIN_LIMIT_MS = 5 * 60_000;
const pending = new Set<string>();
const stdin = new PassThrough();
let eof = false;
let drainTimer: NodeJS.Timeout | undefined;
const settle = () => {
  if (eof && pending.size === 0) {
    clearTimeout(drainTimer);
    stdin.end();
  }
};
const onStdinEnd = () => {
  eof = true;
  drainTimer = setTimeout(() => stdin.end(), DRAIN_LIMIT_MS);
  drainTimer.unref();
  settle();
};
type Message = Parameters<StdioServerTransport['send']>[0];
class DrainingStdio extends StdioServerTransport {
  constructor() {
    super(stdin);
    // The SDK assigns onmessage after construction; wrap whatever it assigns.
    let handler: ((m: Message) => void) | undefined;
    Object.defineProperty(this, 'onmessage', {
      configurable: true,
      get: () => handler && ((m: Message) => {
        const r = m as { id?: unknown; method?: unknown; params?: { requestId?: unknown } };
        if (r.id !== undefined && typeof r.method === 'string') pending.add(JSON.stringify(r.id));
        else if (r.method === 'notifications/cancelled' && r.params?.requestId !== undefined) pending.delete(JSON.stringify(r.params.requestId));
        handler!(m);
      }),
      set: (h: ((m: Message) => void) | undefined) => {
        handler = h;
      },
    });
    process.stdin.pipe(stdin, { end: false });
    process.stdin.on('end', onStdinEnd);
  }
  override async send(message: Message): Promise<void> {
    await super.send(message);
    const m = message as { id?: unknown; method?: unknown };
    if (m.id !== undefined && m.method === undefined) pending.delete(JSON.stringify(m.id));
    settle();
  }
  override async close(): Promise<void> {
    process.stdin.unpipe(stdin);
    process.stdin.off('end', onStdinEnd);
    process.stdin.pause();
    clearTimeout(drainTimer);
    pending.clear();
    return super.close();
  }
}
serveStdio(createServer, { transport: new DrainingStdio() });
