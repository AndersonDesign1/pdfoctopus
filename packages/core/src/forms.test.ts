// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Filling in forms on real files: a LibreOffice form (text, checkboxes, radio buttons and a
// dropdown) and the IRS W-9, a "hybrid" form with an XFA copy.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPdf, type FormField, PdfEngine } from "./engine";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const LIBREOFFICE = join(fixtures, "third-party/py-pdf/012-libreoffice-form_libreoffice-form.pdf");
const W9 = join(fixtures, "public-domain/irs-form-w9.pdf");
const read = (path: string) => new Uint8Array(readFileSync(path));

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

function field(engine: PdfEngine, test: (f: FormField) => boolean, page = 0): FormField {
  const found = engine.listFields(page).find(test);
  if (!found) throw new Error("No such field");
  return found;
}

/** A saved file's field values, read back with MuPDF, by field name. */
function savedValues(bytes: Uint8Array): Record<string, string> {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    expect(pdf.wasRepaired()).toBe(false);
    const out: Record<string, string> = {};
    const page = pdf.loadPage(0);
    for (const w of page.getWidgets()) out[w.getName()] = w.getValue();
    page.destroy();
    return out;
  } finally {
    doc.destroy();
  }
}

/** All the text on page 0, including form appearances that are now page content. */
function pageText(engine: PdfEngine): string {
  const bytes = engine.save({ incremental: false });
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return doc.loadPage(0).toStructuredText("preserve-whitespace").asText();
  } finally {
    doc.destroy();
  }
}

describe("listFields", () => {
  it("lists each kind of field with what's needed to fill it in", () => {
    const engine = open(read(LIBREOFFICE));
    const fields = engine.listFields(0);
    const kinds = new Set(fields.map((f) => f.kind));
    expect(kinds).toEqual(new Set(["text", "radio", "combobox", "checkbox"]));
    const dropdown = field(engine, (f) => f.kind === "combobox");
    expect(dropdown.options.map((o) => o.label)).toContain("German");
    expect(dropdown.options.every((o) => o.value.length > 0)).toBe(true);
    for (const f of fields) {
      expect(f.rect[2]).toBeGreaterThan(f.rect[0]);
      expect(f.rect[3]).toBeGreaterThan(f.rect[1]);
    }
    expect(engine.info().form).toEqual({ fields: fields.length, xfa: "none" });
  });
});

