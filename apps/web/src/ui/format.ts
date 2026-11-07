// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Parse a PDF date string ("D:20261103142000+01'00'"), returning null if it isn't one.
 * Missing parts default as the PDF spec says (month and day 1, time 00:00:00, UTC).
 */
export function parsePdfDate(value: string): Date | null {
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})(?:'?(\d{2}))?'?)?$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", , sign, tzh = "00", tzm = "00"] =
    m;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [offH, offM] = [Number(tzh), Number(tzm)];
  // Reject out-of-range parts instead of letting Date.UTC roll them over into another date.
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offH > 23 ||
    offM > 59
  ) {
    return null;
  }
  // Date.UTC maps years 0–99 to 1900–1999, so set the full year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  // Day 31 in a 30-day month rolls over: catch it by checking the day survived.
  if (date.getUTCDate() !== day) return null;
  const utc = date.getTime();
  const offsetMinutes = (sign === "-" ? -1 : 1) * (offH * 60 + offM);
  return new Date(utc - (sign ? offsetMinutes : 0) * 60_000);
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
