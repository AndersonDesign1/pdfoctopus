// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MuPDF.js returns one shared PDFObject.Null for anything missing, and that object belongs to
// no document. Its get(), resolve() and getInheritable() go through the document, so on it they
// throw "TypeError: null is not an object", which is what a chain like
// trailer.get("Root").get("PageLabels") did on a damaged file with no /Root. In MuPDF's C
// library, looking something up in null gives null, and that's what the engine's code expects
// everywhere, so the shared null is made to behave the same way here. Changing it is refused
// with an ordinary error that says the file is damaged.
//
// Imported for its side effect by engine.ts (and anything else that reads PDF objects).

import * as mupdf from "mupdf";

const Null = mupdf.PDFObject.Null as mupdf.PDFObject & { _pdfoctopusNull?: true };

if (!Null._pdfoctopusNull) {
  const missing = () => Null;
  const refuse = () => {
    throw new Error("This PDF is damaged: something it refers to is missing");
  };
  for (const name of ["get", "resolve", "getInheritable"] as const) {
    Object.defineProperty(Null, name, { value: missing, configurable: true });
  }
  for (const name of ["put", "push", "writeObject", "writeStream", "writeRawStream"]) {
    Object.defineProperty(Null, name, { value: refuse, configurable: true });
  }
  Object.defineProperty(Null, "_pdfoctopusNull", { value: true });
}
