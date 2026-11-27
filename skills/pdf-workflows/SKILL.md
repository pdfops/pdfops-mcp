---
name: pdf-workflows
description: Use when a task involves PDF files, such as filling a PDF form, making a flat PDF fillable, merging, splitting or editing pages, creating PDFs or invoices, or extracting text and tables. Explains the order in which to call the PDFops tools.
license: MIT
---

# PDF workflows with the PDFops tools

This skill describes how to use the PDFops MCP tools (`pdf_*` and `pdfops_usage`). Each tool's own description has the full parameter list. This page covers the order of calls and the facts that are easy to miss.

## Sources and outputs

- A PDF input is one of: a local path to a `.pdf` file inside `PDFOPS_ROOT` (default: the directory the server was started in, or the home directory when that is `/`), a public `https://` URL, or a `data:application/pdf;base64,...` URI.
- Paths outside `PDFOPS_ROOT` are refused. A local PDF input must be a real PDF file, and a file that is not one is refused. A PDF given as a PDF input is read even from a dot-folder inside the root. The non-PDF files some tools read (images and attachments, including a `.pdf` passed as an attachment) are never read when any path component below the root starts with a dot (such as `.env` or `.config/`).
- To write a result to disk, pass `output_path` (a `.pdf` path inside `PDFOPS_ROOT`; an existing file there is overwritten). `pdf_split` takes `output_dir` instead and writes `part-1.pdf`, `part-2.pdf`, and so on.
- Without `output_path`, the PDF is returned inline as an `application/pdf` resource. Prefer `output_path` when running locally: the bytes then stay out of the model context. Inline results over 7 MB are refused.
- The API limits are 4 MB per PDF and 4.5 MB per request.

## Fill a form that already has fields

1. Call `pdf_inspect` on the PDF. It lists each field's name, type, options, current value and `maxLength`, and returns a `fillTemplate` object.
2. Call `pdf_fill` with `fields` set to an object of field name to string value. Use the exact names and, for dropdowns and radio groups, one of the option values that `pdf_inspect` returned. Checkboxes take `"true"` or `"false"`. All values are strings. Keep text within `maxLength`.
3. `pdf_fill` rejects unknown field names and over-length values and writes no file when it rejects. Fix the input and call it again.
4. A PDF with a user password needs the `password` parameter. A file that is only owner-locked (empty user password) opens without one.

Pass `flatten: true` to `pdf_fill` only when the result should no longer be editable: it bakes the values in and removes the form fields.

If `pdf_inspect` returns `count: 0` and `truncated` is not `true`, the PDF has no fillable fields. Use the next section.

## Make a flat PDF fillable

A flat PDF shows blanks as drawing only. `pdf_inspect` lists nothing for it.

1. Call `pdf_detect_fields`. It finds blanks drawn as lines, boxes, underscores and checkboxes, and returns text and checkbox suggestions with a name from the nearest printed label, a position and a `confidence` from 0 to 1. It is read-only.
2. Review the suggestions. Drop wrong ones (some are table cells or rules, not blanks), rename or adjust others. Raising `min_confidence` (default 0.4) gives fewer, surer fields.
3. Pass the kept entries to `pdf_add_fields` as `fields`. `label` and `confidence` are ignored there, so entries can be passed as returned. This writes a new PDF with real form fields.
4. Call `pdf_inspect` on the new PDF to confirm the field names, then `pdf_fill`.

Shortcut: `pdf_add_fields` with `detect: true` detects and adds in one call, with no review step. Use it when review is not needed.

`pdf_add_fields` can also create fields at exact positions without detection: text, multiline text, checkbox, radio group, dropdown and an empty signature box. Coordinates are PDF points from the bottom-left corner of the page (US Letter is 612 x 792). The signature type only creates an empty field; nothing is signed.

### Long documents

One call analyses at most `max_pages` pages (default 40, at most 100) and returns at most 200 fields. When the result has `truncated: true`:

1. Add the returned fields with `pdf_add_fields`.
2. Call `pdf_detect_fields` on the resulting PDF with `pages` set to the returned `next_pages`.
3. Repeat until `truncated` is `false`.

If a round returns `truncated: true` with zero fields, skip `pdf_add_fields`, which rejects an empty list. Call `pdf_detect_fields` again on the same PDF with `pages` set to `next_pages`, but only while `next_pages` differs from the pages just requested. If a round returns zero fields and the same `next_pages` as it was sent, stop and report those pages as not analysed.

