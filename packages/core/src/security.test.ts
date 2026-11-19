// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Passwords and permissions: files saved with an open password and/or restrictions (AES-256),
// unlocking a file's permissions, removing a password, and refusals. The saved files are also
// read back with MuPDF to check what any other app would see.

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";
import { ALL_PERMISSIONS, type Permissions, permissionBits, permissionsFrom } from "./security";

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

const NONE: Permissions = {
  print: false,
  copy: false,
  edit: false,
  annotate: false,
  fillForms: false,
  assemble: false,
};

/** What MuPDF makes of a saved file: whether it needs a password, and its /P. */
function inspect(bytes: Uint8Array, password = "") {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const needsPassword = doc.needsPassword();
    const auth = needsPassword ? doc.authenticatePassword(password) : 2;
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const encrypt = pdf.getTrailer().get("Encrypt");
    return {
      needsPassword,
      auth,
      method: doc.getMetaData("encryption"),
      p: encrypt.isDictionary() ? encrypt.get("P").asNumber() : null,
      pages: auth ? doc.countPages() : 0,
    };
  } finally {
    doc.destroy();
  }
}

describe("permission bits", () => {
  it("turn permissions into /P and back, with the reserved bits right", () => {
    // Nothing allowed but reading for accessibility: 0xFFFFF0C0 plus bit 10.
    expect(permissionBits(NONE)).toBe(-3904 | 512);
    expect(permissionsFrom(permissionBits(NONE))).toEqual(NONE);
    expect(permissionsFrom(permissionBits(ALL_PERMISSIONS))).toEqual(ALL_PERMISSIONS);
    const some = { ...NONE, print: true, fillForms: true };
    expect(permissionsFrom(permissionBits(some))).toEqual(some);
  });
});

describe("setPassword", () => {
  it("saves with an open password (AES-256), as one undoable step", () => {
    const engine = open(createBlankPdf(2));
    const result = engine.setPassword({
      openPassword: "open sesame",
      permissions: ALL_PERMISSIONS,
    });
    expect(result.history.undoLabel).toBe("Add password");
    expect(result.info.security).toMatchObject({ pending: "protect", pendingOpenPassword: true });

    const saved = engine.save();
    const seen = inspect(saved, "open sesame");
    expect(seen.needsPassword).toBe(true);
    expect(seen.method).toBe("Standard V5 R6 256-bit AES");
    expect(seen.pages).toBe(2);
    expect(inspect(saved, "wrong").auth).toBe(0);

    // A later save is encrypted too.
    expect(inspect(engine.save(), "open sesame").needsPassword).toBe(true);
  });

  it("keeps the file as it was when undone before saving", () => {
    const original = createBlankPdf(1);
    const engine = open(original.slice());
    engine.setPassword({ openPassword: "x", permissions: ALL_PERMISSIONS });
    engine.undo();
    expect(engine.info().security.pending).toBe("none");
    engine.rotatePages([0], 90);
    const saved = engine.save();
    expect(saved.subarray(0, original.length)).toEqual(original); // incremental again
    expect(inspect(saved).needsPassword).toBe(false);
  });

  it("restricts what people can do without an open password", () => {
    const engine = open(createBlankPdf(1));
    const permissions = { ...NONE, print: true };
    const result = engine.setPassword({ permissionsPassword: "owner", permissions });
    expect(result.history.undoLabel).toBe("Restrict permissions");
    const saved = engine.save();
    const seen = inspect(saved);
    expect(seen.needsPassword).toBe(false);
    expect(permissionsFrom(seen.p ?? 0)).toEqual(permissions);

    // Reopened here: the restrictions are shown, and can't be changed until unlocked.
    const again = open(saved);
    const security = again.info().security;
    expect(security).toMatchObject({ encrypted: true, canChange: false, permissions });
    expect(() => again.removePassword()).toThrow(/permissions password/);
    expect(again.unlockPermissions("nope")).toBeNull();
    expect(again.unlockPermissions("owner")?.security.canChange).toBe(true);
  });

  it("saves with both passwords: the open one opens, the other unlocks the permissions", () => {
    const engine = open(createBlankPdf(1));
    engine.setPassword({
      openPassword: "reader",
      permissionsPassword: "author",
      permissions: { ...ALL_PERMISSIONS, copy: false },
    });
    const saved = engine.save();
    expect(inspect(saved, "reader").auth & 2).toBe(2);
    expect(inspect(saved, "author").auth & 4).toBe(4);

    const asReader = open(saved);
    expect(asReader.authenticate("reader")?.security).toMatchObject({
      canChange: false,
      permissions: { ...ALL_PERMISSIONS, copy: false },
    });
    const asAuthor = open(saved);
    expect(asAuthor.authenticate("author")?.security.canChange).toBe(true);
  });

  it("takes passwords in any language", () => {
    const engine = open(createBlankPdf(1));
    engine.setPassword({ openPassword: "Pässwörd-密码", permissions: ALL_PERMISSIONS });
    expect(inspect(engine.save(), "Pässwörd-密码").auth).not.toBe(0);
  });

  it("refuses passwords it can't save, changing nothing", () => {
    const engine = open(createBlankPdf(1));
    const history = engine.history();
    expect(() => engine.setPassword({ permissions: ALL_PERMISSIONS })).toThrow(
      /open password, or restrict/,
    );
    expect(() => engine.setPassword({ openPassword: "a,b", permissions: ALL_PERMISSIONS })).toThrow(
      /comma/,
    );
    expect(() =>
      engine.setPassword({ openPassword: "x".repeat(128), permissions: ALL_PERMISSIONS }),
    ).toThrow(/too long/);
    expect(() => engine.setPassword({ openPassword: "x", permissions: NONE })).toThrow(
      /needs a permissions password/,
    );
    expect(() =>
      engine.setPassword({ openPassword: "x", permissionsPassword: "x", permissions: NONE }),
    ).toThrow(/different/);
    expect(engine.history()).toEqual(history);
    expect(engine.info().security.pending).toBe("none");
  });
});

