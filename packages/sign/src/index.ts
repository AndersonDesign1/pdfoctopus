// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PAdES certificate signing (Phase 5). MuPDF reserves the signature field and saves
// incrementally; this package builds the CMS / PKCS#7 signature with PKI.js.
// Not implemented yet: see PHASES.md, Phase 5.

export type SignatureLevel = "B-B" | "B-T";

export interface SignOptions {
  level: SignatureLevel;
  reason?: string;
  location?: string;
}

export const SIGNING_IMPLEMENTED = false;
