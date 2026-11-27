// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Makes the fixtures for editing text in other scripts and layouts (Phase 6, step 3):
//
// - hebrew-text.pdf: right-to-left Hebrew, with numbers and Latin in some lines.
// - arabic-text.pdf: Arabic. Page 1's font maps its glyphs to Arabic Presentation Forms-B in
//   its ToUnicode map (as some producers write it), so each joined letter form can be found
//   again; page 2's maps every form back to its plain letter (as many producers write it), so
//   the forms can't be told apart. Chromium's "actual text" around each form is dropped on both.
// - three-columns.pdf: a newsletter page in three justified columns.
//
// The output is committed, so you only need to run this when changing one of these files.
// Requirements: Node 22+, `bun install`, Chromium for Playwright (`bunx playwright install
// chromium`, or pass `--chromium=<path>` to use another Chromium) and DejaVu Sans
// (`apt install fonts-dejavu-core`).
//
//   node fixtures/scripts/generate-text-scripts.mjs
//
// Everything here is fictional and released under CC0-1.0. DejaVu Sans keeps its own licence
// (see fixtures/README.md).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const sources = join(here, "sources");
const out = join(here, "..", "generated");

const requireFromCore = createRequire(join(root, "packages", "core", "package.json"));
const mupdf = await import(pathToFileURL(requireFromCore.resolve("mupdf")).href);
const { chromium } = createRequire(join(root, "package.json"))("playwright");

function dejaVu(style, file) {
  const path = execFileSync("fc-match", ["-f", "%{file}", `DejaVu Sans:style=${style}`], {
    encoding: "utf8",
  });
  if (!path.endsWith(`/${file}`)) {
    console.error(`DejaVu Sans ${style} isn't installed (fc-match gave ${path}). See the top.`);
    process.exit(1);
  }
  return new mupdf.Font(file, readFileSync(path));
}
const dejavu = {
  regular: dejaVu("Book", "DejaVuSans.ttf"),
  bold: dejaVu("Bold", "DejaVuSans-Bold.ttf"),
};

const write = (name, bytes) => {
  writeFileSync(join(out, name), bytes);
  console.log(`  ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
};

function save(doc) {
  const buffer = doc.saveToBuffer("garbage,compress");
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

const chromiumPath = process.argv.find((a) => a.startsWith("--chromium="))?.slice(11);
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
const pdfs = {};
try {
  const page = await browser.newPage();
  for (const name of ["hebrew", "arabic", "columns"]) {
    await page.goto(pathToFileURL(join(sources, `${name}.html`)).href);
    pdfs[name] = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  }
} finally {
  await browser.close();
}

console.log("Text in other scripts and layouts:");
write("hebrew-text.pdf", pdfs.hebrew);
write("three-columns.pdf", pdfs.columns);

// Arabic: the glyph each Presentation Forms character is drawn with, in DejaVu Sans. Chromium keeps the
// font's own glyph numbers in its subsets (CID = glyph), so they can be looked up.
function formsOf(font) {
  const forms = new Map();
  for (const [lo, hi] of [
    [0xfe70, 0xfefc],
    [0xfb50, 0xfdff],
  ]) {
    for (let cp = lo; cp <= hi; cp++) {
      const gid = font.encodeCharacter(cp);
      if (gid > 0 && !forms.has(gid)) forms.set(gid, cp);
    }
  }
  return forms;
}
const formGlyphs = { regular: formsOf(dejavu.regular), bold: formsOf(dejavu.bold) };
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

const toHex = (text) => [...text].map((c) => hex4(c.codePointAt(0))).join("");

/**
 * Give each Type0 font on a page a new ToUnicode map: every glyph Chromium mapped, with its
 * joined Arabic form (if it's one) mapped by `formText`, and drop Chromium's "actual text"
 * around each form, so the file is read through ToUnicode alone.
 */
function rewriteArabic(doc, formText) {
  let forms = 0;
  const pageObj = doc.findPage(0);
  pageObj
    .getInheritable("Resources")
    .get("Font")
    .forEach((ref) => {
      const font = ref.resolve();
      if (font.get("Subtype").asName() !== "Type0") return;
      const old = font.get("ToUnicode").readStream().asString();
      const formOf = /Bold/.test(font.get("BaseFont").asName())
        ? formGlyphs.bold
        : formGlyphs.regular;
      const mapped = new Map();
      for (const [, body] of old.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of body.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]+)>/g)) {
          mapped.set(Number.parseInt(m[1], 16), m[2].toUpperCase());
        }
      }
      for (const [, body] of old.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const m of body.matchAll(
          /<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>/g,
        )) {
          const lo = Number.parseInt(m[1], 16);
          const hi = Number.parseInt(m[2], 16);
          const first = Number.parseInt(m[3], 16);
          for (let cid = lo; cid <= hi; cid++) mapped.set(cid, hex4(first + cid - lo));
        }
      }
      // Glyphs Chromium left unmapped (it gave them as actual text) that are joined forms.
      for (const cid of formOf.keys()) {
        if (!mapped.has(cid) && old.includes(`<${hex4(cid)}>`)) mapped.set(cid, "");
      }
      const entries = [];
      for (const [cid, text] of [...mapped].sort((a, b) => a[0] - b[0])) {
        const form = formOf.get(cid);
        const value = form ? toHex(formText(String.fromCodePoint(form))) : text;
        if (form) forms++;
        if (value) entries.push(`<${hex4(cid)}> <${value}>`);
      }
      const cmap = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
        `${entries.length} beginbfchar`,
        ...entries,
        "endbfchar",
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
      ].join("\n");
      font.put("ToUnicode", doc.addStream(cmap, doc.newDictionary()));
    });
  if (forms < 10) throw new Error(`Only ${forms} joined Arabic forms found; check the font.`);
  const contents = pageObj.get("Contents");
  if (contents.isArray() && contents.length !== 1) throw new Error("Expected one content stream");
  const stream = contents.isArray() ? contents.get(0) : contents;
  const content = stream.readStream().asString();
  const stripped = content.replace(
    /\/Span<<\/ActualText <[0-9A-F]+> >> BDC\n([\s\S]*?)EMC\n/g,
    "$1",
  );
  if (stripped === content || stripped.includes("ActualText")) {
    throw new Error("Chromium's actual text spans weren't where they were expected");
  }
  pageObj.put("Contents", doc.addStream(stripped, doc.newDictionary()));
}

// Page 1: each joined form maps to its own Presentation Forms character. Page 2: every form
// maps back to its plain letter (as many producers write it), so the forms can't be told apart.
const arabic = mupdf.Document.openDocument(pdfs.arabic, "application/pdf").asPDF();
const plain = mupdf.Document.openDocument(pdfs.arabic, "application/pdf").asPDF();
rewriteArabic(arabic, (form) => form);
rewriteArabic(plain, (form) => form.normalize("NFKC"));
arabic.graftPage(-1, plain, 0);
write("arabic-text.pdf", save(arabic));
arabic.destroy();
plain.destroy();