describe("removePassword", () => {
  function protectedFile(
    openPassword: string,
    permissionsPassword: string,
    permissions: Permissions,
  ) {
    const engine = open(createBlankPdf(1));
    engine.setPassword({ openPassword, permissionsPassword, permissions });
    return engine.save();
  }

  it("saves an unprotected copy once the file is unlocked with the permissions password", () => {
    const saved = protectedFile("reader", "author", { ...NONE, print: true });
    const engine = open(saved);
    engine.authenticate("author");
    const result = engine.removePassword();
    expect(result.history.undoLabel).toBe("Remove password");
    expect(result.info.security.pending).toBe("remove");
    const plain = inspect(engine.save());
    expect(plain.needsPassword).toBe(false);
    expect(plain.p).toBeNull();
    expect(plain.method).toBe("None");
  });

  it("removes an open password that restricts nothing", () => {
    const engine = open(protectedFile("reader", "", ALL_PERMISSIONS));
    engine.authenticate("reader");
    engine.removePassword();
    expect(inspect(engine.save()).needsPassword).toBe(false);
  });

  it("refuses with only the open password when the file restricts things", () => {
    const engine = open(protectedFile("reader", "author", { ...ALL_PERMISSIONS, edit: false }));
    engine.authenticate("reader");
    expect(() => engine.removePassword()).toThrow(/permissions password/);
    expect(() => engine.setPassword({ openPassword: "new", permissions: ALL_PERMISSIONS })).toThrow(
      /permissions password/,
    );
  });

  it("refuses for a file without a password", () => {
    const engine = open(createBlankPdf(1));
    expect(() => engine.removePassword()).toThrow(/no password/);
  });
});

describe("saving a protected file without changing its password", () => {
  it("keeps the encryption, whether appending or rewriting", () => {
    const engine = open(createBlankPdf(1));
    engine.setPassword({ openPassword: "reader", permissions: ALL_PERMISSIONS });
    const saved = engine.save();

    const appended = open(saved);
    appended.authenticate("reader");
    appended.rotatePages([0], 90);
    const incremental = appended.save();
    expect(incremental.subarray(0, saved.length)).toEqual(saved);
    expect(inspect(incremental, "reader")).toMatchObject({ needsPassword: true, pages: 1 });

    const rewritten = open(saved);
    rewritten.authenticate("reader");
    expect(inspect(rewritten.save({ incremental: false }), "reader").needsPassword).toBe(true);
  });
});