Sending the original PDF again repeats the same names and is not supported. A page listed in `pages_skipped` with reason `too_complex` has more drawn shapes or text than the per-page limits. It is skipped for good, and sending it again gives the same answer. A page skipped with reason `deadline` is included in `next_pages`.

## Scanned PDFs

There is no OCR. A scanned page is a picture, so there is nothing to detect and no text to extract. `pdf_detect_fields` returns zero fields with a note, and `pdf_extract_text` and `pdf_find_text` list the page in `pages_without_text`. Zero fields is a normal answer, not an error. Detection also misses blanks that are only empty space or shaded cells with no outline.

## Read text and tables

- `pdf_extract_text` reads the text and tables of a born-digital PDF, page by page. `tables_format` can be `csv` (adds CSV to each table) or `xlsx` (one workbook, one sheet per table, written to a `.xlsx` `output_path` or returned inline). If an xlsx result reports `truncated`, `truncated_by` says why. A cut by `pages` or `output` can be continued by calling again with `pages` set to the pages not yet in the workbook. A cut by `sheets` can be continued too: the sheet cap counts tables across the selected pages, so call again with `pages` starting at the page of the last sheet returned (that page may have lost some of its tables) and ignore the sheets already held. Row and column caps cannot be continued that way.
- `pdf_find_text` searches for a word, phrase or regex and returns each hit's page and box, in the same coordinates `pdf_edit` uses. Combine them to stamp something next to a found phrase.
- `pdf_metadata` returns page count, page sizes, document info and the form field count.

## Combine and edit pages

- `pdf_merge`: two or more PDFs in the order given.
- `pdf_extract_pages`: keep only the listed pages, in the order given. This also reorders and duplicates pages.
- `pdf_delete_pages`: remove the listed pages and keep the rest.
- `pdf_rotate`: 90, 180, 270 or -90 degrees clockwise; all pages unless `pages` is given.
- `pdf_split`: by `ranges` or by `every` N pages, into `output_dir` or inline.
- Page numbers are 1-based. After deleting or extracting pages, the numbers shift; run `pdf_metadata` if unsure how many pages remain.

## Create PDFs

- `pdf_invoice`: a complete invoice from structured data. Same input gives byte-identical output. Setting `invoice.e_invoice` to `"factur-x"` makes a Factur-X (ZUGFeRD) EN 16931 e-invoice. That mode needs more fields, and the error names each missing one.
- `pdf_text_to_pdf`: Markdown, plain text or CSV to a new PDF. It does not render HTML or CSS, and only Western European characters are supported.
- `pdf_html_to_pdf`: renders an HTML string (not a URL) with a headless browser. JavaScript is off.
- `pdf_image_to_pdf`: JPG and PNG images, one image per page.

## Quota

- Without an API key the server uses the keyless trial: 100 requests per month per IP address. A free key (set `PDFOPS_API_KEY`) allows 250 requests per month.
- `pdf_html_to_pdf` counts as 5 requests, not 1, when the render reaches the renderer.
- Check `pdfops_usage` before a large batch of calls. It shows the tier, limit, used and remaining quota, and it needs `PDFOPS_API_KEY`.

## Tool reference

| Task | Tool |
|---|---|
| List form fields and get a fill template | `pdf_inspect` |
| Fill form fields, optionally flatten | `pdf_fill` |
| Find blanks on a flat PDF | `pdf_detect_fields` |
| Add form fields, or detect and add | `pdf_add_fields` |
| Merge PDFs | `pdf_merge` |
| Keep, remove or reorder pages | `pdf_extract_pages`, `pdf_delete_pages` |
| Rotate pages | `pdf_rotate` |
| Split into several PDFs | `pdf_split` |
| Stamp text, images, barcodes or QR codes | `pdf_edit` |
| Diagonal text watermark | `pdf_watermark` |
| Page numbers | `pdf_page_numbers` |
| Read text and tables | `pdf_extract_text` |
| Search for text with positions | `pdf_find_text` |
| Page count, sizes, document info | `pdf_metadata` |
| Write title, author, subject, keywords | `pdf_set_metadata` |
| Embed files such as XML or CSV | `pdf_add_attachment` |
| Remove encryption and restrictions | `pdf_unlock` |
| Encrypt with passwords and permissions | `pdf_protect` |
| Invoice from data | `pdf_invoice` |
| PDF from Markdown, text or CSV | `pdf_text_to_pdf` |
| PDF from an HTML string | `pdf_html_to_pdf` |
| PDF from images | `pdf_image_to_pdf` |
| Remaining quota | `pdfops_usage` |

`pdf_unlock` removes encryption and print or copy restrictions from a file the caller can already open. It does not recover unknown passwords.
