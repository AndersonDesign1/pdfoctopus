// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Paragraphs (Phase 6, step 2): finding them among a page's lines, and rewriting one with new
// text that flows from line to line inside the paragraph's box.
//
// Finding: lines one above the other, in the same font and size, with nothing else between
// them, evenly spaced, and lined up the same way (left, right, centred or justified) make a
// paragraph. A line starting with a list number or bullet starts a new one, and so does a line
// whose first word would have fitted on the line before (that line ended on purpose).
//
// Editing: the new text is broken into lines with the paragraph's own font measurements, and
// each of the paragraph's lines is rewritten as a single line edit would be (textEdit.ts), so
// every line keeps its own place, font, colour and spacing. Justified lines are stretched with
// moves after each space. Lines left over are emptied; lines needed beyond the old ones are
// drawn under the last one, inside its own operator, which then puts the text position back
// exactly where it was, so nothing after it moves. Every other byte of the page is unchanged.

import { formatNumber } from "./contentStream";
import {
  CJK,
  checkClips,
  drawRuns,
  type EditMap,
  type EditPlan,
  encode,
  finishEdits,
  freeFontName,
  type Glyph,
  type LineSetup,
  lineReplacements,
  mul,
  type PageAnalysis,
  type PageLine,
  pickFonts,
  prepareLine,
  type Rect4,
  RTL,
  rectToFrame,
  toFrame,
} from "./textEdit";
import { readableFontName } from "./textFonts";
import { MAX_PARAGRAPH_TEXT } from "./textLimits";

/** A paragraph on a page, as the Edit text tool shows it. */
export interface ParagraphInfo {
  /** Its position in the page's list; pass it back with `text` to edit it. */
  id: number;
  /** The listed lines it's made of, top to bottom (their `id`s). */
  lines: number[];
  /** Its text: the lines joined with spaces (a word broken with a hyphen is joined up). */
  text: string;
  /** Its box in points from the page's top-left corner as shown. */
  rect: Rect4;
  /** How its lines are lined up. */
  align: "left" | "right" | "centre" | "justify";
  /** Whether it can be edited as a whole, and if not, why not (in plain words). */
  editable: boolean;
  reason: string | null;
}

/** What a paragraph edit will do, worked out before it's made, so the user can be warned. */
export interface ParagraphEditCheck {
  /** The font the new text will use, as people would name it. */
  font: string;
  /** Set when the paragraph's own font lacks characters: the standard font used instead. */
  fallback: string | null;
  /** The characters the paragraph's own font doesn't have. */
  missing: string[];
  /** How many lines the new text takes, how many the paragraph had, and how many fit in its
   * space (its lines plus the room below it, before the next thing or the bottom margin). */
  lines: number;
  oldLines: number;
  fit: number;
  /** More lines than fit: the last ones will overlap what's below. */
  overflow: boolean;
  /** A word is wider than the paragraph, so it sticks out on the right. */
  tooWide: boolean;
}

export interface ParagraphPlan extends Omit<EditPlan, "check"> {
  check: ParagraphEditCheck;
  /** The new lines' text, top to bottom. */
  newLines: string[];
  /** Where the new lines go (page space), for checking the result. */
  region: Rect4;
}

/** Caps, so a page with a great deal of text can't make this take for ever. */
const MAX_PARAGRAPH_LINES = 5000;
const MAX_NEW_LINES = 400;
const SCAN_WINDOW = 200;
const MARK_BUDGET = 2_000_000;
/** Lines this much further apart than their font size aren't one paragraph. */
const MAX_SPACING = 2;

type Align = ParagraphInfo["align"];

/** A line as paragraph finding sees it, in its own frame (x along the line, y down across it). */
interface ParaLine {
  id: number;
  rotation: number;
  /** Where its text starts and ends along the line (spaces at the ends left out). */
  left: number;
  right: number;
  /** Its box across the line, and its baseline. */
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  /** The font most of it is in, and whether it's in more than one. */
  font: string;
  keys: Set<string>;
  text: string;
  editable: boolean;
  reason: string | null;
  /** Width of its first word. */
  firstWord: number;
  /** Whether its spaces are stretched (as in justified text). */
  stretched: boolean;
}

