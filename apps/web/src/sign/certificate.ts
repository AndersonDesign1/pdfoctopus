// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small helpers for signing with a digital ID (a certificate in a .p12 / .pfx file).

/** The date and time shown in a signature's box, e.g. "2026-11-19 14:30 +01:00". */
export function signingTimeText(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())} ${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** The lines of a signature's box, as the engine draws them (signatureLines in core). */
export function signatureBoxLines(
  name: string,
  dateText: string,
  reason: string,
  location: string,
): { text: string; bold: boolean }[] {
  const lines = [
    { text: "Digitally signed by", bold: false },
    { text: name || "Unknown signer", bold: true },
    { text: `Date: ${dateText}`, bold: false },
  ];
  if (reason.trim()) lines.push({ text: `Reason: ${reason.trim()}`, bold: false });
  if (location.trim()) lines.push({ text: `Location: ${location.trim()}`, bold: false });
  return lines;
}

/** A .p12 / .pfx file is small; anything much bigger isn't one. */
export const MAX_DIGITAL_ID_BYTES = 1024 * 1024;
