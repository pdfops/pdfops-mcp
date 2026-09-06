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

const emit = async (bytes: Uint8Array, name: string, summary: string, output_path?: string) => {
  if (output_path) await writeFile(output_path, bytes);
  return pdfResult(bytes, name, summary, output_path);
};

server.registerTool(
  'pdf_inspect',
  {
    title: 'Inspect PDF form fields',
    description: 'List a PDF\'s AcroForm form fields — names, types, options, current values, per-field maxLength where declared — plus a paste-ready fillTemplate object for pdf_fill and a hasXFA flag (hybrid AcroForm/XFA inputs lose their XFA layer when filled). A PDF with no form returns count 0. Call this FIRST when filling an unfamiliar PDF: you cannot fill fields whose names you do not know, and values longer than a field\'s maxLength are rejected.',
    inputSchema: { pdf_path: z.string().describe(SOURCE_DOC) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ pdf_path }) => {
    try {
      const result = await client.inspect(await resolveSource(pdf_path));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'pdf_fill',
  {
    title: 'Fill PDF form',
    description: 'Fill AcroForm form fields in a PDF and save or return the result. Field names must exist in the PDF (use pdf_inspect first). All values are strings; checkboxes take "true"/"false"; dropdown/radio/optionlist values must be one of the field\'s options; text values must respect the field\'s maxLength from pdf_inspect. Encrypted PDFs are rejected with decrypt advice (common for government blanks with an empty user password).',
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
    description: 'Merge two or more PDFs into one, in the order given, and save or return the result.',
    inputSchema: {
      pdf_paths: z.array(z.string()).min(2).describe(`In order, each a ${SOURCE_DOC}`),
      output_path: z.string().optional().describe(OUTPUT_DOC),
    },
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
    description: 'Generate a complete, professionally laid-out invoice PDF from structured data — no template needed. Deterministic: the same input produces byte-identical output (safe to re-run). Note: without a paid PDFops key the output carries a small "Generated with pdfops.dev" footer line.',
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
    description: 'Check the current PDFops API quota for the configured key: tier, limit, used, remaining, reset date. Requires PDFOPS_API_KEY.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const usage = await client.usage();
      return { content: [{ type: 'text', text: JSON.stringify(usage, null, 2) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