/** A paragraph found on a page. */
export interface ParagraphData {
  info: ParagraphInfo;
  lines: ParaLine[];
  rotation: number;
  /** Where its first line and the others start, where they end, and the gap between baselines. */
  firstLeft: number;
  left: number;
  right: number;
  spacing: number;
}

// ---------------------------------------------------------------------------------------------
// Finding paragraphs

/** The page's paragraphs (two lines or more), worked out once per analysis. */
export function paragraphsOf(analysis: PageAnalysis): ParagraphData[] {
  if (Array.isArray(analysis.paragraphs)) return analysis.paragraphs as ParagraphData[];
  const found = analysis.problem || analysis.marksFull ? [] : findParagraphs(analysis);
  analysis.paragraphs = found;
  return found;
}

function findParagraphs(analysis: PageAnalysis): ParagraphData[] {
  const lines: ParaLine[] = [];
  const byLine = new Map<number, Glyph[]>();
  for (const g of analysis.glyphs) {
    if (g.line < 0) continue;
    const list = byLine.get(g.line);
    if (list) list.push(g);
    else byLine.set(g.line, [g]);
  }
  for (let i = 0; i < analysis.lines.length && lines.length < MAX_PARAGRAPH_LINES; i++) {
    const line = describe(analysis, i, byLine.get(i) ?? []);
    if (line) lines.push(line);
  }
  lines.sort((a, b) => a.rotation - b.rotation || a.baseline - b.baseline || a.left - b.left);
  const marks = new MarkIndex(analysis.marks);

  // Link each line to the line straight under it when they could be one paragraph.
  const below = new Map<ParaLine, ParaLine>();
  const above = new Map<ParaLine, ParaLine>();
  const nearestBelow = (a: ParaLine, from: number): ParaLine | null => {
    let best: ParaLine | null = null;
    let tie = false;
    for (let j = from + 1, n = 0; j < lines.length && n < SCAN_WINDOW; j++, n++) {
      const b = lines[j] as ParaLine;
      if (b.rotation !== a.rotation) break;
      if (b.baseline - a.baseline > MAX_SPACING * a.size) break;
      if (b.baseline - a.baseline < 0.5 * Math.min(a.size, b.size)) continue;
      if (!(b.left < a.right && a.left < b.right)) continue;
      if (!best || b.baseline < best.baseline - 0.5) {
        best = b;
        tie = false;
      } else if (Math.abs(b.baseline - best.baseline) <= 0.5) {
        tie = true;
      }
    }
    return tie ? null : best;
  };
  const down = lines.map((a, i) => nearestBelow(a, i));
  // The nearest line above each line, among those that overlap it.
  const up = new Map<ParaLine, ParaLine | null>();
  lines.forEach((a, i) => {
    const b = down[i];
    if (!b) return;
    const current = up.get(b);
    if (current === undefined || (current && a.baseline > current.baseline + 0.5)) up.set(b, a);
    else if (current && Math.abs(a.baseline - current.baseline) <= 0.5) up.set(b, null);
  });
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i] as ParaLine;
    const b = down[i];
    if (!b || up.get(b) !== a) continue;
    if (Math.abs(a.size - b.size) > 0.1 || a.font !== b.font) continue;
    if (marks.between(a, b)) continue;
    below.set(a, b);
    above.set(b, a);
  }

  // Follow the links, splitting where the spacing or alignment changes, at list items, and
  // after lines that ended early.
  const paragraphs: ParagraphData[] = [];
  for (const start of lines) {
    if (above.has(start)) continue;
    const chain: ParaLine[] = [start];
    for (let l = below.get(start); l; l = below.get(l)) chain.push(l);
    if (chain.length < 2) continue;
    for (const group of splitChain(chain)) {
      for (const part of splitAtBreaks(group)) {
        if (part.length >= 2) paragraphs.push(makeParagraph(analysis, part, paragraphs.length));
      }
    }
  }
  // Top to bottom, then left to right, so ids read in a sensible order.
  paragraphs.sort((a, b) => {
    const ra = a.info.rect;
    const rb = b.info.rect;
    return ra[1] - rb[1] || ra[0] - rb[0];
  });
  paragraphs.forEach((p, i) => {
    p.info.id = i;
  });
  return paragraphs;
}

