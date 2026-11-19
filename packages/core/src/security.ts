// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Passwords and permissions: what a file allows (read from its /Encrypt dictionary), and the
// options for MuPDF's writer that encrypt a saved file with AES-256 or remove its encryption.

import type * as mupdf from "mupdf";

/** What people who open the file with the open password (or none) may do. */
export interface Permissions {
  print: boolean;
  copy: boolean;
  edit: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
}

export const ALL_PERMISSIONS: Permissions = {
  print: true,
  copy: true,
  edit: true,
  annotate: true,
  fillForms: true,
  assemble: true,
};

/** A password and permissions to save the file with. */
export interface PasswordSpec {
  /** Needed to open the file at all; empty for none. */
  openPassword?: string;
  /** Needed to change the permissions (the "owner" password); required when restricting. */
  permissionsPassword?: string;
  permissions: Permissions;
}

/** The file's security as it is, and what saving will do to it. */
export interface SecurityInfo {
  /** Whether the opened file is encrypted. */
  encrypted: boolean;
  /** E.g. "Standard V5 R6 256-bit AES". */
  method?: string;
  /** What the opened file allows (everything if it isn't encrypted). */
  permissions: Permissions;
  /**
   * Whether the password (or permissions) can be changed here: the file isn't encrypted,
   * restricts nothing, or was unlocked with its permissions password.
   */
  canChange: boolean;
  /** What the next save does: keep the file as it is, add a password, or remove it. */
  pending: "none" | "protect" | "remove";
  /** With pending "protect": whether the saved file needs a password to open. */
  pendingOpenPassword?: boolean;
  /** With pending "protect": what the saved file will allow. */
  pendingPermissions?: Permissions;
}

/** The longest password AES-256 encryption takes (bytes of UTF-8). */
export const MAX_PASSWORD_BYTES = 127;

// Permission bits of /P (PDF 32000-2 table 22), numbered from 1.
const BIT = (n: number) => 1 << (n - 1);
const PRINT = BIT(3);
const EDIT = BIT(4);
const COPY = BIT(5);
const ANNOTATE = BIT(6);
const FILL_FORMS = BIT(9);
const ACCESSIBILITY = BIT(10);
const ASSEMBLE = BIT(11);
const PRINT_HIGH = BIT(12);
/** Bits 7, 8 and 13–32 must be 1, and 1–2 must be 0. */
const RESERVED = ~0xf3f & ~0b11;

/** /P for a set of permissions. Reading for accessibility (screen readers) is always allowed. */
export function permissionBits(p: Permissions): number {
  let bits = RESERVED | ACCESSIBILITY;
  if (p.print) bits |= PRINT | PRINT_HIGH;
  if (p.edit) bits |= EDIT;
  if (p.copy) bits |= COPY;
  if (p.annotate) bits |= ANNOTATE;
  if (p.fillForms) bits |= FILL_FORMS;
  if (p.assemble) bits |= ASSEMBLE;
  return bits | 0;
}

/** The permissions a /P value grants. */
export function permissionsFrom(bits: number): Permissions {
  return {
    print: (bits & PRINT) !== 0,
    copy: (bits & COPY) !== 0,
    edit: (bits & EDIT) !== 0,
    annotate: (bits & ANNOTATE) !== 0,
    fillForms: (bits & FILL_FORMS) !== 0,
    assemble: (bits & ASSEMBLE) !== 0,
  };
}

export function restrictsAnything(p: Permissions): boolean {
  return Object.values(p).some((allowed) => !allowed);
}

/** Every permission bit /P can withhold. */
const ALL_BITS =
  PRINT | EDIT | COPY | ANNOTATE | FILL_FORMS | ACCESSIBILITY | ASSEMBLE | PRINT_HIGH;

/**
 * Whether a file withholds anything at all, judged from its raw /P, not from `Permissions`,
 * which leaves out bits PDFoctopus always sets (high-quality printing, accessibility): a file
 * that withholds only those still needs its permissions password to change its password.
 */
export function fileRestricts(pdf: mupdf.PDFDocument): boolean {
  const encrypt = pdf.getTrailer().get("Encrypt");
  if (!encrypt.isDictionary()) return false;
  const p = encrypt.get("P");
  // /P is required; a file without one is treated as restricting everything.
  if (!p.isNumber()) return true;
  return (p.asNumber() & ALL_BITS) !== ALL_BITS;
}

/** What an encrypted file allows, from its /Encrypt /P (all of it if it isn't encrypted). */
export function filePermissions(pdf: mupdf.PDFDocument): Permissions {
  const encrypt = pdf.getTrailer().get("Encrypt");
  if (!encrypt.isDictionary()) return { ...ALL_PERMISSIONS };
  const p = encrypt.get("P");
  return p.isNumber() ? permissionsFrom(p.asNumber()) : { ...ALL_PERMISSIONS };
}

/** A password, checked: MuPDF's writer options are comma-separated, so it can't hold a comma. */
export function checkPassword(password: string, what: string): string {
  if (password.includes(",")) throw new Error(`The ${what} can't contain a comma`);
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    throw new Error(`The ${what} is too long`);
  }
  return password;
}

/** Check a password spec, returning the passwords to write. Throws with a reason. */
export function checkPasswordSpec(spec: PasswordSpec): { user: string; owner: string } {
  const user = checkPassword(spec.openPassword ?? "", "open password");
  const owner = checkPassword(spec.permissionsPassword ?? "", "permissions password");
  const restricted = restrictsAnything(spec.permissions);
  if (!user && !restricted) {
    throw new Error("Set an open password, or restrict something, or both");
  }
  if (restricted && !owner)
    throw new Error("Restricting what people can do needs a permissions password");
  if (restricted && owner === user) {
    throw new Error("The permissions password must be different from the open password");
  }
  // With nothing restricted, the open password also unlocks the permissions.
  return { user, owner: owner || user };
}

/** MuPDF writer options that encrypt a full save with AES-256. */
export function encryptOptions(spec: PasswordSpec): string {
  const { user, owner } = checkPasswordSpec(spec);
  const parts = ["encrypt=aes-256", `permissions=${permissionBits(spec.permissions)}`];
  if (user) parts.push(`user-password=${user}`);
  parts.push(`owner-password=${owner}`);
  return parts.join(",");
}