describe("setFieldValue", () => {
  it("fills in a text field, as one undoable step, and saves by appending", () => {
    const original = read(LIBREOFFICE);
    const engine = open(original.slice());
    const text = field(engine, (f) => f.kind === "text");
    const result = engine.setFieldValue(0, text.id, "Jane Example");
    expect(result.history.undoLabel).toBe("Fill in form field");
    expect(field(engine, (f) => f.id === text.id).value).toBe("Jane Example");

    const saved = engine.save();
    expect(saved.subarray(0, original.length)).toEqual(original);
    expect(savedValues(saved)[text.name]).toBe("Jane Example");

    engine.undo();
    expect(field(engine, (f) => f.id === text.id).value).toBe(text.value);
    engine.redo();
    expect(field(engine, (f) => f.id === text.id).value).toBe("Jane Example");
  });

  it("shows the typed text when the form is flattened", () => {
    const engine = open(read(LIBREOFFICE));
    const text = field(engine, (f) => f.kind === "text");
    engine.setFieldValue(0, text.id, "Quokka Example");
    expect(pageText(engine)).not.toContain("Quokka"); // a form value, not page text yet
    const flat = engine.flattenForm();
    expect(flat.history.undoLabel).toBe("Flatten form");
    expect(flat.info.form.fields).toBe(0);
    expect(engine.listFields(0)).toEqual([]);
    expect(pageText(engine)).toContain("Quokka Example");

    engine.undo();
    expect(engine.info().form.fields).toBeGreaterThan(0);
    expect(field(engine, (f) => f.id === text.id).value).toBe("Quokka Example");
  });

  it("ticks and unticks a checkbox", () => {
    const engine = open(read(LIBREOFFICE));
    const box = field(engine, (f) => f.kind === "checkbox");
    engine.setFieldValue(0, box.id, !box.checked);
    expect(field(engine, (f) => f.id === box.id).checked).toBe(!box.checked);
    engine.setFieldValue(0, box.id, box.checked);
    expect(field(engine, (f) => f.id === box.id).checked).toBe(box.checked);
    engine.undo();
    expect(field(engine, (f) => f.id === box.id).checked).toBe(!box.checked);
  });

  it("chooses a radio button and turns the others in its group off", () => {
    const engine = open(read(LIBREOFFICE));
    const radios = engine.listFields(0).filter((f) => f.kind === "radio");
    expect(radios.length).toBeGreaterThanOrEqual(2);
    const [a, b] = radios as [FormField, FormField];
    engine.setFieldValue(0, a.id, true);
    engine.setFieldValue(0, b.id, true);
    const now = engine.listFields(0).filter((f) => f.kind === "radio");
    expect(now.find((f) => f.id === b.id)?.checked).toBe(true);
    expect(now.find((f) => f.id === a.id)?.checked).toBe(false);
    engine.undo();
    expect(field(engine, (f) => f.id === a.id).checked).toBe(true);
  });

  it("picks a dropdown option, and refuses one that isn't offered", () => {
    const engine = open(read(LIBREOFFICE));
    const dropdown = field(engine, (f) => f.kind === "combobox");
    const german = dropdown.options.find((o) => o.label === "German");
    engine.setFieldValue(0, dropdown.id, german?.value ?? "German");
    expect(field(engine, (f) => f.id === dropdown.id).value).toBe(german?.value);
    expect(() => engine.setFieldValue(0, dropdown.id, "Martian")).toThrow(
      /isn't one of the options/,
    );
  });

  it("refuses wrong values and read-only fields, changing nothing", () => {
    const bytes = read(LIBREOFFICE);
    // Make the first text field read-only.
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const page = pdf.loadPage(0);
    const first = page.getWidgets().find((w) => w.isText()) as mupdf.PDFWidget;
    const firstId = first.getObject().asIndirect();
    const target = first.getObject().get("FT").isNull()
      ? first.getObject().get("Parent")
      : first.getObject();
    target.put("Ff", 1);
    page.destroy();
    const readOnly = pdf.saveToBuffer("").asUint8Array().slice();
    doc.destroy();

    const engine = open(readOnly);
    const history = engine.history();
    expect(field(engine, (f) => f.id === firstId).readOnly).toBe(true);
    expect(() => engine.setFieldValue(0, firstId, "x")).toThrow(/read-only/);
    const box = field(engine, (f) => f.kind === "checkbox");
    expect(() => engine.setFieldValue(0, box.id, "yes")).toThrow(/ticked or not/);
    const radio = field(engine, (f) => f.kind === "radio");
    expect(() => engine.setFieldValue(0, radio.id, false)).toThrow(/only be chosen/);
    expect(() => engine.setFieldValue(0, 999999, "x")).toThrow(/not on the page/);
    expect(engine.history()).toEqual(history);
  });

  it("records nothing when the value doesn't change", () => {
    const engine = open(read(LIBREOFFICE));
    const text = field(engine, (f) => f.kind === "text");
    engine.setFieldValue(0, text.id, text.value);
    expect(engine.history().canUndo).toBe(false);
  });
});

describe("XFA", () => {
  it("fills in a hybrid form and removes its XFA copy, which undo puts back", () => {
    const engine = open(read(W9));
    expect(engine.info().form.xfa).toBe("hybrid");
    const name = field(engine, (f) => f.kind === "text");
    const result = engine.setFieldValue(0, name.id, "Jane Example");
    expect(result.info.form.xfa).toBe("none");
    const saved = engine.save();
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const form = (doc.asPDF() as mupdf.PDFDocument).getTrailer().get("Root").get("AcroForm");
    expect(form.get("XFA").isNull()).toBe(true);
    doc.destroy();
    expect(savedValues(saved)[name.name]).toBe("Jane Example");

    engine.undo();
    expect(engine.info().form.xfa).toBe("hybrid");
  });

  it("recognises a form that's only XFA, which can't be filled in", () => {
    const pdf = new mupdf.PDFDocument();
    pdf.insertPage(-1, pdf.addPage([0, 0, 300, 300], 0, pdf.newDictionary(), ""));
    const form = pdf.newDictionary();
    form.put("Fields", pdf.newArray());
    form.put(
      "XFA",
      pdf.addStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>', pdf.newDictionary()),
    );
    pdf.getTrailer().get("Root").put("AcroForm", pdf.addObject(form));
    const bytes = pdf.saveToBuffer("").asUint8Array().slice();
    pdf.destroy();
    expect(open(bytes).info().form).toEqual({ fields: 0, xfa: "dynamic" });
    expect(open(createBlankPdf(1)).info().form).toEqual({ fields: 0, xfa: "none" });
  });
});

describe("redaction and forms", () => {
  it("refuses to redact a form field until the form is flattened, then removes it", () => {
    const engine = open(read(LIBREOFFICE));
    const text = field(engine, (f) => f.kind === "text");
    engine.setFieldValue(0, text.id, "Codename Nightingale");
    engine.addAnnotation({ kind: "redact", page: 0, rect: text.rect });
    expect(() => engine.applyRedactions()).toThrow(/Flatten the form first/);
    engine.flattenForm();
    engine.applyRedactions();
    expect(pageText(engine)).not.toContain("Nightingale");
  });
});
