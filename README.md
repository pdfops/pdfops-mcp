# pdfops-mcp

MCP server that gives AI agents deterministic PDF tools, backed by the [PDFops API](https://pdfops.dev): **inspect** AcroForm fields, **fill** forms, **merge** PDFs, and **generate invoices** — no Chromium, no native deps, nothing to host.

Beside a local agent, tools operate on file paths, so PDF bytes never transit the model context: your agent says *"fill /tmp/form.pdf and save to /tmp/out.pdf"* and gets a one-line confirmation back. Every PDF input also accepts an `https://` URL or a `data:application/pdf;base64,…` URI, and every output can be returned inline instead of written — which is what makes the server work on hosted runtimes (see below).

## Install

**Claude Code**

```bash
claude mcp add pdfops -- npx -y pdfops-mcp
# with a key:
claude mcp add pdfops -e PDFOPS_API_KEY=pdfops_live_… -- npx -y pdfops-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) / **Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "pdfops": {
      "command": "npx",
      "args": ["-y", "pdfops-mcp"],
      "env": { "PDFOPS_API_KEY": "pdfops_live_…" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`, note the `servers` key and `type`)

```json
{
  "servers": {
    "pdfops": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "pdfops-mcp"],
      "env": { "PDFOPS_API_KEY": "pdfops_live_…" }
    }
  }
}
```

Any other stdio client (Windsurf, Cline, Zed, your own agent): command `npx`, args `-y pdfops-mcp`. Per-client walkthrough and a real tool-call transcript: [pdfops.dev/mcp](https://pdfops.dev/mcp).

`PDFOPS_API_KEY` is optional — without it you get the keyless trial (100 requests/IP/month). A free key (250/month, no card) takes one field at [pdfops.dev/pricing](https://pdfops.dev/pricing).

## Tools

| Tool | What it does |
|---|---|
| `pdf_inspect` | List a PDF's form fields (names, types, options, values) + a paste-ready fill template. Call first on unfamiliar PDFs. |
| `pdf_fill` | Fill AcroForm fields → write the filled PDF. Optional `flatten` bakes values in and drops the form. |
| `pdf_merge` | Merge ≥2 PDFs in order → write the result. |
| `pdf_invoice` | Structured data → complete invoice PDF. Deterministic: same input, byte-identical output. |
| `pdfops_usage` | Quota check for the configured key. |

## Running remotely (Smithery, Glama hosted, cloud IDE gateways)

A hosted MCP runtime executes this server on a machine where your agent's file paths do not exist. Nothing changes in the config — pass sources the server can reach and skip `output_path`:

- **Inputs** (`pdf_path`, `pdf_paths`): an `https://` URL the server can fetch (≤4 MB per PDF, ≤4.5 MB per request — the API's limits), or a `data:application/pdf;base64,…` URI for small files.
- **Outputs**: omit `output_path` and `pdf_fill` / `pdf_merge` / `pdf_invoice` return the PDF inline as an embedded `application/pdf` resource (`pdfops://filled.pdf`, …) that the client saves. With `output_path` set, the file is written where the *server* runs.

Locally, absolute paths keep working exactly as before and remain the recommended form — bytes stay off the model context.

## Example prompts

- *"What fields does ~/forms/fw9.pdf have?"* → `pdf_inspect`
- *"Fill ~/forms/fw9.pdf for Ada Lovelace, 12 Analytical Way, London; save it flattened as ~/out/w9-ada.pdf"* → `pdf_inspect`, then `pdf_fill` with `flatten: true`
- *"Fill the onboarding form once per row of contractors.csv into ~/out/"* → one `pdf_inspect`, then `pdf_fill` per row
- *"Merge ~/out/w9-ada.pdf, ~/docs/nda.pdf and ~/docs/cover.pdf into one packet, cover first"* → `pdf_merge`
- *"Invoice Globex for 3 days of consulting at $650, 8.5% tax, due in 30 days"* → `pdf_invoice`
- *"How many PDFops requests do I have left this month?"* → `pdfops_usage`

## Example agent flow

> "Fill the W-9 template at ~/docs/w9.pdf for Ada Lovelace and merge it with ~/docs/cover.pdf"

1. `pdf_inspect` → discovers field names + fill template
2. `pdf_fill` → writes the filled W-9
3. `pdf_merge` → writes the combined packet

## Links

API docs: [pdfops.dev/docs](https://pdfops.dev/docs) · OpenAPI: [pdfops.dev/openapi.json](https://pdfops.dev/openapi.json) · Typed client: [`pdfops-sdk`](https://www.npmjs.com/package/pdfops-sdk) · Questions: hello@pdfops.dev

## Privacy Policy

This server runs on your machine and sends only what a tool call needs to the PDFops API (`https://pdfops.dev`): the PDF bytes you point it at, the field values you supply, and your API key if you set one. PDFops processes the request in memory and returns the result; it does not store your documents. API requests are logged with usage metadata to run quotas and the service. The full policy is at <https://pdfops.dev/privacy>. Questions: hello@pdfops.dev.

MIT © PDFops
