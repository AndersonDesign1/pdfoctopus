// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Parse a PDF date string ("D:20261103142000+01'00'"), returning null if it isn't one.
 * Missing parts default as the PDF spec says (month and day 1, time 00:00:00, UTC).
 */
export function parsePdfDate(value: string): Date | null {
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?|[+-]\d{2})?/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  let offsetMinutes = 0;
  if (tz && tz !== "Z") {
    const sign = tz.startsWith("-") ? -1 : 1;
    const digits = tz.replace(/[^0-9]/g, "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const date = new Date(utc - offsetMinutes * 60_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A PDF date for display, or the raw text if it can't be parsed. */
export function formatPdfDate(value: string | undefined, locale?: string): string | undefined {
  if (!value) return undefined;
  const date = parsePdfDate(value);
  return date ? date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A page size in points as "210 × 297 mm (A4)", naming common paper sizes. */
export function formatPageSize(width: number, height: number): string {
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const [w, h] = [mm(width), mm(height)];
  const named: Record<string, string> = {
    "210x297": "A4",
    "148x210": "A5",
    "297x420": "A3",
    "216x279": "Letter",
    "216x356": "Legal",
  };
  const [short, long] = w < h ? [w, h] : [h, w];
  const name = named[`${short}x${long}`];
  const orientation = w > h ? ", landscape" : "";
  return `${w} × ${h} mm${name ? ` (${name}${orientation})` : ""}`;
}
