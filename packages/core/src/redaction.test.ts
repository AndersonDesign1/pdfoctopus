// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Redaction: marked text, images and drawings are removed for good, not covered. After
// applying, the saved file mustn't contain the removed text anywhere, which also means it
// can't be an incremental save (the original bytes would still be in it).

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";

const opened: PdfEngine[] = [];
afterEach(() => {
  for (const engine of opened.splice(0)) engine.close();
});

function open(bytes: Uint8Array): PdfEngine {
  const engine = new PdfEngine();
  opened.push(engine);
  engine.open(bytes);
  return engine;
}

/**
 * A 400 × 300 page with two lines of text, the second drawn inside a form XObject (as many
 * generated PDFs do), and a blue line across the bottom.
 */
function textPdf(rotate: 0 | 90 | 180 | 270 = 0): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
    const fonts = pdf.newDictionary();
    fonts.put("F1", font);
    const formResources = pdf.newDictionary();
    formResources.put("Font", fonts);
    const formDict = pdf.newDictionary();
    formDict.put("Type", pdf.newName("XObject"));
    formDict.put("Subtype", pdf.newName("Form"));
    const bbox = pdf.newArray();
    for (const v of [0, 0, 400, 300]) bbox.push(v);
    formDict.put("BBox", bbox);
    formDict.put("Resources", formResources);
    const form = pdf.addStream("BT /F1 18 Tf 40 160 Td (Account number 4417 1234) Tj ET", formDict);
    const xobjects = pdf.newDictionary();
    xobjects.put("X0", form);
    const resources = pdf.newDictionary();
    resources.put("Font", fonts);
    resources.put("XObject", xobjects);
    const content =
      "BT /F1 18 Tf 40 220 Td (Secret agent Bond here) Tj ET /X0 Do 0 0 1 RG 4 w 30 30 m 370 30 l S";
    pdf.insertPage(-1, pdf.addPage([0, 0, 400, 300], rotate, resources, content));
    return pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
}

