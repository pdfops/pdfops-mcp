# Installing pdfops-mcp (guide for AI agents such as Cline)

`pdfops-mcp` is a stdio MCP server published on npm. It needs Node.js 18+ and nothing else — no build step, no native dependencies, no account (an API key is optional).

## 1. Add the server

Register it with the MCP client using `npx` so the latest version is used:

```json
{
  "mcpServers": {
    "pdfops": {
      "command": "npx",
      "args": ["-y", "pdfops-mcp"],
      "env": {}
    }
  }
}
```

Claude Code equivalent: `claude mcp add pdfops -- npx -y pdfops-mcp`

## 2. Optional: API key

Without a key the server works on the keyless trial (100 requests per IP per month). For 250 requests per month, get a free key at <https://pdfops.dev/pricing> (no card) and set `"env": { "PDFOPS_API_KEY": "pdfops_live_..." }` in the config above.

## 3. Verify

Call `pdfops_usage` (if a key is set) or `pdf_inspect` with any PDF path. A successful `pdf_inspect` returns JSON with `count`, `fields` and `fillTemplate`.

## Tools

- `pdf_inspect` — list AcroForm fields of a PDF (call first on unfamiliar PDFs)
- `pdf_fill` — fill fields, optionally flatten; writes a file or returns the PDF inline
- `pdf_merge` — merge two or more PDFs in order
- `pdf_invoice` — generate a deterministic invoice PDF from structured data
- `pdfops_usage` — quota for the configured key

Inputs accept absolute file paths, `https://` URLs, or `data:application/pdf;base64,…` URIs. Omit `output_path` to receive the PDF inline as an `application/pdf` resource.
