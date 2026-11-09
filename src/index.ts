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
// pdf_page_numbers, pdf_unlock, pdf_protect, pdf_metadata, pdf_set_metadata.
//
// Env:
//   PDFOPS_API_KEY  optional — free key from https://pdfops.dev/pricing
//                   (250 req/mo; keyless works at 100 req/IP/mo)
//   PDFOPS_BASE_URL optional — API origin override (testing)

import { stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Tool annotations (title + readOnlyHint/destructiveHint) are mandatory for the
// Claude Connectors Directory and help every client show what a tool does.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PdfOps, PdfOpsError } from 'pdfops-sdk';
import { describeSource, pdfResult, resolveSource } from './source.js';

// Version comes from package.json so the string MCP clients display can no
// longer drift from the published one (0.2.0 shipped reporting 0.1.1).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const server = new McpServer({ name: 'pdfops', version });

// Source attribution: every API call carries this server's version and the
// MCP host app ("claude-ai/0.1.0", "cursor-vscode/1.0.0", …) taken from the
// initialize handshake's clientInfo. Added via a fetch wrapper rather than
// SDK options because clientInfo only exists after connect.
const client = new PdfOps({
  apiKey: process.env.PDFOPS_API_KEY,
  baseUrl: process.env.PDFOPS_BASE_URL,
  clientTag: 'mcp',
  fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Pdfops-Client-Version', version);
    const host = server.server.getClientVersion();
    if (host) headers.set('X-Pdfops-Client-Host', `${host.name}/${host.version}`);
    return fetch(input, { ...init, headers });
  },
});

const SOURCE_DOC =
  'PDF source: an absolute file path, an https:// URL, or a data:application/pdf;base64,… URI. Use a URL or data URI when this server runs remotely (Smithery, hosted gateways) where local paths do not exist.';
const OUTPUT_DOC =
  'Absolute path to write the result. Omit when running remotely: the PDF is then returned inline as an application/pdf resource for the client to save.';

const PASSWORD_DOC =
  'Password to open the input, only needed for a user-password PDF (owner-locked files with an empty user password open without it).';

const errText = (e: unknown): string =>
  e instanceof PdfOpsError
    ? `PDFops API error ${e.status} (${e.code}): ${e.message}` +
      (e.code === 'rate_limited'
        ? ' — get a free API key (250/mo) at https://pdfops.dev/pricing and set PDFOPS_API_KEY'
        : '')
    : e instanceof Error
      ? e.message
      : String(e);

const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: errText(e) }], isError: true });

// Declared as outputSchema on every PDF-emitting tool so an agent knows what it
// gets back without calling first. Both delivery modes are represented: a path
// when output_path was given, a pdfops:// resource uri when it was not.
const PDF_OUTPUT = {
  bytes: z.number().int().describe('Size of the produced PDF in bytes'),
  output_path: z.string().optional().describe('Absolute path written, when output_path was supplied'),
  resource_uri: z.string().optional().describe('pdfops:// uri of the inline application/pdf resource, when output_path was omitted'),
};

