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
// Env:
//   PDFOPS_API_KEY  optional — free key from https://pdfops.dev/pricing
//                   (250 req/mo; keyless works at 100 req/IP/mo)
//   PDFOPS_BASE_URL optional — API origin override (testing)

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

const client = new PdfOps({
  apiKey: process.env.PDFOPS_API_KEY,
  baseUrl: process.env.PDFOPS_BASE_URL,
  clientTag: 'mcp',
});

const server = new McpServer({ name: 'pdfops', version });

const SOURCE_DOC =
  'PDF source: an absolute file path, an https:// URL, or a data:application/pdf;base64,… URI. Use a URL or data URI when this server runs remotely (Smithery, hosted gateways) where local paths do not exist.';
const OUTPUT_DOC =
  'Absolute path to write the result. Omit when running remotely: the PDF is then returned inline as an application/pdf resource for the client to save.';

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
    inputSchema: { pdf_path: z.string().describe(SOURCE_DOC) },
    outputSchema: {
      count: z.number().int().describe('Number of form fields found; 0 when the PDF has no fillable form'),
      hasXFA: z.boolean().describe('True for hybrid AcroForm/XFA documents, whose XFA layer is dropped when filled'),
      fields: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().describe('text, checkbox, radio, optionlist, or unsupported'),
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
  async ({ pdf_path }) => {
    try {
      const result = await client.inspect(await resolveSource(pdf_path));
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
    description: 'Fill AcroForm form fields in a PDF and save or return the result. Field names must exist in the PDF (use pdf_inspect first). All values are strings; checkboxes take "true"/"false"; dropdown/radio/optionlist values must be one of the field\'s options; text values must respect the field\'s maxLength from pdf_inspect. The source PDF is never modified. Returns the filled PDF written to output_path, or inline as an application/pdf resource when output_path is omitted; an existing file at output_path is overwritten. Encrypted PDFs are rejected with decrypt advice (common for government blanks with an empty user password), and a rejected fill writes no file at all.',
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
    },
    outputSchema: PDF_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path, fields, output_path, flatten }) => {
    try {
      const bytes = await client.fillForm(await resolveSource(pdf_path), fields, { flatten });
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
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
    outputSchema: PDF_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_paths, output_path }) => {
    try {
      const inputs = await Promise.all(pdf_paths.map((p) => resolveSource(p)));
      const bytes = await client.merge(inputs);
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
            .optional()
            .describe('Shown on the invoice; also pins metadata for determinism'),
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

const transport = new StdioServerTransport();
await server.connect(transport);
