#!/usr/bin/env node
// pdfops-mcp — MCP server exposing the PDFops API as agent tools.
//
// Design: tools take/return FILE PATHS, not base64 blobs. This server
// runs locally (npx pdfops-mcp) beside the agent, so the filesystem is
// the natural interface — an agent says "fill /tmp/form.pdf and save
// to /tmp/out.pdf" and the PDF bytes never transit the model context.
//
// Env:
//   PDFOPS_API_KEY  optional — free key from https://pdfops.dev/pricing
//                   (250 req/mo; keyless works at 100 req/IP/mo)
//   PDFOPS_BASE_URL optional — API origin override (testing)

import { readFile, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PdfOps, PdfOpsError } from 'pdfops-sdk';

const client = new PdfOps({
  apiKey: process.env.PDFOPS_API_KEY,
  baseUrl: process.env.PDFOPS_BASE_URL,
  clientTag: 'mcp',
});

const server = new McpServer({
  name: 'pdfops',
  version: '0.1.0',
});

const errText = (e: unknown): string =>
  e instanceof PdfOpsError
    ? `PDFops API error ${e.status} (${e.code}): ${e.message}` +
      (e.code === 'rate_limited'
        ? ' — get a free API key (250/mo) at https://pdfops.dev/pricing and set PDFOPS_API_KEY'
        : '')
    : String(e);

server.tool(
  'pdf_inspect',
  'List a PDF\'s AcroForm form fields — names, types, options, current values — plus a paste-ready fillTemplate object for pdf_fill. A PDF with no form returns count 0. Call this FIRST when filling an unfamiliar PDF: you cannot fill fields whose names you do not know.',
  { pdf_path: z.string().describe('Absolute path to the PDF to inspect') },
  async ({ pdf_path }) => {
    try {
      const result = await client.inspect(await readFile(pdf_path));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: errText(e) }], isError: true };
    }
  },
);

server.tool(
  'pdf_fill',
  'Fill AcroForm form fields in a PDF and save the result. Field names must exist in the PDF (use pdf_inspect first). All values are strings; checkboxes take "true"/"false"; dropdown/radio/optionlist values must be one of the field\'s options.',
  {
    pdf_path: z.string().describe('Absolute path to the template PDF'),
    fields: z
      .record(z.string())
      .describe('Field name → string value (from pdf_inspect\'s fillTemplate)'),
    output_path: z.string().describe('Absolute path to write the filled PDF'),
  },
  async ({ pdf_path, fields, output_path }) => {
    try {
      const bytes = await client.fillForm(await readFile(pdf_path), fields);
      await writeFile(output_path, bytes);
      return {
        content: [
          { type: 'text', text: `Filled PDF written to ${output_path} (${bytes.byteLength} bytes)` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: errText(e) }], isError: true };
    }
  },
);

server.tool(
  'pdf_merge',
  'Merge two or more PDFs into one, in the order given, and save the result.',
  {
    pdf_paths: z
      .array(z.string())
      .min(2)
      .describe('Absolute paths of the PDFs to merge, in order'),
    output_path: z.string().describe('Absolute path to write the merged PDF'),
  },
  async ({ pdf_paths, output_path }) => {
    try {
      const inputs = await Promise.all(pdf_paths.map((p) => readFile(p)));
      const bytes = await client.merge(inputs);
      await writeFile(output_path, bytes);
      return {
        content: [
          { type: 'text', text: `Merged ${pdf_paths.length} PDFs into ${output_path} (${bytes.byteLength} bytes)` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: errText(e) }], isError: true };
    }
  },
);

server.tool(
  'pdf_invoice',
  'Generate a complete, professionally laid-out invoice PDF from structured data — no template needed. Deterministic: the same input produces byte-identical output (safe to re-run). Note: without a paid PDFops key the output carries a small "Generated with pdfops.dev" footer line.',
  {
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
    output_path: z.string().describe('Absolute path to write the invoice PDF'),
  },
  async ({ invoice, output_path }) => {
    try {
      const bytes = await client.invoice(invoice);
      await writeFile(output_path, bytes);
      return {
        content: [
          { type: 'text', text: `Invoice written to ${output_path} (${bytes.byteLength} bytes)` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: errText(e) }], isError: true };
    }
  },
);

server.tool(
  'pdfops_usage',
  'Check the current PDFops API quota for the configured key: tier, limit, used, remaining, reset date. Requires PDFOPS_API_KEY.',
  {},
  async () => {
    try {
      const usage = await client.usage();
      return { content: [{ type: 'text', text: JSON.stringify(usage, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: errText(e) }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
