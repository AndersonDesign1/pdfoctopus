// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regenerates the files in fixtures/generated/. The output is committed, so you only need
// to run this when changing a generated fixture.
//
// Requirements:
// - Node 22+ and `bun install` (MuPDF and Playwright come from the workspace)
// - Chromium for Playwright: `bunx playwright install chromium`
// - LibreOffice (`soffice` on the PATH)
// - The fonts the sources use (checked below). On Debian/Ubuntu:
//   `apt install fonts-dejavu-core fonts-liberation fonts-inter fonts-wqy-zenhei`
//   (LibreOffice uses Inter for the contract's headings.) The committed fixtures were made
//   on Linux; the font check needs fontconfig and is skipped with a warning without it.
// - Python 3 with pyhanko: `pip install -r fixtures/scripts/requirements.txt`
//
//   node fixtures/scripts/generate.mjs
//
// Everything generated here is fictional and released under CC0-1.0. Fonts embedded in the
// output keep their own licences (listed in fixtures/README.md).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const sources = join(here, "sources");
const out = join(here, "..", "generated");
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pdfo-fixtures-"));

// Without these fonts, Chromium silently substitutes others (or draws empty boxes for CJK),
// and the regenerated fixtures would differ from the committed ones.
const REQUIRED_FONTS = ["DejaVu Sans", "Liberation Serif", "Inter", "WenQuanYi Zen Hei"];
let installedFonts = null;
try {
  installedFonts = execFileSync("fc-list", [":", "family"], { encoding: "utf8" });
} catch (error) {
  // Only a missing fc-list skips the check; any other failure (e.g. broken fontconfig) stops.
  if (error.code !== "ENOENT") throw error;
  console.warn(
    `Warning: can't list fonts (fontconfig's fc-list isn't available). Make sure these are ` +
      `installed, or the output will differ: ${REQUIRED_FONTS.join(", ")}`,
  );
}
if (installedFonts !== null) {
  const families = new Set(installedFonts.split(/[,\n]/).map((f) => f.trim()));
  const missingFonts = REQUIRED_FONTS.filter((font) => !families.has(font));
  if (missingFonts.length > 0) {
    console.error(`Missing fonts: ${missingFonts.join(", ")}. See the requirements at the top.`);
    process.exit(1);
  }
}

const requireFromCore = createRequire(join(root, "packages", "core", "package.json"));
const mupdf = await import(pathToFileURL(requireFromCore.resolve("mupdf")).href);
const { chromium } = createRequire(join(root, "package.json"))("playwright");

