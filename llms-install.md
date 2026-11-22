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
- `pdf_invoice`: generate a deterministic invoice PDF from structured data; `invoice.e_invoice: "factur-x"` makes a Factur-X (ZUGFeRD) EN 16931 e-invoice
- `pdf_extract_pages` — keep only the listed pages, in the order given
- `pdf_delete_pages` — remove the listed pages
- `pdf_rotate` — rotate pages clockwise by 90, 180, 270 or -90 degrees
- `pdf_split` — split a PDF into several PDFs by ranges or chunk size; writes to `output_dir` or returns each part inline
- `pdf_watermark` — stamp a diagonal text watermark
- `pdf_page_numbers` — print page numbers from a `{n}` / `{total}` template
- `pdf_unlock` — save without encryption (does not crack unknown passwords)
- `pdf_protect` — encrypt with user/owner passwords and permissions
- `pdf_metadata` — read page count, page sizes and document info
- `pdf_set_metadata` — write title, author, subject, creator, keywords
- `pdf_edit`: stamp text, images and barcodes or QR codes at exact positions
- `pdf_extract_text`: read text and tables of a born-digital PDF; `tables_format` `csv` or `xlsx` (a `.xlsx` workbook, written to `output_path` or returned inline)
- `pdf_find_text`: search a PDF for text or a regex, with page positions
- `pdf_text_to_pdf`: make a PDF from Markdown, plain text or CSV
- `pdf_html_to_pdf`: render an HTML string to a PDF
- `pdf_image_to_pdf`: make a PDF from JPG and PNG images
- `pdf_add_fields`: create fillable form fields at exact positions
- `pdf_add_attachment`: embed files in a PDF
- `pdfops_usage` — quota for the configured key

Inputs accept absolute file paths, `https://` URLs, or `data:application/pdf;base64,…` URIs. Image inputs (`pdf_image_to_pdf`, image stamps in `pdf_edit`) take `.png`, `.jpg` or `.jpeg` paths, URLs or `data:image/…` URIs; `pdf_add_attachment` sources take paths, URLs or `data:` URIs. Omit `output_path` (`output_dir` for `pdf_split`) to receive the PDF inline as an `application/pdf` resource; `pdf_extract_text` with `tables_format: "xlsx"` returns an Excel workbook resource instead, or writes a `.xlsx` file to `output_path`.