/** All the text MuPDF can extract from a page of an open engine's document. */
function pageText(bytes: Uint8Array, page = 0): string {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const p = doc.loadPage(page);
    try {
      return p.toStructuredText("preserve-whitespace").asText().replace(/\s+/g, " ").trim();
    } finally {
      p.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** Where a phrase is on page 0, as [left, top, right, bottom] in points as shown. */
function boxOf(engine: PdfEngine, words: string): [number, number, number, number] {
  const hit = engine.search(words).hits.find((h) => h.page === 0);
  const q = hit?.quads[0];
  if (!q) throw new Error(`"${words}" not found`);
  const xs = [q[0], q[2], q[4], q[6]] as number[];
  const ys = [q[1], q[3], q[5], q[7]] as number[];
  return [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
}

function pixel(engine: PdfEngine, x: number, y: number): [number, number, number] {
  const { width, pixels } = engine.renderPage(0, 1);
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
}

describe("redaction", () => {
  it("removes the marked words, draws a black box, and leaves the rest", () => {
    const engine = open(textPdf());
    const box = boxOf(engine, "Bond");
    const marked = engine.addAnnotation({ kind: "redact", page: 0, rect: box });
    expect(marked.history.undoLabel).toBe("Mark for redaction");
    expect(marked.info.redactionMarks).toBe(1);
    // Marking alone removes nothing.
    expect(engine.search("Bond").hits).toHaveLength(1);

    const result = engine.applyRedactions();
    expect(result.history.undoLabel).toBe("Apply redactions");
    expect(result).toMatchObject({ pages: 1, annotationsRemoved: 0 });
    expect(result.info).toMatchObject({ redactionMarks: 0, redacted: true });
    expect(engine.search("Bond").hits).toHaveLength(0);
    expect(engine.search("Secret agent").hits).toHaveLength(1);
    const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    expect(pixel(engine, cx, cy)).toEqual([0, 0, 0]);
  });

  it("marks every search result in one step, including text inside form XObjects", () => {
    const engine = open(textPdf());
    const { hits } = engine.search("4417");
    expect(hits).toHaveLength(1);
    const marked = engine.markForRedaction(hits.map((h) => ({ page: h.page, quads: h.quads })));
    expect(marked.info.redactionMarks).toBe(1);
    expect(marked.history.undoLabel).toBe("Mark for redaction");
    engine.applyRedactions();
    expect(engine.search("4417").hits).toHaveLength(0);
    expect(engine.search("Account number").hits).toHaveLength(1);
  });

  it("saves a rewritten file with the text gone, never an incremental one", () => {
    const original = textPdf();
    const engine = open(original.slice());
    engine.addAnnotation({ kind: "redact", page: 0, rect: boxOf(engine, "Bond") });
    // Before applying, saving still appends.
    expect(engine.save().subarray(0, original.length)).toEqual(original);
    engine.applyRedactions();
    const saved = engine.save(); // asked for incremental, the default
    expect(saved.subarray(0, original.length)).not.toEqual(original);
    expect(pageText(saved)).not.toContain("Bond");
    expect(pageText(saved)).toContain("Secret agent");
    // Even uncompressed, the word is nowhere in the file's bytes.
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const raw = (doc.asPDF() as mupdf.PDFDocument).saveToBuffer("garbage,decompress").asString();
    doc.destroy();
    expect(raw).not.toContain("Bond");
    expect(raw).toContain("Secret agent");
  });

  it("deletes annotations under a mark (and a note's pop-up), and keeps the others", () => {
    const engine = open(textPdf());
    const box = boxOf(engine, "Bond");
    engine.addAnnotation({
      kind: "note",
      page: 0,
      at: [box[0] + 2, box[1] + 2],
      text: "Bond is the agent",
      color: [1, 1, 0],
    });
    engine.addAnnotation({
      kind: "rectangle",
      page: 0,
      rect: [300, 250, 350, 290],
      color: [1, 0, 0],
      width: 1,
    });
    engine.addAnnotation({ kind: "redact", page: 0, rect: box });
    const result = engine.applyRedactions();
    expect(result.annotationsRemoved).toBe(1);
    expect(engine.listAnnotations(0).map((a) => a.label)).toEqual(["rectangle"]);
    const saved = engine.save();
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const annots = (doc.asPDF() as mupdf.PDFDocument).findPage(0).get("Annots");
    expect(annots.length).toBe(1); // no orphaned pop-up
    doc.destroy();
    expect(pageText(saved)).not.toContain("Bond");
  });

  it("can be undone and redone until the file is saved", () => {
    const engine = open(textPdf());
    const box = boxOf(engine, "Bond");
    engine.addAnnotation({
      kind: "note",
      page: 0,
      at: [box[0] + 2, box[1] + 2],
      text: "hi",
      color: [1, 1, 0],
    });
    engine.addAnnotation({ kind: "redact", page: 0, rect: box });
    engine.markForRedaction(
      engine.search("4417").hits.map((h) => ({ page: h.page, quads: h.quads })),
    );
    engine.applyRedactions();
    expect(engine.search("Bond").hits).toHaveLength(0);
    expect(engine.search("4417").hits).toHaveLength(0);

    const undone = engine.undo();
    expect(undone?.info.redactionMarks).toBe(2);
    expect(engine.search("Bond").hits).toHaveLength(1);
    expect(engine.search("4417").hits).toHaveLength(1);
    expect(engine.listAnnotations(0).map((a) => a.label)).toEqual([
      "note",
      "redaction mark",
      "redaction mark",
    ]);

    engine.redo();
    expect(engine.search("Bond").hits).toHaveLength(0);
    expect(engine.search("4417").hits).toHaveLength(0);
    expect(engine.listAnnotations(0)).toEqual([]);
  });

  it("removes what's under the mark on a rotated page, as the page is shown", () => {
    const engine = open(textPdf(90));
    engine.addAnnotation({ kind: "redact", page: 0, rect: boxOf(engine, "Bond") });
    engine.applyRedactions();
    expect(engine.search("Bond").hits).toHaveLength(0);
    expect(engine.search("Secret agent").hits).toHaveLength(1);
  });

  it("removes a drawing that only partly lies under a mark", () => {
    // A thick blue line across the bottom of the page; mark only its middle.
    const engine = open(textPdf());
    engine.addAnnotation({ kind: "redact", page: 0, rect: [180, 260, 220, 280] });
    engine.applyRedactions();
    // Well outside the mark, the line is gone too: no part of it is left to recover.
    const [r, g, b] = pixel(engine, 60, 270);
    expect(b > 200 && r < 100 && g < 100).toBe(false);
  });

  it("empties a deleted comment, so nothing pointing at it keeps its text in the file", () => {
    const engine = open(textPdf());
    const box = boxOf(engine, "Bond");
    engine.addAnnotation({
      kind: "note",
      page: 0,
      at: [box[0] + 2, box[1] + 2],
      text: "Codename Nightingale",
      color: [1, 1, 0],
    });
    // A reply elsewhere on the page that points back at the comment (/IRT).
    const saved1 = engine.save();
    const doc = mupdf.Document.openDocument(saved1, "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const annots = pdf.findPage(0).get("Annots");
    const comment = annots.get(0);
    const reply = pdf.newDictionary();
    reply.put("Type", pdf.newName("Annot"));
    reply.put("Subtype", pdf.newName("Text"));
    const r = pdf.newArray();
    for (const v of [350, 20, 370, 40]) r.push(v);
    reply.put("Rect", r);
    reply.put("Contents", pdf.newString("Agreed"));
    reply.put("IRT", comment);
    annots.push(pdf.addObject(reply));
    const withReply = pdf.saveToBuffer("").asUint8Array().slice();
    doc.destroy();

    const e2 = open(withReply);
    e2.addAnnotation({ kind: "redact", page: 0, rect: boxOf(e2, "Bond") });
    e2.applyRedactions();
    const out = mupdf.Document.openDocument(e2.save(), "application/pdf");
    const raw = (out.asPDF() as mupdf.PDFDocument).saveToBuffer("garbage,decompress").asString();
    out.destroy();
    expect(raw).not.toContain("Nightingale");
    expect(raw).toContain("Agreed");
  });

  it("undoes fully when the page's annotation list is a shared object", () => {
    const original = textPdf();
    const doc = mupdf.Document.openDocument(original, "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const note = pdf.newDictionary();
    note.put("Type", pdf.newName("Annot"));
    note.put("Subtype", pdf.newName("Text"));
    const r = pdf.newArray();
    for (const v of [100, 215, 120, 235]) r.push(v); // PDF space: on the first line
    note.put("Rect", r);
    note.put("Contents", pdf.newString("Codename Nightingale"));
    const annots = pdf.newArray();
    annots.push(pdf.addObject(note));
    pdf.findPage(0).put("Annots", pdf.addObject(annots)); // an indirect /Annots array
    const indirect = pdf.saveToBuffer("").asUint8Array().slice();
    doc.destroy();

    const engine = open(indirect);
    engine.addAnnotation({ kind: "redact", page: 0, rect: [30, 60, 370, 100] });
    expect(engine.applyRedactions().annotationsRemoved).toBe(1);
    expect(engine.listAnnotations(0)).toEqual([]);
    engine.undo();
    const labels = engine.listAnnotations(0).map((a) => a.label);
    expect(labels).toEqual(["note", "redaction mark"]);
    expect(engine.listAnnotations(0)[0]?.text).toBe("Codename Nightingale");
  });

  it("refuses to redact over a form field, changing nothing", () => {
    const original = textPdf();
    const doc = mupdf.Document.openDocument(original, "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const widget = pdf.newDictionary();
    widget.put("Type", pdf.newName("Annot"));
    widget.put("Subtype", pdf.newName("Widget"));
    widget.put("FT", pdf.newName("Tx"));
    widget.put("T", pdf.newString("name"));
    widget.put("V", pdf.newString("Bond"));
    const rect = pdf.newArray();
    for (const v of [30, 205, 370, 245]) rect.push(v); // PDF space: around the first line
    widget.put("Rect", rect);
    const annots = pdf.newArray();
    annots.push(pdf.addObject(widget));
    pdf.findPage(0).put("Annots", annots);
    const withField = pdf.saveToBuffer("").asUint8Array().slice();
    doc.destroy();

    const engine = open(withField);
    engine.addAnnotation({ kind: "redact", page: 0, rect: boxOf(engine, "Bond") });
    const history = engine.history();
    expect(() => engine.applyRedactions()).toThrow(/covers a form field/);
    expect(engine.history()).toEqual(history);
    expect(engine.info()).toMatchObject({ redactionMarks: 1, redacted: false });
    expect(engine.search("Bond").hits).toHaveLength(1);
  });

  it("lets an area mark be resized, and a mark over words only moved", () => {
    const engine = open(textPdf());
    engine.addAnnotation({ kind: "redact", page: 0, rect: [20, 20, 80, 50] });
    engine.markForRedaction(
      engine.search("Bond").hits.map((h) => ({ page: h.page, quads: h.quads })),
    );
    const [area, words] = engine.listAnnotations(0);
    expect(area).toMatchObject({ label: "redaction mark", canResize: true });
    expect(words).toMatchObject({ label: "redaction mark", canResize: false });
  });

  it("refuses bad marks, and applying with nothing marked", () => {
    const engine = open(createBlankPdf(1));
    expect(() => engine.applyRedactions()).toThrow(/Nothing is marked/);
    expect(() => engine.markForRedaction([])).toThrow(/nothing to mark/);
    expect(() => engine.markForRedaction([{ page: 0, quads: [[1, 2, 3]] }])).toThrow(/isn't valid/);
    expect(() =>
      engine.markForRedaction([{ page: 5, quads: [[0, 0, 1, 0, 0, 1, 1, 1]] }]),
    ).toThrow();
    expect(engine.info().redactionMarks).toBe(0);
    expect(engine.history().canUndo).toBe(false);
  });
});