const emit = async (bytes: Uint8Array, name: string, summary: string, output_path?: string) => {
  if (output_path) await writeFile(output_path, bytes);
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
    description: 'List a PDF\'s AcroForm form fields — names, types, options, current values, per-field maxLength where declared — plus a paste-ready fillTemplate object for pdf_fill and a hasXFA flag (hybrid AcroForm/XFA inputs lose their XFA layer when filled). A PDF with no fillable form returns count 0. Read-only: the PDF is fetched or read but never modified. Call this FIRST when filling an unfamiliar PDF, since pdf_fill rejects unknown field names and over-length values.',
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
      fillTemplate: z.record(z.string()).describe('Field name to empty-or-current value, ready to edit and pass to pdf_fill'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, password }) => {
    try {
      const result = await client.inspect(await resolveSource(pdf_path), { password });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: { ...result } };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_fill',
  {
    title: 'Fill PDF form',
    description: 'Fill AcroForm form fields in a PDF and save or return the result. Field names must exist in the PDF (use pdf_inspect first). All values are strings; checkboxes take "true"/"false"; dropdown/radio/optionlist values must be one of the field\'s options; text values must respect the field\'s maxLength from pdf_inspect. The source PDF is never modified. Returns the filled PDF written to output_path, or inline as an application/pdf resource when output_path is omitted; an existing file at output_path is overwritten. Owner-locked PDFs (empty user password, common for government blanks) fill without a password; a user-password PDF needs the password parameter, otherwise it is rejected with encrypted_pdf. A rejected fill writes no file at all.',
    inputSchema: {
      pdf_path: z.string().describe(`Template ${SOURCE_DOC}`),
      fields: z
        .record(z.string())
        .describe('Field name → string value (from pdf_inspect\'s fillTemplate)'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
      flatten: z
        .boolean()
        .optional()
        .describe('Bake values into page content and drop the AcroForm so fields are no longer editable'),
      password: z.string().optional().describe(PASSWORD_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, fields, output_path, flatten, password }) => {
    try {
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
    description: 'Merge two or more PDFs into one, in the order given, and save or return the result. Source files are read only and never modified; an existing file at output_path is overwritten. Returns the merged PDF written to output_path, or inline as an application/pdf resource when output_path is omitted. This tool only concatenates whole documents: it does not reorder, rotate or delete pages within them, and it does not fill forms — use pdf_fill for a fillable form and pdf_invoice to build a document from data. An unreadable or rejected input fails with an error and writes no file, so a partial merge is never left behind.',
    inputSchema: {
      pdf_paths: z.array(z.string()).min(2).describe(`In order, each a ${SOURCE_DOC}`),
      password: z.string().optional().describe(`${PASSWORD_DOC} Applies to every input.`),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_paths, password, output_path }) => {
    try {
      const inputs = await Promise.all(pdf_paths.map((p) => resolveSource(p)));
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
    description: 'Generate a complete, professionally laid-out invoice PDF from structured data — no template needed. Deterministic: the same input produces byte-identical output (safe to re-run). Note: without a paid PDFops key the output carries a small "Generated with pdfops.dev" footer line. Returns the invoice written to output_path, or inline as an application/pdf resource when output_path is omitted; an existing file at output_path is overwritten. Use this when you have invoice DATA and no document; if you already have an invoice PDF or a fillable template to populate, use pdf_fill instead.',
    inputSchema: {
      invoice: z
        .object({
          from: z.union([
            z.string(),
            z.object({ name: z.string(), lines: z.array(z.string()).optional() }),
          ]),
          to: z.union([
            z.string(),
            z.object({ name: z.string(), lines: z.array(z.string()).optional() }),
          ]),
          items: z
            .array(
              z.object({
                description: z.string(),
                quantity: z.number().positive().optional(),
                unit_price: z.number().nonnegative(),
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
          due: z.string().optional(),
          currency: z.string().regex(/^[A-Z]{3}$/).optional(),
          tax_rate: z.number().min(0).max(100).optional(),
          notes: z.string().max(1000).optional(),
      })
        .describe('Invoice data'),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ invoice, output_path }) => {
    try {
      const bytes = await client.invoice(invoice);
      const name = invoice.invoice_number ? `invoice-${invoice.invoice_number}.pdf` : 'invoice.pdf';
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const usage = await client.usage();
      return { content: [{ type: 'text', text: JSON.stringify(usage, null, 2) }], structuredContent: { ...usage } };
    } catch (e) {
      return fail(e);
    }
  },
);

const PAGES_DOC = '1-based page spec such as "1-3,5"; default all pages';
const OUT_TAIL =
  'Returns the result written to output_path, or inline as an application/pdf resource when output_path is omitted; an existing file at output_path is overwritten. The source is never modified.';
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

server.registerTool(
  'pdf_extract_pages',
  {
    title: 'Extract pages from PDF',
    description: `Keep only the listed pages of a PDF, in the order given, and return them as a new PDF. Because order follows the spec, it also reorders pages ("3,1,2") and can duplicate them. Use this to pull a section out of a document; use pdf_delete_pages to remove pages instead, pdf_split for several output files, and pdf_merge to join documents. ${OUT_TAIL} Fails with invalid_pages if a page is out of range.`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      pages: z.string().describe('1-based page spec, e.g. "1-3,5,8-" (open-ended range runs to the last page)'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, pages, password, output_path }) => {
    try {
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
    description: `Remove the listed pages from a PDF and return the remaining pages in their original order. Use this to drop a cover, blank or sensitive pages; use pdf_extract_pages when it is easier to name the pages to keep. ${OUT_TAIL} Deleting every page fails with no_pages_left.`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      pages: z.string().describe('1-based pages to REMOVE, e.g. "2,4-6,9-"'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, pages, password, output_path }) => {
    try {
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
    description: `Rotate pages of a PDF clockwise by 90, 180 or 270 degrees (or -90). Rotation adds to each page's existing rotation. Omit pages to rotate every page. Use this to fix sideways scans. ${OUT_TAIL}`,
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
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, degrees, pages, password, output_path }) => {
    try {
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
      'Split one PDF into several PDFs, either by explicit ranges (each comma group becomes one part: "1-2,3-5" gives two parts) or into fixed-size chunks (every=2 on 5 pages gives 1-2, 3-4, 5). Give exactly one of ranges or every. With output_dir the parts are written there as part-1.pdf, part-2.pdf, …; otherwise each part comes back inline as an application/pdf resource. Either way you also get a structured parts list (pages, page_count, bytes, and output_path or resource_uri). Existing part-N.pdf files with those names are overwritten, and part-N.pdf files from earlier runs in that directory are left as they are; the source is never modified. Limited to 100 parts and about 4 MB of total output; use pdf_extract_pages for a single range.',
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      ranges: z.string().optional().describe('1-based page spec; each comma group becomes one part, e.g. "1-2,3-5"'),
      every: z.number().int().min(1).optional().describe('Chunk size in pages; the last part may be shorter'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_dir: z
        .string()
        .optional()
        .describe('Absolute path of an existing directory to write part-1.pdf, part-2.pdf, … into. Omit when running remotely: the parts are then returned inline as application/pdf resources.'),
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
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, ranges, every, password, output_dir }) => {
    try {
      if (output_dir) {
        if (!isAbsolute(output_dir)) throw new Error(`output_dir must be an absolute path: ${output_dir}`);
        const st = await stat(output_dir).catch(() => undefined);
        if (!st?.isDirectory()) throw new Error(`output_dir is not an existing directory: ${output_dir}`);
      }
      const input = await resolveSource(pdf_path);
      // Neither/both given is passed through so the API answers with invalid_split.
      const opts = { ranges, every, password } as { ranges: string; password?: string };
      const result = await client.split(input, opts);
      if (output_dir) {
        const parts = [];
        for (const [i, p] of result.parts.entries()) {
          const output_path = join(output_dir, `part-${i + 1}.pdf`);
          try {
            await writeFile(output_path, p.pdf);
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
    description: `Stamp a diagonal text watermark on pages of a PDF (default: centered, 45 degrees, grey, 15% opacity). Text is upright and centered for any page size or existing page rotation. Standard Helvetica only: characters outside WinAnsi (e.g. CJK, emoji) fail with unsupported_characters. Use this for DRAFT / CONFIDENTIAL stamps; use pdf_page_numbers for numbering. ${OUT_TAIL}`,
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
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, text, output_path, ...opts }) => {
    try {
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
    description: `Print page numbers on a PDF using a format template with {n} (page number) and {total} (page count), e.g. "Page {n} of {total}". Default is "{n} / {total}" at bottom-center, 10 pt. Numbers sit upright for any page size or rotation. Standard Helvetica only (WinAnsi characters). Page i always shows start+i-1 even when pages selects only some pages. ${OUT_TAIL}`,
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
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, output_path, ...opts }) => {
    try {
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
    description: `Save a PDF without encryption so print/copy/modify restrictions are gone. Works for owner-locked files (empty user password) with no password, and for user-password files when you pass the password. It does NOT crack unknown passwords: a wrong or missing user password fails with encrypted_pdf. A PDF that was not encrypted is returned re-saved, with note "not-encrypted". ${OUT_TAIL}`,
    inputSchema: {
      pdf_path: z.string().describe(SOURCE_DOC),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: {
      ...PDF_OUTPUT,
      note: z.string().optional().describe('Present as "not-encrypted" when the input had no encryption'),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, password, output_path }) => {
    try {
      const { pdf: bytes, note } = await client.unlock(await resolveSource(pdf_path), password);
      const out = await emit(bytes, 'unlocked.pdf', 'Unlocked PDF', output_path);
      return note ? { ...out, structuredContent: { ...out.structuredContent, note } } : out;
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
      user_password: z.string().max(128).optional().describe('Password required to open the output'),
      owner_password: z.string().max(128).optional().describe('Password that lifts the restrictions'),
      permissions: z
        .array(z.enum(['print', 'copy', 'modify', 'annotate', 'fill-forms']))
        .optional()
        .describe('Actions to ALLOW; omit for the default, [] for none'),
      password: z.string().optional().describe(PASSWORD_DOC),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
  },
  async ({ pdf_path, user_password, owner_password, permissions, password, output_path }) => {
    try {
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
      "Read a PDF's document info: page_count, per-page width/height (points) and rotation, title, author, subject, keywords, creator, producer, creation_date, modification_date (ISO 8601, null when absent), whether it was encrypted, and has_form / form_field_count. Call this to learn a document's size and shape before splitting, rotating or filling. Read-only: the PDF is fetched or read but never modified.",
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
      .passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, password }) => {
    try {
      const result = await client.metadata(await resolveSource(pdf_path), { password });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: { ...result } };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_set_metadata',
  {
    title: 'Set PDF metadata',
    description: `Write document info fields (title, author, subject, creator, keywords) into a PDF. Give at least one; an empty string sets an empty value. Unicode is fine. Keywords may be a list or a comma-separated string. The output is saved unencrypted. Use pdf_metadata to read the current values. ${OUT_TAIL}`,
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
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pdf_path, output_path, keywords, ...opts }) => {
    try {
      const list = typeof keywords === 'string' ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : keywords;
      const bytes = await client.setMetadata(await resolveSource(pdf_path), { ...opts, keywords: list });
      return await emit(bytes, 'retitled.pdf', 'PDF with updated metadata', output_path);
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