const write = (name, bytes) => {
  writeFileSync(join(out, name), bytes);
  console.log(`  ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
};
const read = (name) => readFileSync(join(out, name));

function saveDoc(doc, options = "garbage,compress") {
  const buffer = doc.saveToBuffer(options);
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

function openPdf(bytes) {
  return mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
}

// ---------------------------------------------------------------------------------------
// 1. Chromium (Skia/PDF): invoice, contract, CJK, and a 500-page report
// ---------------------------------------------------------------------------------------

function longReportHtml(pages) {
  const lorem =
    "This quarterly operations report summarises activity across all regional offices. " +
    "Figures are illustrative only and do not describe any real organisation. ";
  let body = "";
  for (let i = 1; i <= pages; i++) {
    body += `<section><h2>Section ${i}: Regional summary</h2>`;
    body += `<p>${lorem.repeat(6)}</p>`;
    body += `<table><tr><th>Metric</th><th>Q1</th><th>Q2</th><th>Q3</th></tr>`;
    for (let r = 1; r <= 6; r++) {
      body += `<tr><td>Metric ${r}</td><td>${(i * r) % 97}</td><td>${(i * r * 3) % 89}</td><td>${(i * r * 7) % 83}</td></tr>`;
    }
    body += `</table><p>${lorem.repeat(4)}</p></section>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operations report</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Sans",sans-serif;font-size:10pt;line-height:1.4}
section{page-break-after:always}table{border-collapse:collapse;width:100%;margin:10px 0}
td,th{border:1px solid #999;padding:3px 6px;text-align:right}th:first-child,td:first-child{text-align:left}</style>
</head><body>${body}</body></html>`;
}

console.log("Chromium:");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [source, name] of [
    ["invoice.html", "invoice.pdf"],
    ["contract.html", "contract-chromium.pdf"],
    ["cjk.html", "cjk-text.pdf"],
  ]) {
    await page.goto(pathToFileURL(join(sources, source)).href);
    write(name, await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  }
  await page.setContent(longReportHtml(500));
  write("report-500-pages.pdf", await page.pdf({ preferCSSPageSize: true }));
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------------------
// 2. LibreOffice: the same contract through a different producer
// ---------------------------------------------------------------------------------------

console.log("LibreOffice:");
execFileSync(
  "soffice",
  [
    "--headless",
    "--convert-to",
    "pdf:writer_web_pdf_Export",
    "--outdir",
    tmp,
    join(sources, "contract.html"),
  ],
  { stdio: "ignore" },
);
copyFileSync(join(tmp, "contract.pdf"), join(out, "contract-libreoffice.pdf"));
console.log(`  contract-libreoffice.pdf`);

// ---------------------------------------------------------------------------------------
// 3. MuPDF: encryption, annotations, scans, incremental updates, malformed files
// ---------------------------------------------------------------------------------------

console.log("MuPDF:");

// Encryption. Passwords are listed in fixtures/README.md.
{
  const doc = openPdf(read("invoice.pdf"));
  write(
    "encrypted-aes256.pdf",
    saveDoc(doc, "encrypt=aes-256,user-password=open-sesame,owner-password=owner-secret"),
  );
  write(
    "encrypted-rc4-40.pdf",
    saveDoc(doc, "encrypt=rc4-40,user-password=open-sesame,owner-password=owner-secret"),
  );
  // No open password, but printing, copying, editing and assembling are not permitted.
  // Permission bits (PDF 32000-1, table 22): 4 print, 8 modify, 16 copy, 32 annotate,
  // 256 fill forms, 512 accessibility, 1024 assemble, 2048 high-quality print.
  const permissions = ~(3 | 4 | 8 | 16 | 32 | 1024 | 2048);
  write(
    "restricted-permissions.pdf",
    saveDoc(doc, `encrypt=aes-256,owner-password=owner-secret,permissions=${permissions}`),
  );
  doc.destroy();
}

// Common annotation types on the contract.
{
  const doc = openPdf(read("contract-chromium.pdf"));
  const page = doc.loadPage(0);
  const highlight = page.createAnnotation("Highlight");
  highlight.setColor([1, 0.9, 0]);
  highlight.setQuadPoints([[72, 150, 400, 150, 72, 165, 400, 165]]);
  const note = page.createAnnotation("Text");
  note.setRect([520, 100, 540, 120]);
  note.setContents("Please check the renewal period.");
  note.setAuthor("Reviewer");
  const ink = page.createAnnotation("Ink");
  ink.setColor([0, 0, 1]);
  ink.setInkList([
    [
      [100, 700],
      [130, 680],
      [160, 710],
      [190, 690],
    ],
  ]);
  const box = page.createAnnotation("Square");
  box.setColor([1, 0, 0]);
  box.setRect([70, 300, 300, 360]);
  const text = page.createAnnotation("FreeText");
  text.setRect([330, 300, 540, 340]);
  text.setContents("Approved by legal");
  const strike = page.createAnnotation("StrikeOut");
  strike.setColor([1, 0, 0]);
  strike.setQuadPoints([[72, 400, 300, 400, 72, 414, 300, 414]]);
  for (const a of page.getAnnotations()) a.update();
  write("annotated-contract.pdf", saveDoc(doc));
  doc.destroy();
}

// Several incremental updates (revisions) appended to one file.
{
  let bytes = read("invoice.pdf");
  for (const [i, label] of ["Received", "Checked", "Paid"].entries()) {
    const doc = openPdf(bytes);
    const page = doc.loadPage(0);
    const stamp = page.createAnnotation("FreeText");
    stamp.setRect([380, 700 - i * 30, 560, 725 - i * 30]);
    stamp.setContents(`${label} – revision ${i + 2}`);
    stamp.update();
    bytes = saveDoc(doc, "incremental");
    doc.destroy();
  }
  write("incremental-updates.pdf", bytes);
}

// A "scan": the invoice rendered slightly rotated, in grey with noise, saved as a JPEG-only page.
{
  const source = mupdf.Document.openDocument(read("invoice.pdf"), "application/pdf");
  const page = source.loadPage(0);
  const dpi = 150;
  const matrix = mupdf.Matrix.concat(
    mupdf.Matrix.scale(dpi / 72, dpi / 72),
    mupdf.Matrix.rotate(0.8),
  );
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceGray, false, true);
  const pixels = pixmap.getPixels();
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed % 31) - 15;
    pixels[i] = Math.max(0, Math.min(255, pixels[i] * 0.92 + 12 + noise));
  }
  const jpeg = pixmap.asJPEG(70);
  const doc = new mupdf.PDFDocument();
  const image = doc.addImage(new mupdf.Image(jpeg));
  const width = (pixmap.getWidth() * 72) / dpi;
  const height = (pixmap.getHeight() * 72) / dpi;
  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put("Im0", image);
  resources.put("XObject", xobjects);
  const pageObj = doc.addPage(
    [0, 0, width, height],
    0,
    resources,
    `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`,
  );
  doc.insertPage(-1, pageObj);
  doc.setMetaData("info:Title", "Scanned invoice (simulated)");
  write("scanned-invoice.pdf", saveDoc(doc));
  doc.destroy();
  source.destroy();
}

// Malformed files.
{
  const invoice = read("invoice.pdf");
  write("malformed-truncated.pdf", invoice.subarray(0, Math.floor(invoice.length * 0.6)));

  const text = Buffer.from(invoice).toString("latin1");
  const at = text.lastIndexOf("startxref");
  const broken = text.slice(0, at) + text.slice(at).replace(/startxref\s+\d+/, "startxref\n999999");
  write("malformed-bad-startxref.pdf", Buffer.from(broken, "latin1"));

  const junk = Buffer.alloc(1024, "This is junk before the PDF header. ");
  write("malformed-junk-before-header.pdf", Buffer.concat([junk, invoice]));

  write(
    "malformed-html-named-pdf.pdf",
    Buffer.from(
      "<!doctype html><html><head><title>404 Not Found</title></head>" +
        "<body><h1>Not Found</h1><p>The requested document was not found.</p></body></html>\n",
    ),
  );
  write("malformed-empty.pdf", Buffer.alloc(0));
}

// ---------------------------------------------------------------------------------------
// 4. pyhanko: digitally signed files (self-signed test certificate, not trusted)
// ---------------------------------------------------------------------------------------

console.log("pyhanko:");
execFileSync("python3", [join(here, "sign.py"), out], { stdio: "inherit" });

// A sticky note added after signing, saved incrementally by MuPDF the way PDFoctopus will.
{
  const doc = openPdf(read("signed.pdf"));
  const note = doc.loadPage(0).createAnnotation("Text");
  note.setRect([500, 780, 520, 800]);
  note.setContents("Added after signing");
  note.update();
  write("signed-then-annotated.pdf", saveDoc(doc, "incremental"));
  doc.destroy();
}

rmSync(tmp, { recursive: true, force: true });
console.log("Done.");