const LIST_ITEM = /^\s*(\(?(\d{1,3}|[a-zA-Z]|[ivxIVX]{1,5})[.)]|[•‣◦▪●■□–—*-])\s/;

function describe(analysis: PageAnalysis, id: number, glyphs: Glyph[]): ParaLine | null {
  const line = analysis.lines[id] as PageLine;
  const info = analysis.infos[id];
  if (!info || line.wmode !== 0 || !line.text.trim()) return null;
  const rotation = info.rotation;
  const box = rectToFrame(rotation, line.bbox);
  const first = line.chars.find((c) => !/\s/.test(c.c)) ?? line.chars[0];
  if (!first) return null;
  let left = box[0];
  let right = box[2];
  let baseline = toFrame(rotation, first.x, first.y)[1];
  const keys = new Set<string>();
  const counts = new Map<string, number>();
  let font = readableFontName(line.fontName);
  let stretched = false;
  const ops = analysis.lineOps.get(id);
  if (ops && glyphs.length > 0) {
    const visible = glyphs.filter((g) => g.text.trim() !== "");
    if (visible.length > 0) {
      left = Math.min(...visible.map((g) => toFrame(rotation, g.x, g.y)[0]));
      right = Math.max(...visible.map((g) => toFrame(rotation, g.ex, g.ey)[0]));
      baseline = toFrame(rotation, (visible[0] as Glyph).x, (visible[0] as Glyph).y)[1];
    }
    for (const g of glyphs) {
      const op = g.op;
      keys.add(`${op.fontResource}@${op.fs}`);
      const name = readableFontName(op.font?.baseFont || line.fontName);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    font = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? font;
    // The text's natural width (its glyphs' own widths) against the room it takes up.
    let natural = 0;
    for (const g of visible) {
      const op = g.op;
      const unit = op.trm ? Math.hypot(op.trm[0], op.trm[1]) / (op.fs * op.th) : 0;
      natural += (((op.font?.width(g.code) ?? 0) / 1000) * op.fs + op.tc) * op.th * unit;
    }
    const spaces = (line.text.trim().match(/\s+/g) ?? []).length;
    stretched = spaces > 0 && right - left > natural + spaces * 0.4 * line.size + 0.5;
  }
  const text = line.text;
  // The first word ends at the first space after it starts.
  let firstWord = right - left;
  const from = line.chars.indexOf(first);
  const gap = line.chars.findIndex((c, i) => i > from && /\s/.test(c.c));
  if (gap > from) {
    const g = line.chars[gap] as { x: number; y: number };
    firstWord = toFrame(rotation, g.x, g.y)[0] - toFrame(rotation, first.x, first.y)[0];
  }
  return {
    id,
    rotation,
    left,
    right,
    top: box[1],
    bottom: box[3],
    baseline,
    size: line.size,
    font,
    keys,
    text,
    editable: info.editable,
    reason: info.reason,
    firstWord: Math.max(0, firstWord),
    stretched,
  };
}

/** Boxes of other things drawn, by rows down the page, to find any between two lines. */
class MarkIndex {
  private rows = new Map<string, Rect4[]>();
  private big: Rect4[] = [];
  private framed = new Map<number, Rect4[]>();
  private budget = MARK_BUDGET;
  private static ROW = 8;

  constructor(private readonly marks: Rect4[]) {}

  /** Whether something is drawn between line a and the line b under it. */
  between(a: ParaLine, b: ParaLine): boolean {
    const x0 = Math.max(a.left, b.left);
    const x1 = Math.min(a.right, b.right);
    const y0 = a.bottom;
    const y1 = b.top;
    if (!(y1 > y0)) return false;
    const both: Rect4 = [Math.min(a.left, b.left), a.top, Math.max(a.right, b.right), b.bottom];
    const hit = (m: Rect4) => {
      if (--this.budget < 0) return true;
      if (!(m[0] < x1 && m[2] > x0 && m[1] < y1 && m[3] > y0)) return false;
      // A background or frame around both lines doesn't separate them.
      const around =
        m[0] <= both[0] + 0.5 &&
        m[1] <= both[1] + 0.5 &&
        m[2] >= both[2] - 0.5 &&
        m[3] >= both[3] - 0.5;
      return !around;
    };
    this.index(a.rotation);
    const prefix = `${a.rotation}:`;
    for (let r = Math.floor(y0 / MarkIndex.ROW); r <= Math.floor(y1 / MarkIndex.ROW); r++) {
      for (const m of this.rows.get(prefix + r) ?? []) if (hit(m)) return true;
    }
    for (const m of this.big) if (hit(m)) return true;
    return false;
  }

  private index(rotation: number): void {
    if (this.framed.has(rotation)) return;
    const framed = this.marks.map((m) => rectToFrame(rotation, m));
    this.framed.set(rotation, framed);
    for (const m of framed) {
      const r0 = Math.floor(m[1] / MarkIndex.ROW);
      const r1 = Math.floor(m[3] / MarkIndex.ROW);
      if (!Number.isFinite(r0) || !Number.isFinite(r1) || r1 - r0 > 40) {
        this.big.push(m);
        continue;
      }
      for (let r = r0; r <= r1; r++) {
        const key = `${rotation}:${r}`;
        const row = this.rows.get(key);
        if (row) row.push(m);
        else this.rows.set(key, [m]);
      }
    }
  }
}

/** Split a chain of linked lines where the spacing or alignment changes, or at list items. */
function splitChain(chain: ParaLine[]): ParaLine[][] {
  const out: ParaLine[][] = [];
  let current: ParaLine[] = [];
  for (const line of chain) {
    if (current.length > 0) {
      const prev = current[current.length - 1] as ParaLine;
      const gap = line.baseline - prev.baseline;
      const first =
        current.length >= 2
          ? (current[1] as ParaLine).baseline - (current[0] as ParaLine).baseline
          : gap;
      const even = Math.abs(gap - first) <= Math.max(1, 0.1 * first);
      if (!even || LIST_ITEM.test(line.text) || alignmentOf([...current, line]) === null) {
        out.push(current);
        current = [];
      }
    }
    current.push(line);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Split after lines that ended early: the next line's first word would have fitted. */
function splitAtBreaks(lines: ParaLine[]): ParaLine[][] {
  if (lines.length < 2) return [lines];
  const align = alignmentOf(lines);
  if (align !== "left") return [lines];
  const right = Math.max(...lines.map((l) => l.right));
  const out: ParaLine[][] = [];
  let current: ParaLine[] = [];
  lines.forEach((line, i) => {
    current.push(line);
    const next = lines[i + 1];
    if (next && line.right + 0.25 * line.size + next.firstWord <= right - 0.5) {
      out.push(current);
      current = [];
    }
  });
  if (current.length > 0) out.push(current);
  return out;
}

/** How lines are lined up, or null if they aren't lined up one way. */
function alignmentOf(lines: ParaLine[]): Align | null {
  if (lines.length < 2) return "left";
  const size = Math.max(...lines.map((l) => l.size));
  const tol = Math.max(1.5, 0.15 * size);
  const first = lines[0] as ParaLine;
  const rest = lines.slice(1);
  const left = (rest[0] as ParaLine).left;
  const same = (v: number[]) => v.every((x) => Math.abs(x - (v[0] as number)) <= tol);
  if (same(lines.map((l) => l.left))) return "left";
  // An indented first line, or a hanging one (a list item's number). With only two lines,
  // lining up on the right or the centre is the likelier reading.
  const indented = same(rest.map((l) => l.left)) && Math.abs(first.left - left) <= 4 * size;
  if (indented && lines.length > 2) return "left";
  if (same(lines.map((l) => l.right))) return "right";
  if (same(lines.map((l) => (l.left + l.right) / 2))) return "centre";
  return indented ? "left" : null;
}

function makeParagraph(analysis: PageAnalysis, lines: ParaLine[], id: number): ParagraphData {
  let align = alignmentOf(lines) ?? "left";
  const right = Math.max(...lines.map((l) => l.right));
  const size = Math.max(...lines.map((l) => l.size));
  const tol = Math.max(1.5, 0.15 * size);
  const body = lines.slice(0, -1);
  if (
    align === "left" &&
    body.every((l) => l.right >= right - tol) &&
    (lines.length >= 3 || body.some((l) => l.stretched))
  ) {
    align = "justify";
  }
  const first = lines[0] as ParaLine;
  const left = (lines[1] as ParaLine).left;
  const spacing =
    ((lines[lines.length - 1] as ParaLine).baseline - first.baseline) / (lines.length - 1);
  let reason: string | null = null;
  const locked = lines.find((l) => !l.editable);
  const keys = new Set(lines.flatMap((l) => [...l.keys]));
  if (locked) reason = locked.reason ?? "Part of this paragraph can't be edited.";
  else if (keys.size > 1) {
    reason =
      "This paragraph uses more than one font or size (a bold word, say), so it can only be edited a line at a time.";
  }
  const [x0, y0] = analysis.bounds;
  const boxes = lines.map((l) => (analysis.lines[l.id] as PageLine).bbox);
  const rect: Rect4 = [
    Math.min(...boxes.map((b) => b[0])) - x0,
    Math.min(...boxes.map((b) => b[1])) - y0,
    Math.max(...boxes.map((b) => b[2])) - x0,
    Math.max(...boxes.map((b) => b[3])) - y0,
  ];
  return {
    info: {
      id,
      lines: lines.map((l) => l.id),
      text: joinLines(lines.map((l) => l.text)),
      rect,
      align,
      editable: reason === null,
      reason,
    },
    lines,
    rotation: first.rotation,
    firstLeft: first.left,
    left,
    right,
    spacing,
  };
}

/** Lines joined into one text: with spaces, and words broken with a hyphen joined up. */
export function joinLines(lines: string[]): string {
  let text = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (!text) text = line;
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line;
    else text += ` ${line}`;
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// Editing a paragraph

/** Check new text for a paragraph: line breaks are kept; no other control characters. */
export function checkParagraphText(text: string): string {
  if (typeof text !== "string") throw new Error("The new text must be text");
  const normal = text.replace(/\r\n?|[\u2028\u2029]/g, "\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(normal))
    throw new Error("The new text has a character that can't be written.");
  if ([...normal].length > MAX_PARAGRAPH_TEXT)
    throw new Error(`The new text is too long (${MAX_PARAGRAPH_TEXT} characters at most).`);
  if (CJK.test(normal)) throw new Error("Chinese, Japanese and Korean text can't be written yet.");
  if (RTL.test(normal)) throw new Error("Right-to-left text can't be written yet.");
  return normal;
}

/** One line of the new layout: which old line (or the last one, for lines added) draws it. */
interface Slot {
  setup: LineSetup;
  /** Whether it's one of the paragraph's own lines (else it's added under the last). */
  own: boolean;
  /** Where its text may start along the line, and the room it has, in page units. */
  start: number;
  room: number;
  baseline: number;
}

/**
 * Work out a paragraph edit: how the new text breaks into lines, whether it fits, and the
 * replacements. Throws (in plain words) when it can't be done.
 */
export function planParagraphEdit(
  analysis: PageAnalysis,
  pid: number,
  newText: string,
): ParagraphPlan {
  const text = checkParagraphText(newText);
  const para = paragraphsOf(analysis)[pid];
  if (!para) throw new Error("That paragraph isn't on the page");
  if (!para.info.editable) throw new Error(para.info.reason ?? "This paragraph can't be edited.");
  const setups = para.lines.map((l) => prepareLine(analysis, l.id));
  const head = setups[0] as LineSetup;
  const last = setups[setups.length - 1] as LineSetup;
  const flat = text.replace(/\n/g, " ");
  const fonts = pickFonts(head, flat, { mixFirst: true, where: "this paragraph" });
  const rotation = para.rotation;
  const { align, right } = { align: para.info.align, right: para.right };
  const boxLeft = Math.min(para.firstLeft, para.left);
  const centre = para.lines.reduce((s, l) => s + (l.left + l.right) / 2, 0) / para.lines.length;
  const lastLine = para.lines[para.lines.length - 1] as ParaLine;
  const descent = Math.max(0, lastLine.bottom - lastLine.baseline);

  const slot = (i: number): Slot => {
    const own = i < setups.length;
    const setup = own ? (setups[i] as LineSetup) : last;
    const start = own ? setup.start : para.left;
    const room = align === "left" || align === "justify" ? right - start : right - boxLeft;
    const baseline = own
      ? (para.lines[i] as ParaLine).baseline
      : lastLine.baseline + (i - setups.length + 1) * para.spacing;
    return { setup, own, start, room, baseline };
  };
  const measure = (s: Slot, t: string) =>
    Math.abs(
      encode(t, fonts.fonts, s.setup.first, s.setup.spaceGap, s.setup.font.twoByte).advance *
        s.setup.unit,
    );

  // Break the text into lines, a word at a time; a line break typed starts a new line.
  const lines: { text: string; end: boolean }[] = [];
  let tooWide = false;
  for (const block of text.split("\n")) {
    const words = block.split(/[ \t\u00a0]+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const s = slot(lines.length);
      const candidate = current ? `${current} ${word}` : word;
      if (!current || measure(s, candidate) <= s.room + 0.5) {
        current = candidate;
        continue;
      }
      lines.push({ text: current, end: false });
      if (lines.length > MAX_NEW_LINES) throw tooManyLines();
      current = word;
    }
    if (current && measure(slot(lines.length), current) > slot(lines.length).room + 0.5)
      tooWide = true;
    lines.push({ text: current, end: true });
    if (lines.length > MAX_NEW_LINES) throw tooManyLines();
  }
  // A long word on a line of its own may stick out.
  for (let i = 0; i < lines.length; i++) {
    const s = slot(i);
    if (measure(s, (lines[i] as { text: string }).text) > s.room + 0.5) tooWide = true;
  }
  // Trailing empty lines (a line break typed at the end) are dropped.
  while (lines.length > 1 && !(lines[lines.length - 1] as { text: string }).text) lines.pop();

  // The room below: down to the next thing under the paragraph, or the bottom margin.
  const page = rectToFrame(rotation, analysis.bounds);
  const margin = Math.min(72, Math.max(18, boxLeft - page[0]));
  let limit = page[3] - margin;
  const inPara = new Set(para.info.lines);
  const paraBottom = Math.max(...para.lines.map((l) => l.bottom));
  for (let i = 0; i < analysis.lines.length; i++) {
    if (inPara.has(i)) continue;
    const other = rectToFrame(rotation, (analysis.lines[i] as PageLine).bbox);
    if (other[0] < right && other[2] > boxLeft && other[1] >= paraBottom - 0.5) {
      limit = Math.min(limit, other[1]);
    }
  }
  const paraTop = Math.min(...para.lines.map((l) => l.top));
  for (const m of analysis.marks) {
    const f = rectToFrame(rotation, m);
    const around = f[1] <= paraTop + 0.5 && f[3] >= paraBottom - 0.5;
    if (!around && f[0] < right && f[2] > boxLeft && f[1] >= paraBottom - 0.5) {
      limit = Math.min(limit, f[1]);
    }
  }
  let extra = 0;
  while (
    extra < MAX_NEW_LINES &&
    lastLine.baseline + (extra + 1) * para.spacing + descent <= limit + 0.5
  ) {
    extra++;
  }
  const fit = setups.length + extra;
  const overflow = lines.length > fit;
  const lowest = lastLine.baseline + Math.max(0, lines.length - setups.length) * para.spacing;
  if (lowest + descent > page[3] + 0.5) {
    throw new Error(
      `The new text needs ${lines.length} lines, and only ${Math.max(fit, setups.length)} fit before the bottom of the page. Make it shorter.`,
    );
  }

  // The replacements: each old line redrawn with its new line (or emptied), and lines added
  // under the last one.
  const fontName = fonts.fallback ? freeFontName(analysis, fonts.fallback) : null;
  const edits: EditMap = new Map();
  const encodeLine = (i: number) => {
    const s = slot(i);
    const { text: t, end } = lines[i] ?? { text: "", end: true };
    const op = s.setup.first;
    const toThousandths = (v: number) => (v * 1000) / (s.setup.unit * op.fs * op.th);
    const width = measure(s, t);
    let start = s.start;
    if (t && align === "right") start = right - width;
    else if (t && align === "centre") start = centre - width / 2;
    let space = 0;
    const spaces = (t.match(/ /g) ?? []).length;
    if (align === "justify" && !end && spaces > 0) {
      space = toThousandths((right - s.start - width) / spaces);
    }
    const lead = s.own ? toThousandths(start - s.start) : 0;
    const encoded = encode(t, fonts.fonts, op, s.setup.spaceGap, s.setup.font.twoByte, {
      lead,
      space,
    });
    return { slot: s, encoded, start, width };
  };
  const drawnLast = encodeLine(setups.length - 1);
  // Lines added under the last one, drawn by its first operator.
  const tailParts: string[] = [];
  let region: Rect4 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, -Infinity, -Infinity];
  if (lines.length > setups.length) {
    const op = last.first;
    const m = mul(op.tlm, op.device);
    const det = m[0] * m[3] - m[1] * m[2];
    if (!(Math.abs(det) > 1e-12)) throw new Error("This paragraph's position can't be worked out.");
    let px = 0;
    let py = 0;
    for (let i = setups.length; i < lines.length; i++) {
      const { slot: s, encoded, start } = encodeLine(i);
      // The text space position (from the line matrix) that puts the glyph origin here.
      const [x, y] = fromFrame(rotation, start, s.baseline);
      const dx = x - m[4];
      const dy = y - m[5];
      const tx = (dx * m[3] - dy * m[2]) / det;
      const ty = (dy * m[0] - dx * m[1]) / det - op.ts;
      tailParts.push(`${formatNumber(tx - px)} ${formatNumber(ty - py)} Td`);
      tailParts.push(...drawRuns(encoded.pieces, op, last.font, fontName));
      px = tx;
      py = ty;
    }
    // Back to where the text was, so whatever comes next stays put.
    const back = (-(op.lineX + op.advance) * 1000) / (op.fs * op.th);
    tailParts.push(`${formatNumber(-px)} ${formatNumber(-py)} Td`);
    if (Math.abs(back) > 1e-4) tailParts.push(`[${formatNumber(back)}] TJ`);
    // Hidden by a clipping area there: refused.
    const clip = op.clip ? rectToFrame(rotation, op.clip) : null;
    const bottom = lowest + descent;
    if (clip && (bottom > clip[3] + 0.5 || para.left < clip[0] - 0.5 || right > clip[2] + 0.5)) {
      throw new Error(
        "The new text needs more lines than the paragraph has, and the lines added would be hidden here. Make it shorter.",
      );
    }
    if (op.clipShaped) {
      throw new Error(
        "This paragraph is inside a shaped area that hides what's outside it, so it can't take more lines than it has.",
      );
    }
  }
  for (let i = 0; i < setups.length; i++) {
    const drawn = i === setups.length - 1 ? drawnLast : encodeLine(i);
    const s = drawn.slot;
    const oldWidth = (para.lines[i] as ParaLine).right - s.start;
    // Measured from where the line starts, as for a line edit; text moved left (to line it up
    // on the right or centre) mustn't go past a clipping edge either.
    checkClips(s.setup, drawn.start + drawn.width - s.start, oldWidth);
    const clip = s.setup.first.clip ? rectToFrame(rotation, s.setup.first.clip) : null;
    if (clip && drawn.start < Math.min(clip[0], s.start) - 0.5) {
      throw new Error(
        "The new text is too long for the space this paragraph is in: some of it would be hidden. Try something shorter.",
      );
    }
    lineReplacements(
      s.setup,
      drawn.encoded,
      fontName,
      edits,
      i === setups.length - 1 ? tailParts.join(" ") : "",
    );
  }
  for (let i = 0; i < Math.max(lines.length, setups.length); i++) {
    const s = slot(i);
    const top = s.baseline - (lastLine.baseline - lastLine.top);
    region = [
      Math.min(region[0], boxLeft),
      Math.min(region[1], top),
      Math.max(region[2], right),
      Math.max(region[3], s.baseline + descent),
    ];
  }
  const usesOwn = encode(flat, fonts.fonts, head.first, head.spaceGap, head.font.twoByte).usesOwn;
  const check: ParagraphEditCheck = {
    font: readableFontName(usesOwn || !fonts.fallback ? head.font.baseFont : fonts.fallback),
    fallback: fonts.fallback ? readableFontName(fonts.fallback) : null,
    missing: fonts.missing,
    lines: lines.length,
    oldLines: setups.length,
    fit,
    overflow,
    tooWide,
  };
  return {
    check,
    edits: finishEdits(edits, setups),
    addFont: fonts.fallback && fontName ? { name: fontName, font: fonts.fallback } : null,
    newLines: lines.map((l) => l.text),
    region: regionToPage(rotation, region),
  };
}

function tooManyLines(): Error {
  return new Error(`The new text is too long for one paragraph (${MAX_NEW_LINES} lines at most).`);
}

/** A point in a line's frame back in page space (the reverse of toFrame). */
function fromFrame(rotation: number, x: number, y: number): [number, number] {
  switch (rotation) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

function regionToPage(rotation: number, r: Rect4): Rect4 {
  const [ax, ay] = fromFrame(rotation, r[0], r[1]);
  const [bx, by] = fromFrame(rotation, r[2], r[3]);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/**
 * After a paragraph edit: every glyph drawn outside the paragraph must still be drawn where it
 * was, every line outside the new text's area must still be listed where it was, and the new
 * lines must be on the page.
 */
export function paragraphEditLooksRight(
  before: PageAnalysis,
  pid: number,
  plan: ParagraphPlan,
  afterGlyphs: Glyph[] | null,
  afterLines: PageLine[],
): boolean {
  const para = paragraphsOf(before)[pid];
  if (!para || !afterGlyphs) return false;
  const inPara = new Set(para.info.lines);
  // Glyphs, by where they're drawn.
  const grid = new Map<string, Glyph[]>();
  const cell = (x: number, y: number) => `${Math.round(x * 4)}:${Math.round(y * 4)}`;
  for (const g of afterGlyphs) {
    const key = cell(g.x, g.y);
    const list = grid.get(key);
    if (list) list.push(g);
    else grid.set(key, [g]);
  }
  const used = new Set<Glyph>();
  for (const g of before.glyphs) {
    if (g.line >= 0 && inPara.has(g.line)) continue;
    const cx = Math.round(g.x * 4);
    const cy = Math.round(g.y * 4);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (const h of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (used.has(h) || h.code !== g.code) continue;
          if (Math.abs(h.x - g.x) > 0.05 || Math.abs(h.y - g.y) > 0.05) continue;
          used.add(h);
          found = true;
          break;
        }
      }
    }
    if (!found) return false;
  }
  // What MuPDF reads, away from the new text: every character still there, where it was. (Its
  // lines may be grouped differently: text drawn in between can split one in two.)
  const squash = (s: string) => s.replace(/\s+/g, "");
  const near = (b: Rect4) =>
    b[0] < plan.region[2] &&
    b[2] > plan.region[0] &&
    b[1] < plan.region[3] &&
    b[3] > plan.region[1];
  const chars = new Map<string, number>();
  const at = (c: string, x: number, y: number) =>
    `${c}@${Math.round(x * 20)}:${Math.round(y * 20)}`;
  for (const l of afterLines) {
    for (const ch of l.chars) {
      const k = at(ch.c, ch.x, ch.y);
      chars.set(k, (chars.get(k) ?? 0) + 1);
    }
  }
  for (let i = 0; i < before.raw.length; i++) {
    if (inPara.has(before.groupOf[i] as number)) continue;
    const old = before.raw[i] as PageLine;
    if (near(old.bbox)) continue;
    for (const ch of old.chars) {
      if (/\s/.test(ch.c)) continue;
      // In its own cell or one next to it, in case it's on the edge of one.
      let k = "";
      for (let n = 0; n < 9 && !k; n++) {
        const c = at(ch.c, ch.x + ((n % 3) - 1) / 20, ch.y + (Math.floor(n / 3) - 1) / 20);
        if ((chars.get(c) ?? 0) > 0) k = c;
      }
      if (!k) return false;
      chars.set(k, (chars.get(k) as number) - 1);
    }
  }
  // The new lines, where they don't run into anything.
  const count = plan.check.overflow ? plan.check.oldLines : plan.newLines.length;
  const all = squash(afterLines.map((l) => l.text).join(""));
  for (const line of plan.newLines.slice(0, count)) {
    const want = squash(line);
    if (want && !afterLines.some((l) => squash(l.text).includes(want)) && !all.includes(want))
      return false;
  }
  return true;
}
