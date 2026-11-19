// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Building forms: adding fields of each kind (to a blank PDF and to one that has a form),
// changing their properties and deleting them, each one undoable, and saved files that reopen
// cleanly with fields that can be filled in.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPdf, type FormField, PdfEngine } from "./engine";
import type { NewField } from "./formBuild";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const LIBREOFFICE = join(fixtures, "third-party/py-pdf/012-libreoffice-form_libreoffice-form.pdf");

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

const blank = () => open(createBlankPdf(2));

function byName(engine: PdfEngine, name: string, page = 0): FormField {
  const found = engine.listFields(page).find((f) => f.name === name);
  if (!found) throw new Error(`No field called ${name}`);
  return found;
}

/** Reopen saved bytes and list page 0's fields, checking the file didn't need repair. */
function reopened(bytes: Uint8Array): FormField[] {
  const check = open(bytes);
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  expect((doc.asPDF() as mupdf.PDFDocument).wasRepaired()).toBe(false);
  doc.destroy();
  return check.listFields(0);
}

const field = (spec: Partial<NewField> & Pick<NewField, "kind" | "name">): NewField => ({
  page: 0,
  rect: [72, 72, 252, 96],
  ...spec,
});

describe("addField", () => {
  it("adds each kind of field to a PDF with no form, as one undoable step", () => {
    const engine = blank();
    expect(engine.info().form.fields).toBe(0);
    engine.addField(field({ kind: "text", name: "Full name" }));
    engine.addField(field({ kind: "checkbox", name: "Agree", rect: [72, 120, 90, 138] }));
    engine.addField(
      field({
        kind: "combobox",
        name: "Colour",
        rect: [72, 150, 200, 170],
        options: ["Red", "Green"],
      }),
    );
    engine.addField(field({ kind: "date", name: "Date", rect: [72, 180, 200, 200] }));
    const last = engine.addField(
      field({ kind: "signature", name: "Signature", rect: [300, 600, 500, 660] }),
    );
    expect(last.history.undoLabel).toBe("Add form field");
    expect(last.info.form.fields).toBe(5);

    const kinds = Object.fromEntries(engine.listFields(0).map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({
      "Full name": "text",
      Agree: "checkbox",
      Colour: "combobox",
      Date: "text",
      Signature: "signature",
    });
    expect(byName(engine, "Full name").rect).toEqual([72, 72, 252, 96]);
    expect(byName(engine, "Colour").options.map((o) => o.label)).toEqual(["Red", "Green"]);

    engine.undo();
    expect(engine.info().form.fields).toBe(4);
    for (let i = 0; i < 4; i++) engine.undo();
    expect(engine.info().form.fields).toBe(0);
    for (let i = 0; i < 5; i++) engine.redo();
    expect(engine.info().form.fields).toBe(5);
  });

  it("saves fields that reopen cleanly and can be filled in", () => {
    const original = createBlankPdf(1);
    const engine = open(original.slice());
    engine.addField(field({ kind: "text", name: "Name", required: true }));
    engine.addField(field({ kind: "checkbox", name: "Agree", rect: [72, 120, 90, 138] }));
    const saved = engine.save();
    expect(saved.subarray(0, original.length)).toEqual(original);

    const check = open(saved);
    const fields = check.listFields(0);
    const name = fields.find((f) => f.name === "Name");
    expect(name?.required).toBe(true);
    check.setFieldValue(0, name?.id ?? 0, "Jane Example");
    const agree = fields.find((f) => f.name === "Agree");
    check.setFieldValue(0, agree?.id ?? 0, true);
    const again = reopened(check.save());
    expect(again.find((f) => f.name === "Name")?.value).toBe("Jane Example");
    expect(again.find((f) => f.name === "Agree")?.checked).toBe(true);
  });

  it("draws each new field, so it shows in other apps", () => {
    const engine = blank();
    engine.addField(field({ kind: "text", name: "Name", defaultValue: "Jane" }));
    const doc = mupdf.Document.openDocument(engine.save(), "application/pdf");
    const page = (doc.asPDF() as mupdf.PDFDocument).loadPage(0);
    const widget = page.getWidgets()[0] as mupdf.PDFWidget;
    expect(widget.getObject().get("AP").get("N").isStream()).toBe(true);
    expect(widget.getValue()).toBe("Jane");
    doc.destroy();
  });

  it("adds a field to a form that already has fields, and refuses a name in use", () => {
    const engine = open(new Uint8Array(readFileSync(LIBREOFFICE)));
    const before = engine.info().form.fields;
    engine.addField(field({ kind: "text", name: "Email", rect: [72, 300, 252, 320] }));
    expect(engine.info().form.fields).toBe(before + 1);
    expect(() => engine.addField(field({ kind: "text", name: "Email" }))).toThrow(
      /already a field called "Email"/,
    );
    expect(() => engine.addField(field({ kind: "checkbox", name: "First Name" }))).toThrow(
      /already a field/,
    );
    expect(reopened(engine.save()).some((f) => f.name === "Email")).toBe(true);
  });

  it("groups radio buttons by name, and keeps only one chosen", () => {
    const engine = blank();
    engine.addField(field({ kind: "radio", name: "Size", value: "Small", rect: [72, 72, 90, 90] }));
    const second = engine.addField(
      field({ kind: "radio", name: "Size", value: "Large", rect: [100, 72, 118, 90] }),
    );
    expect(second.history.undoLabel).toBe("Add radio button");
    const radios = engine.listFields(0).filter((f) => f.kind === "radio");
    expect(radios.map((r) => [r.name, r.value])).toEqual([
      ["Size", "Small"],
      ["Size", "Large"],
    ]);
    const [small, large] = radios as [FormField, FormField];
    engine.setFieldValue(0, small.id, true);
    engine.setFieldValue(0, large.id, true);
    const now = engine.listFields(0).filter((f) => f.kind === "radio");
    expect(now.map((r) => r.checked)).toEqual([false, true]);
    expect(() =>
      engine.addField(
        field({ kind: "radio", name: "Size", value: "Large", rect: [130, 72, 148, 90] }),
      ),
    ).toThrow(/already has a button with the value "Large"/);

    const saved = reopened(engine.save()).filter((f) => f.kind === "radio");
    expect(saved.map((r) => r.checked)).toEqual([false, true]);
  });

  it("starts a dropdown at its default value, which must be one of the options", () => {
    const engine = blank();
    const spec = field({ kind: "combobox", name: "Colour", options: ["Red", "Green", " "] });
    expect(() => engine.addField({ ...spec, defaultValue: "Blue" })).toThrow(/one of the options/);
    engine.addField({ ...spec, defaultValue: "Green" });
    const colour = byName(engine, "Colour");
    expect(colour.value).toBe("Green");
    expect(colour.defaultValue).toBe("Green");
    expect(colour.options.map((o) => o.value)).toEqual(["Red", "Green"]); // blank option dropped
  });

  it("formats a date field with Acrobat's date scripts", () => {
    const engine = blank();
    engine.addField(field({ kind: "date", name: "Born" }));
    const doc = mupdf.Document.openDocument(engine.save(), "application/pdf");
    const widget = (doc.asPDF() as mupdf.PDFDocument)
      .loadPage(0)
      .getWidgets()[0] as mupdf.PDFWidget;
    const aa = widget.getObject().get("AA");
    expect(aa.get("F").get("JS").asString()).toContain("AFDate_FormatEx");
    expect(aa.get("K").get("JS").asString()).toContain("AFDate_KeystrokeEx");
    doc.destroy();
  });

  it("puts a field where it was drawn on a rotated page", () => {
    const engine = blank();
    engine.rotatePages([0], 90);
    const rect: [number, number, number, number] = [100, 50, 300, 80];
    engine.addField(field({ kind: "text", name: "Rotated", rect }));
    const got = byName(engine, "Rotated").rect.map((v) => Math.round(v));
    expect(got).toEqual(rect);
  });

  it("refuses bad input, changing nothing", () => {
    const engine = blank();
    const history = engine.history();
    expect(() => engine.addField(field({ kind: "text", name: "  " }))).toThrow(/needs a name/);
    expect(() => engine.addField(field({ kind: "text", name: "a.b" }))).toThrow(/dot/);
    expect(() => engine.addField(field({ kind: "text", name: "x", rect: [0, 0, 3, 3] }))).toThrow(
      /too small/,
    );
    expect(() => engine.addField(field({ kind: "combobox", name: "x", options: [] }))).toThrow(
      /at least one option/,
    );
    expect(() =>
      engine.addField(field({ kind: "combobox", name: "x", options: ["A", "A"] })),
    ).toThrow(/same/);
    expect(() => engine.addField(field({ kind: "radio", name: "x", value: "Off" }))).toThrow(/Off/);
    expect(() => engine.addField(field({ kind: "text", name: "x", page: 9 }))).toThrow();
    expect(engine.history()).toEqual(history);
    expect(engine.info().form.fields).toBe(0);
  });
});

describe("updateField", () => {
  it("renames a field, makes it required and gives it a default value, undoably", () => {
    const engine = blank();
    engine.addField(field({ kind: "text", name: "Name" }));
    const name = byName(engine, "Name");
    const result = engine.updateField(0, name.id, {
      name: "Full name",
      required: true,
      defaultValue: "Jane",
    });
    expect(result.history.undoLabel).toBe("Change form field");
    const changed = byName(engine, "Full name");
    expect(changed.required).toBe(true);
    expect(changed.defaultValue).toBe("Jane");
    expect(changed.value).toBe("Jane"); // it was empty, so it shows the default

    engine.undo();
    const back = byName(engine, "Name");
    expect(back.required).toBe(false);
    expect(back.value).toBe("");
    engine.redo();
    expect(reopened(engine.save()).find((f) => f.name === "Full name")?.value).toBe("Jane");
  });

  it("keeps an answer that isn't the old default when the default changes", () => {
    const engine = blank();
    engine.addField(field({ kind: "text", name: "Name", defaultValue: "Jane" }));
    const name = byName(engine, "Name");
    engine.setFieldValue(0, name.id, "Sam");
    engine.updateField(0, name.id, { defaultValue: "Alex" });
    expect(byName(engine, "Name").value).toBe("Sam");
  });

  it("changes a dropdown's options, clearing an answer that's no longer offered", () => {
    const engine = blank();
    engine.addField(field({ kind: "combobox", name: "Colour", options: ["Red", "Green"] }));
    const colour = byName(engine, "Colour");
    engine.setFieldValue(0, colour.id, "Green");
    engine.updateField(0, colour.id, { options: ["Red", "Blue"] });
    const now = byName(engine, "Colour");
    expect(now.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(now.value).toBe("");
    engine.undo();
    expect(byName(engine, "Colour").value).toBe("Green");
  });

  it("renames a whole radio group from any of its buttons", () => {
    const engine = blank();
    engine.addField(field({ kind: "radio", name: "Size", value: "S", rect: [72, 72, 90, 90] }));
    engine.addField(field({ kind: "radio", name: "Size", value: "L", rect: [100, 72, 118, 90] }));
    const [, second] = engine.listFields(0) as [FormField, FormField];
    engine.updateField(0, second.id, { name: "Shirt size" });
    expect(engine.listFields(0).map((f) => f.name)).toEqual(["Shirt size", "Shirt size"]);
  });

  it("refuses a name in use and changes that don't fit the field, changing nothing", () => {
    const engine = blank();
    engine.addField(field({ kind: "text", name: "A" }));
    engine.addField(field({ kind: "checkbox", name: "B", rect: [72, 120, 90, 138] }));
    const history = engine.history();
    const a = byName(engine, "A");
    const b = byName(engine, "B");
    expect(() => engine.updateField(0, a.id, { name: "B" })).toThrow(/already a field called "B"/);
    expect(() => engine.updateField(0, b.id, { defaultValue: "x" })).toThrow(/default value/);
    expect(() => engine.updateField(0, a.id, { options: ["x"] })).toThrow(/options/);
    expect(() => engine.updateField(0, 99999, { required: true })).toThrow(/not on the page/);
    expect(engine.history()).toEqual(history);
    // Nothing that changes nothing is recorded either.
    engine.updateField(0, a.id, { name: "A", required: false });
    expect(engine.history()).toEqual(history);
  });
});

describe("deleteField", () => {
  it("deletes a field, and undo puts it back", () => {
    const engine = blank();
    engine.addField(field({ kind: "text", name: "Name" }));
    engine.addField(field({ kind: "checkbox", name: "Agree", rect: [72, 120, 90, 138] }));
    const result = engine.deleteField(0, byName(engine, "Name").id);
    expect(result.history.undoLabel).toBe("Delete form field");
    expect(engine.listFields(0).map((f) => f.name)).toEqual(["Agree"]);
    const saved = engine.save();
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const fields = (doc.asPDF() as mupdf.PDFDocument)
      .getTrailer()
      .get("Root")
      .get("AcroForm")
      .get("Fields");
    expect(fields.length).toBe(1);
    doc.destroy();
    engine.undo();
    expect(engine.listFields(0).map((f) => f.name)).toEqual(["Name", "Agree"]);
  });

  it("deletes one radio button, and the group with its last one", () => {
    const engine = blank();
    engine.addField(field({ kind: "radio", name: "Size", value: "S", rect: [72, 72, 90, 90] }));
    engine.addField(field({ kind: "radio", name: "Size", value: "L", rect: [100, 72, 118, 90] }));
    const [s, l] = engine.listFields(0) as [FormField, FormField];
    engine.setFieldValue(0, l.id, true);
    engine.deleteField(0, l.id);
    expect(engine.listFields(0).map((f) => f.value)).toEqual(["S"]);
    engine.deleteField(0, s.id);
    expect(engine.info().form.fields).toBe(0);
    expect(engine.listFields(0)).toEqual([]);
    // Adding "Size" again starts a new group, as the old one is gone.
    engine.addField(field({ kind: "radio", name: "Size", value: "S", rect: [72, 72, 90, 90] }));
    engine.undo();
    engine.undo();
    engine.undo();
    expect(engine.listFields(0).map((f) => f.value)).toEqual(["S", "L"]);
  });

  it("deletes a field from a file's own form", () => {
    const engine = open(new Uint8Array(readFileSync(LIBREOFFICE)));
    const before = engine.listFields(0);
    const target = before.find((f) => f.kind === "text") as FormField;
    engine.deleteField(0, target.id);
    const after = reopened(engine.save());
    expect(after.length).toBe(before.length - 1);
    expect(after.some((f) => f.id === target.id)).toBe(false);
  });
});
