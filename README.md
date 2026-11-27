# pdfops-mcp

MCP server that gives AI agents deterministic PDF tools, backed by the [PDFops API](https://pdfops.dev): **inspect** AcroForm fields, **fill** forms, **merge** PDFs, **generate invoices** (including Factur-X / ZUGFeRD e-invoices), **create** PDFs from Markdown, text, CSV, HTML or images, **read** text and tables out of PDFs, and **edit** PDFs (extract, delete, rotate and split pages, watermark, page numbers, stamp text, images and barcodes, add form fields, embed files, unlock, protect, metadata). Nothing to host and no native dependencies on your machine.

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

**File access is confined.** The server reads and writes only inside `PDFOPS_ROOT`, which defaults to the directory the client starts it in (your home directory if that is `/`). Set it to the folder(s) holding your files, separated by `:` (`;` on Windows), e.g. `-e PDFOPS_ROOT=$HOME/Documents/forms`. PDF inputs and outputs must be `.pdf` files and inputs must start with a `%PDF` header. Since 0.5.0 a few tools also read other file types from the same folders: `.png`, `.jpg` and `.jpeg` images (`pdf_image_to_pdf`, image stamps in `pdf_edit`), the attachment sources of `pdf_add_attachment` (`.xml`, `.csv`, `.json`, `.txt`, `.md`, `.html`, `.xlsx`, `.pdf` and the image types), and `pdf_extract_text` writes a `.xlsx` workbook when you ask for `tables_format: "xlsx"`. Symlinks are resolved before the check, and a link is judged by the file it points to, so a link named `logo.png` that points at `.env` is refused. Beyond PDFs, nothing whose path below the root has a dot-prefixed file or folder name (`.env`, `.config`, `.docker`, `.claude`, `.credentials.json`) is ever read, images must start with PNG or JPEG magic bytes, a `.pdf` attachment must be a real PDF, and a file over 4 MiB is refused without being read. URLs must be public `https://` addresses (private, loopback and cloud-metadata hosts are refused on every redirect hop); that still means any `https://` source lets the agent make an outbound GET request to a URL of its choosing, which is inherent to URL sources. On Linux an output file is created, checked and cleaned up through a handle on its folder, so a folder swapped for a link mid-write cannot redirect it; on macOS and Windows those steps go by path, so the check does not hold against another local process that swaps folders inside the root while a write is in flight. API calls never follow redirects, time out after 60 seconds, and responses over 32 MB or inline results over 7 MB are refused (pass `output_path` for large results). Since 0.4.2.

## Tools

| Tool | What it does |
|---|---|
| `pdf_inspect` | List a PDF's form fields (names, types, options, values) + a paste-ready fill template. |
| `pdf_fill` | Fill AcroForm fields → write the filled PDF. Optional `flatten` bakes values in and drops the form; optional `password` opens a user-password PDF. |
| `pdf_merge` | Merge ≥2 PDFs in order → write the result. |
| `pdf_invoice` | Structured data → complete invoice PDF. Deterministic: same input, byte-identical output. Set `invoice.e_invoice` to `"factur-x"` for a PDF/A-3 Factur-X (ZUGFeRD) e-invoice, profile EN 16931, with the XML embedded; that mode needs more fields (`invoice_number`, `date`, `currency`, `due` or `payment_terms`, seller and buyer `country`, seller `vat_id`, a unit code per item) and names every missing one in the error. |
| `pdf_extract_pages` | Keep only the listed pages, in the order given (also reorders and duplicates) → write the result. |
| `pdf_delete_pages` | Remove the listed pages, keep the rest in order → write the result. |
| `pdf_rotate` | Rotate pages clockwise by 90, 180, 270 or -90 degrees; all pages unless `pages` is given. |
| `pdf_split` | Split into several PDFs by `ranges` or fixed-size `every` chunks → `part-1.pdf`, `part-2.pdf`, … in `output_dir`, or inline. |
| `pdf_watermark` | Stamp a diagonal text watermark (opacity, size, colour, position, page selection). |
| `pdf_page_numbers` | Print page numbers from a `{n}` / `{total}` template, with position, start number and margin. |
| `pdf_unlock` | Save without encryption so print/copy restrictions are gone. Does not crack unknown passwords. |
| `pdf_protect` | Encrypt with a user and/or owner password and a list of allowed permissions. |
| `pdf_metadata` | Read page count, per-page sizes and rotation, title/author/dates, encryption flag and form field count. |
| `pdf_set_metadata` | Write title, author, subject, creator and keywords. |
| `pdf_edit` | Stamp text, PNG/JPEG images (logos, signature images) and barcodes or QR codes at exact positions on chosen pages. |
| `pdf_extract_text` | Read the text and tables of a born-digital PDF, page by page. `tables_format` `csv` adds CSV to each table; `xlsx` returns the tables as one Excel workbook (one sheet per table), written to a `.xlsx` `output_path` or returned inline. No OCR. |
| `pdf_find_text` | Search a born-digital PDF for a word, phrase or regex and get each hit's page and box, in the same coordinates `pdf_edit` uses. |
| `pdf_text_to_pdf` | Markdown, plain text or CSV → a new PDF, with no HTML engine. |
| `pdf_html_to_pdf` | Render an HTML string to a PDF with a headless browser. Each render costs 5 requests of quota once the renderer is reached. |
| `pdf_image_to_pdf` | JPG and PNG images → a PDF, one image per page. |
| `pdf_detect_fields` | For a flat PDF with no fillable fields: detect the blanks drawn as lines, boxes, underscores and checkboxes and return text and checkbox fields (name from the nearest label, confidence, position) to review. Read-only. The entries can be passed to `pdf_add_fields`, and `pdf_fill` then fills the result. |
| `pdf_add_fields` | Create fillable AcroForm fields (text, checkbox, radio, dropdown, signature box) at exact positions, or with `detect: true` detect and add them on a flat PDF; `pdf_fill` fills them. |
| `pdf_add_attachment` | Embed files, such as an XML or CSV data file, in a PDF. |
| `pdfops_usage` | Quota check for the configured key. |

## Skill

Since 0.7.0 the package ships one Agent Skill, `pdf-workflows`, served over MCP (the Skills over MCP extension) next to the tools. It tells the model in what order to call the tools: read a form's fields with `pdf_inspect` before `pdf_fill`, detect and add fields on a flat PDF, what a scan cannot do, and which calls cost more quota. Claude Code 2.1.331 or later lists it as `/pdfops:pdf-workflows` when the server is registered as `pdfops`; other clients ignore it. To turn it off in Claude Code, add a deny rule `Skill(mcp__pdfops__*)` in `/permissions`. The tools work the same with or without it.

## Hosted endpoint (no install)

PDFops also runs this server for you at `https://pdfops.dev/api/mcp` (Streamable HTTP). It works without a key (keyless trial cap of 100 calls/IP/month); a free key from <https://pdfops.dev/pricing#free-key> raises the cap. Clients that support OAuth can instead sign in with an email address and a 6-digit code when the free allowance runs out (<https://pdfops.dev/mcp#sign-in>):

```bash
claude mcp add --transport http pdfops https://pdfops.dev/api/mcp
# with a key:
claude mcp add --transport http pdfops https://pdfops.dev/api/mcp --header "Authorization: Bearer $PDFOPS_API_KEY"
```

Sources must be `https://` URLs or `data:` URIs, and results come back inline. Setup for Cursor and VS Code: <https://pdfops.dev/mcp#remote>.

## Running remotely (Smithery, Glama hosted, cloud IDE gateways)

A hosted MCP runtime executes this server on a machine where your agent's file paths do not exist. Nothing changes in the config — pass sources the server can reach and skip `output_path`:

- **Inputs** (`pdf_path`, `pdf_paths`): an `https://` URL the server can fetch (≤4 MB per PDF, ≤4.5 MB per request — the API's limits), or a `data:application/pdf;base64,…` URI for small files.
- **Outputs**: omit `output_path` and the PDF-producing tools (`pdf_fill`, `pdf_merge`, `pdf_invoice`, `pdf_rotate`, …) return the PDF inline as an embedded `application/pdf` resource (`pdfops://filled.pdf`, …) that the client saves. `pdf_extract_text` with `tables_format: "xlsx"` returns its workbook the same way, as an embedded resource with the Excel media type (`pdfops://tables.xlsx`). With `output_path` set, the file is written where the *server* runs.

Locally, absolute paths keep working exactly as before and remain the recommended form — bytes stay off the model context.

## Example prompts

- *"What fields does ~/forms/fw9.pdf have?"* → `pdf_inspect`
- *"Fill ~/forms/fw9.pdf for Ada Lovelace, 12 Analytical Way, London; save it flattened as ~/out/w9-ada.pdf"* → `pdf_inspect`, then `pdf_fill` with `flatten: true`
- *"Fill the onboarding form once per row of contractors.csv into ~/out/"* → one `pdf_inspect`, then `pdf_fill` per row
- *"Merge ~/out/w9-ada.pdf, ~/docs/nda.pdf and ~/docs/cover.pdf into one packet, cover first"* → `pdf_merge`
- *"Invoice Globex for 3 days of consulting at $650, 8.5% tax, due in 30 days"* → `pdf_invoice`
- *"Drop pages 1-2 of ~/docs/scan.pdf and rotate the rest 90 degrees"* → `pdf_delete_pages`, then `pdf_rotate`
- *"Split ~/docs/report.pdf into 10-page chunks in ~/out/"* → `pdf_split` with `every: 10`, `output_dir`
- *"Pull every table out of ~/docs/statement.pdf into ~/out/tables.xlsx"* → `pdf_extract_text` with `tables_format: "xlsx"`
- *"Find where 'Total due' appears in ~/docs/invoice.pdf and stamp PAID next to it"* → `pdf_find_text`, then `pdf_edit`
- *"Make a German Factur-X invoice for Acme GmbH"* → `pdf_invoice` with `e_invoice: "factur-x"`
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
