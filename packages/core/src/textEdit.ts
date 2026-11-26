// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Editing a line of text in place (Phase 6, step 1).
//
// MuPDF finds the lines of text on a page (structured text). The page's content stream is
// parsed here (contentStream.ts) and followed operator by operator, keeping the text state and
// transformation, to work out where every glyph it draws lands. Glyphs are matched to MuPDF's
// characters by position, which ties each line to the operators that draw it.
//
// An edit replaces only those operators. The first draws the new text, in the same font (or a
// standard font when the page's font lacks a character), from the same place, with the same
// colour, size and spacing, since everything else in the stream is left as it is. The others
// become a bare move ("[n] TJ") the length of what they drew, so any text after them in the
// same text object stays exactly where it was. Every other byte of the stream is unchanged.
//
// When anything is uncertain, the line is refused with a reason rather than risk the page.

import * as mupdf from "mupdf";
import { copyContainer } from "./annotationObjects";
import {
  ContentStreamError,
  formatName,
  formatNumber,
  hexString,
  type Operand,
  type Operation,
  parseContentStreams,
} from "./contentStream";
import {
  type FontInfo,
  type FontStyle,
  loadFont,
  readableFontName,
  type StandardFont,
  standardFontFor,
  standardFontInfo,
  standardFontObject,
} from "./textFonts";
import { MAX_LINE_TEXT } from "./textLimits";

export type Matrix6 = [number, number, number, number, number, number];
export type Rect4 = [number, number, number, number];

/** A line of text on a page, as the Edit text tool shows it. */
export interface TextLineInfo {
  /** Its position in the page's list; pass it back with `text` to edit it. */
  id: number;
  text: string;
  /** Its box in points from the page's top-left corner as shown. */
  rect: Rect4;
  /** Which way it reads as shown: 0 is left to right, upright; 90 is downwards; and so on. */
  rotation: 0 | 90 | 180 | 270;
  /** Font size in points as shown. */
  size: number;
  /** The font's name, e.g. "DejaVu Sans Bold". */
  font: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** Text colour as red, green and blue from 0 to 1. */
  color: [number, number, number];
  /** Whether it can be edited, and if not, why not (in plain words). */
  editable: boolean;
  reason: string | null;
}

/** What an edit will do, worked out before it's made, so the user can be warned. */
export interface TextEditCheck {
  /** The font the new text will use, as people would name it. */
  font: string;
  /** Set when the line's own font lacks characters: the standard font used instead. */
  fallback: string | null;
  /** The characters the line's own font doesn't have. */
  missing: string[];
  /** The new text runs into the next thing on the line or off the page. */
  tooWide: boolean;
  /** The line used more than one font or size; the new text uses the first one. */
  mixedFonts: boolean;
  /** Width of the new text and the room it has, in points. */
  width: number;
  room: number;
}

/** Caps, so a hostile page can't make analysis take for ever. */
const MAX_STREAMS = 1000;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_GLYPHS = 400_000;
const MAX_LINES = 20_000;
const MAX_STATE_DEPTH = 256;

// ---------------------------------------------------------------------------------------------
// Matrices

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0];

function mul(a: Matrix6, b: Matrix6): Matrix6 {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix6, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function finiteMatrix(m: readonly number[]): boolean {
  return m.length === 6 && m.every((v) => Number.isFinite(v) && Math.abs(v) < 1e7);
}

/** Which way a text rendering matrix reads as shown, or null if it's skewed or mirrored. */
export function readingRotation(m: Matrix6): 0 | 90 | 180 | 270 | null {
  const [a, b, c, d] = m;
  const size = Math.max(Math.hypot(a, b), Math.hypot(c, d));
  if (!(size > 0)) return null;
  const eps = 1e-3 * size;
  // Device space has y going down, so upright text has a > 0 and d < 0.
  if (Math.abs(b) <= eps && Math.abs(c) <= eps) {
    if (a > 0 && d < 0) return 0;
    if (a < 0 && d > 0) return 180;
    return null;
  }
  if (Math.abs(a) <= eps && Math.abs(d) <= eps) {
    if (b > 0 && c > 0) return 90;
    if (b < 0 && c < 0) return 270;
  }
  return null;
}

/**
 * Whether a path's points (in order) are an upright rectangle as shown: four corners (a fifth
 * back at the start is allowed), each side straight across or straight down.
 */
export function uprightRectangle(points: readonly (readonly [number, number])[]): boolean {
  const eps = 1e-3;
  const pts = [...points];
  const [fx, fy] = pts[0] ?? [0, 0];
  const last = pts[pts.length - 1];
  if (pts.length === 5 && last && Math.abs(last[0] - fx) < eps && Math.abs(last[1] - fy) < eps) {
    pts.pop();
  }
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i] as [number, number];
    const [bx, by] = pts[(i + 1) % 4] as [number, number];
    const across = Math.abs(ay - by) < eps && Math.abs(ax - bx) >= eps;
    const down = Math.abs(ax - bx) < eps && Math.abs(ay - by) >= eps;
    if (!across && !down) return false;
    // Sides alternate: across, down, across, down (or the other way).
    const cy = (pts[(i + 2) % 4] as [number, number])[1];
    const nextAcross = Math.abs(by - cy) < eps;
    if (across === nextAcross) return false;
  }
  return true;
}

/** A point in a frame where x runs along the text and y across it, for a reading rotation. */
function toFrame(rotation: number, x: number, y: number): [number, number] {
  switch (rotation) {
    case 90:
      return [y, -x];
    case 180:
      return [-x, -y];
    case 270:
      return [-y, x];
    default:
      return [x, y];
  }
}

function rectToFrame(rotation: number, r: Rect4): Rect4 {
  const [ax, ay] = toFrame(rotation, r[0], r[1]);
  const [bx, by] = toFrame(rotation, r[2], r[3]);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

function intersect(a: Rect4 | null, b: Rect4): Rect4 {
  if (!a) return b;
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function contains(outer: Rect4, inner: Rect4, slack: number): boolean {
  return (
    inner[0] >= outer[0] - slack &&
    inner[1] >= outer[1] - slack &&
    inner[2] <= outer[2] + slack &&
    inner[3] <= outer[3] + slack
  );
}

function overlaps(a: Rect4, b: Rect4): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

// ---------------------------------------------------------------------------------------------
// The page's lines, as MuPDF sees them

interface PageChar {
  c: string;
  x: number;
  y: number;
  line: number;
}

interface PageLine {
  text: string;
  bbox: Rect4;
  wmode: number;
  chars: PageChar[];
  size: number;
  fontName: string;
  style: FontStyle;
  color: [number, number, number];
  rtl: boolean;
}

/** The lines of text in a page's own content (not annotations or form fields). */
export function contentLines(page: mupdf.PDFPage): PageLine[] {
  const list = new mupdf.DisplayList(page.getBounds());
  try {
    const device = new mupdf.DisplayListDevice(list);
    try {
      page.runPageContents(device, mupdf.Matrix.identity);
      device.close();
    } finally {
      device.destroy();
    }
    const stext = list.toStructuredText("preserve-whitespace");
    try {
      return readLines(stext);
    } finally {
      stext.destroy();
    }
  } finally {
    list.destroy();
  }
}

function readLines(stext: mupdf.StructuredText): PageLine[] {
  const lines: PageLine[] = [];
  let line: PageLine | null = null;
  let count = 0;
  stext.walk({
    beginLine(bbox, wmode) {
      line = {
        text: "",
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        wmode,
        chars: [],
        size: 0,
        fontName: "",
        style: { serif: false, mono: false, bold: false, italic: false },
        color: [0, 0, 0],
        rtl: false,
      };
    },
    onChar(c, origin, font, size, _quad, color, bidi) {
      const l = line as PageLine | null;
      if (!l || ++count > MAX_GLYPHS) return;
      if (l.chars.length === 0) {
        l.size = size;
        l.fontName = font.getName();
        l.style = {
          serif: font.isSerif(),
          mono: font.isMono(),
          bold: font.isBold(),
          italic: font.isItalic(),
        };
        l.color = rgb(color);
      }
      if (bidi % 2 === 1) l.rtl = true;
      l.text += c;
      l.chars.push({ c, x: origin[0], y: origin[1], line: lines.length });
    },
    endLine() {
      const l = line as PageLine | null;
      if (l && l.chars.length > 0 && lines.length < MAX_LINES) lines.push(l);
      line = null;
    },
  });
  return lines;
}

function rgb(color: readonly number[]): [number, number, number] {
  const clamp = (v: number) => Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1);
  if (color.length === 3)
    return [clamp(color[0] as number), clamp(color[1] as number), clamp(color[2] as number)];
  if (color.length === 1) {
    const g = clamp(color[0] as number);
    return [g, g, g];
  }
  if (color.length === 4) {
    const [c, m, y, k] = color.map(clamp) as [number, number, number, number];
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  return [0, 0, 0];
}

// ---------------------------------------------------------------------------------------------
// Following the content stream

interface Place {
  stream: number;
  start: number;
  end: number;
}

interface Glyph {
  op: ShowOp;
  code: number;
  text: string;
  /** Where it's drawn (its origin) and where the next glyph would go, in page space. */
  x: number;
  y: number;
  ex: number;
  ey: number;
  /** The line it was matched to, or -1. */
  line: number;
}

/** One step of a text-showing operator: a glyph, or a move in a TJ array. Each moves `tx`. */
type Item = { glyph: Glyph; bytes: Uint8Array; tx: number } | { value: number; tx: number };

interface Marked {
  begin: Place;
  end: Place | null;
  actualText: boolean;
  ops: ShowOp[];
}

interface ShowOp extends Place {
  op: string;
  operands: Operand[];
  font: FontInfo | null;
  fontResource: string | null;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  ts: number;
  tr: number;
  /** Text rendering matrix where the op starts drawing (after any line move), or null. */
  trm: Matrix6 | null;
  /** How far it moves along the line, in text space. */
  advance: number;
  glyphs: Glyph[];
  /** What it shows, in order: glyphs (with their code's bytes) and TJ moves. */
  items: Item[];
  clip: Rect4 | null;
  /** Clipped by a shape that isn't an upright rectangle (`clip` is only its bounding box). */
  clipShaped: boolean;
  textClip: boolean;
  marked: Marked[];
  /** False when where it draws isn't known (an unreadable font, an unknown position). */
  known: boolean;
}

interface State {
  ctm: Matrix6;
  clip: Rect4 | null;
  /** Clipped by a shape that isn't an upright rectangle (`clip` is only its bounding box). */
  clipShaped: boolean;
  textClip: boolean;
  font: FontInfo | null;
  fontResource: string | null;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  tr: number;
  ts: number;
}

class Unreadable extends Error {}

function num(o: Operand | undefined): number {
  if (o?.kind !== "number" || !Number.isFinite(o.value)) throw new Unreadable("");
  return o.value;
}

function nums(op: Operation, count: number): number[] {
  if (op.operands.length !== count) throw new Unreadable("");
  return op.operands.map(num);
}

/** Everything known about one page's text, for listing its lines and editing one. */
export interface PageAnalysis {
  /** Lines as listed: MuPDF's lines, with parts drawn by one operator joined up. */
  lines: PageLine[];
  /** MuPDF's lines as it found them, and which listed line each is part of. */
  raw: PageLine[];
  groupOf: number[];
  infos: TextLineInfo[];
  /** The show ops that draw each line (for editable lines). */
  lineOps: Map<number, ShowOp[]>;
  streams: { object: mupdf.PDFObject; bytes: Uint8Array }[];
  bounds: Rect4;
  /** Why nothing on the page can be edited, or null. */
  problem: string | null;
  /** The page's font resources: name to BaseFont. */
  fontNames: Map<string, string>;
}

/** Read a page's text and work out which lines can be edited. */
export function analysePage(pdf: mupdf.PDFDocument, index: number): PageAnalysis {
  const page = pdf.loadPage(index);
  try {
    const pageBox = page.getBounds();
    const bounds: Rect4 = [pageBox[0], pageBox[1], pageBox[2], pageBox[3]];
    const transform = page.getTransform() as Matrix6;
    const raw = contentLines(page);
    const pageObj = pdf.findPage(index);
    const resources = pageObj.getInheritable("Resources");
    const analysis: PageAnalysis = {
      lines: raw,
      raw,
      groupOf: raw.map((_, i) => i),
      infos: [],
      lineOps: new Map(),
      streams: [],
      bounds,
      problem: null,
      fontNames: new Map(),
    };
    const fonts = resources.isDictionary() ? resources.get("Font") : null;
    if (fonts?.isDictionary()) {
      fonts.forEach((_, name) => {
        const font = fonts.get(String(name));
        const base = font.isDictionary() ? font.get("BaseFont") : null;
        analysis.fontNames.set(String(name), base?.isName() ? base.asName() : "");
      });
    }
    let walk: Walk | null = null;
    try {
      analysis.streams = readStreams(pageObj);
      walk = new Walk(resources.isDictionary() ? resources : null, transform);
      const parsed = parseContentStreams(analysis.streams.map((s) => s.bytes));
      for (const { operation, stream } of parsed) walk.step(operation, stream);
    } catch (err) {
      if (!(err instanceof Unreadable || err instanceof ContentStreamError)) throw err;
      analysis.problem =
        err instanceof Unreadable && err.message
          ? err.message
          : "This page's drawing instructions couldn't be read, so its text can't be edited.";
      walk = null;
    }
    if (walk) {
      matchGlyphs(walk.glyphs, raw);
      const merged = mergeLines(raw, walk.ops);
      analysis.lines = merged.lines;
      analysis.groupOf = merged.groupOf;
      for (const g of walk.glyphs) if (g.line >= 0) g.line = merged.groupOf[g.line] as number;
    }
    const lines = analysis.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as PageLine;
      const verdict = analysis.problem
        ? { reason: analysis.problem, ops: [] }
        : judgeLine(walk as Walk, lines, i);
      if (verdict.reason === null) analysis.lineOps.set(i, verdict.ops);
      analysis.infos.push(describeLine(line, i, bounds, verdict.reason, verdict.ops));
    }
    return analysis;
  } finally {
    page.destroy();
  }
}

function readStreams(pageObj: mupdf.PDFObject): { object: mupdf.PDFObject; bytes: Uint8Array }[] {
  const contents = pageObj.get("Contents");
  const objects: mupdf.PDFObject[] = [];
  if (contents.isArray()) {
    if (contents.length > MAX_STREAMS)
      throw new Unreadable("This page has too many content streams to edit.");
    for (let i = 0; i < contents.length; i++) objects.push(contents.get(i));
  } else if (!contents.isNull()) {
    objects.push(contents);
  }
  let total = 0;
  return objects.map((object) => {
    if (!object.isStream())
      throw new Unreadable("This page's content can't be read, so its text can't be edited.");
    const buffer = object.readStream();
    try {
      const bytes = buffer.asUint8Array().slice();
      total += bytes.length;
      if (bytes.length > MAX_STREAM_BYTES || total > MAX_TOTAL_BYTES) {
        throw new Unreadable("This page's content is too large to edit.");
      }
      return { object, bytes };
    } finally {
      buffer.destroy();
    }
  });
}

/** Follows a page's operators, recording each text-showing operator and its glyphs. */
class Walk {
  readonly ops: ShowOp[] = [];
  readonly glyphs: Glyph[] = [];
  /** Boxes (in page space) of form XObjects drawn on the page. */
  readonly forms: Rect4[] = [];
  private state: State = {
    ctm: IDENTITY,
    clip: null,
    clipShaped: false,
    textClip: false,
    font: null,
    fontResource: null,
    fs: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    tr: 0,
    ts: 0,
  };
  private stack: State[] = [];
  private tm: Matrix6 = IDENTITY;
  private tlm: Matrix6 = IDENTITY;
  /** Whether the text matrix is known (it isn't after text in an unreadable font). */
  private tmKnown = true;
  private inText = false;
  private clipInText = false;
  private path: Rect4 | null = null;
  private pathBroken = false;
  /** The current path's points in page space, while it could still be an upright rectangle. */
  private pathPoints: [number, number][] = [];
  /** False once the path has a curve, a second part, or more points than a rectangle. */
  private pathRect = true;
  private pendingClip = false;
  private marked: Marked[] = [];
  private fonts = new Map<string, FontInfo | null>();

  constructor(
    private readonly resources: mupdf.PDFObject | null,
    private readonly page: Matrix6,
  ) {}

  private device(): Matrix6 {
    return mul(this.state.ctm, this.page);
  }

  step(op: Operation, stream: number): void {
    const s = this.state;
    switch (op.op) {
      case "q":
        if (this.stack.length >= MAX_STATE_DEPTH)
          throw new Unreadable("This page's content is nested too deeply to edit.");
        this.stack.push({ ...s });
        break;
      case "Q":
        this.state = this.stack.pop() ?? this.state;
        break;
      case "cm": {
        const m = nums(op, 6) as Matrix6;
        if (!finiteMatrix(m)) throw new Unreadable("");
        s.ctm = mul(m, s.ctm);
        break;
      }
      case "BT":
        this.inText = true;
        this.tm = IDENTITY;
        this.tlm = IDENTITY;
        this.tmKnown = true;
        this.clipInText = false;
        break;
      case "ET":
        this.inText = false;
        if (this.clipInText) s.textClip = true;
        break;
      case "Tc":
        s.tc = nums(op, 1)[0] as number;
        break;
      case "Tw":
        s.tw = nums(op, 1)[0] as number;
        break;
      case "Tz":
        s.th = (nums(op, 1)[0] as number) / 100;
        break;
      case "TL":
        s.tl = nums(op, 1)[0] as number;
        break;
      case "Ts":
        s.ts = nums(op, 1)[0] as number;
        break;
      case "Tr":
        s.tr = nums(op, 1)[0] as number;
        break;
      case "Tf": {
        const [name, size] = op.operands;
        if (op.operands.length !== 2 || name?.kind !== "name") throw new Unreadable("");
        s.fs = num(size);
        s.fontResource = name.value;
        s.font = this.font(name.value);
        break;
      }
      case "Td": {
        const [tx, ty] = nums(op, 2) as [number, number];
        this.moveLine(tx, ty);
        break;
      }
      case "TD": {
        const [tx, ty] = nums(op, 2) as [number, number];
        s.tl = -ty;
        this.moveLine(tx, ty);
        break;
      }
      case "Tm": {
        const m = nums(op, 6) as Matrix6;
        if (!finiteMatrix(m)) throw new Unreadable("");
        this.tm = m;
        this.tlm = m;
        this.tmKnown = true;
        break;
      }
      case "T*":
        nums(op, 0);
        this.moveLine(0, -s.tl);
        break;
      case "Tj":
      case "TJ":
      case "'":
      case '"':
        this.show(op, stream);
        break;
      case "m":
        // A second part (subpath) means the clip isn't one rectangle.
        if (this.path) this.pathRect = false;
        this.addPoints(op, 2, true);
        break;
      case "l":
        this.addPoints(op, 2, true);
        break;
      case "c":
        this.pathRect = false;
        this.addPoints(op, 6);
        break;
      case "v":
      case "y":
        this.pathRect = false;
        this.addPoints(op, 4);
        break;
      case "re": {
        if (op.operands.length !== 4 || !op.operands.every((o) => o.kind === "number")) {
          this.pathBroken = true;
          break;
        }
        const [x, y, w, h] = op.operands.map(num) as [number, number, number, number];
        if (this.path) this.pathRect = false;
        // Corners in order round the rectangle.
        this.addPoint(x, y, true);
        this.addPoint(x + w, y, true);
        this.addPoint(x + w, y + h, true);
        this.addPoint(x, y + h, true);
        break;
      }
      case "h":
        break;
      case "W":
      case "W*":
        this.pendingClip = true;
        break;
      case "n":
      case "f":
      case "F":
      case "f*":
      case "S":
      case "s":
      case "B":
      case "B*":
      case "b":
      case "b*":
        if (this.pendingClip) {
          // An unreadable path clips to who knows what: nothing under it is edited.
          s.clip = this.pathBroken || !this.path ? [0, 0, 0, 0] : intersect(s.clip, this.path);
          // Any other shape (a curve, a slanted or rotated rectangle, several parts) is only
          // known by its bounding box, which may show more than the shape does.
          if (!this.pathRect || !uprightRectangle(this.pathPoints)) s.clipShaped = true;
        }
        this.path = null;
        this.pathBroken = false;
        this.pathPoints = [];
        this.pathRect = true;
        this.pendingClip = false;
        break;
      case "BMC":
      case "BDC":
        this.marked.push({
          begin: { stream, start: op.start, end: op.end },
          end: null,
          actualText: op.op === "BDC" && this.hasActualText(op.operands[1]),
          ops: [],
        });
        break;
      case "EMC": {
        const m = this.marked.pop();
        if (m) m.end = { stream, start: op.start, end: op.end };
        break;
      }
      case "Do":
        this.drawObject(op);
        break;
      case "gs":
        this.graphicsState(op);
        break;
    }
  }

  private moveLine(tx: number, ty: number): void {
    this.tlm = mul([1, 0, 0, 1, tx, ty], this.tlm);
    this.tm = this.tlm;
    this.tmKnown = true;
  }

  private addPoints(op: Operation, count: number, corner = false): void {
    if (op.operands.length !== count || !op.operands.every((o) => o.kind === "number")) {
      this.pathBroken = true;
      return;
    }
    const v = op.operands.map(num);
    for (let i = 0; i < count; i += 2) this.addPoint(v[i] as number, v[i + 1] as number, corner);
  }

  private addPoint(x: number, y: number, corner = false): void {
    const [px, py] = apply(this.device(), x, y);
    if (corner && this.pathRect) {
      if (this.pathPoints.length < 5) this.pathPoints.push([px, py]);
      else this.pathRect = false;
    }
    if (!this.path) this.path = [px, py, px, py];
    else {
      this.path = [
        Math.min(this.path[0], px),
        Math.min(this.path[1], py),
        Math.max(this.path[2], px),
        Math.max(this.path[3], py),
      ];
    }
  }

  private font(name: string): FontInfo | null {
    if (this.fonts.has(name)) return this.fonts.get(name) ?? null;
    let info: FontInfo | null = null;
    const fonts = this.resources?.get("Font");
    const object = fonts?.isDictionary() ? fonts.get(name) : null;
    if (object?.resolve().isDictionary()) info = loadFont(object);
    this.fonts.set(name, info);
    return info;
  }

  private hasActualText(props: Operand | undefined): boolean {
    if (props?.kind === "dict") return props.entries.has("ActualText");
    if (props?.kind === "name") {
      const properties = this.resources?.get("Properties");
      const p = properties?.isDictionary() ? properties.get(props.value) : null;
      return p?.isDictionary() === true && !p.get("ActualText").isNull();
    }
    return false;
  }

  private drawObject(op: Operation): void {
    const name = op.operands[0];
    if (name?.kind !== "name") return;
    const xobjects = this.resources?.get("XObject");
    const object = xobjects?.isDictionary() ? xobjects.get(name.value) : null;
    if (!object?.isStream()) return;
    const subtype = object.get("Subtype");
    if (!subtype.isName() || subtype.asName() !== "Form") return;
    const bbox = object.get("BBox");
    const matrix = object.get("Matrix");
    let m: Matrix6 = IDENTITY;
    if (matrix.isArray() && matrix.length === 6) {
      const v = [0, 1, 2, 3, 4, 5].map((i) =>
        matrix.get(i).isNumber() ? matrix.get(i).asNumber() : 0,
      );
      if (finiteMatrix(v)) m = v as Matrix6;
    }
    const d = mul(m, this.device());
    if (bbox.isArray() && bbox.length === 4) {
      const b = [0, 1, 2, 3].map((i) => (bbox.get(i).isNumber() ? bbox.get(i).asNumber() : 0));
      const pts = [
        apply(d, b[0] as number, b[1] as number),
        apply(d, b[2] as number, b[1] as number),
        apply(d, b[0] as number, b[3] as number),
        apply(d, b[2] as number, b[3] as number),
      ];
      this.forms.push([
        Math.min(...pts.map((p) => p[0])),
        Math.min(...pts.map((p) => p[1])),
        Math.max(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1])),
      ]);
    } else {
      this.forms.push([-1e9, -1e9, 1e9, 1e9]);
    }
  }

  private graphicsState(op: Operation): void {
    const name = op.operands[0];
    if (name?.kind !== "name") return;
    const states = this.resources?.get("ExtGState");
    const gs = states?.isDictionary() ? states.get(name.value) : null;
    if (gs?.isDictionary() && !gs.get("Font").isNull()) {
      // A font set this way is rare; text drawn with it isn't followed.
      this.state.font = null;
      this.state.fontResource = null;
    }
  }

  private show(op: Operation, stream: number): void {
    const s = this.state;
    if (!this.inText) throw new Unreadable("");
    if (op.op === "'" || op.op === '"') {
      if (op.op === '"') {
        if (op.operands.length !== 3) throw new Unreadable("");
        s.tw = num(op.operands[0]);
        s.tc = num(op.operands[1]);
      }
      this.moveLine(0, -s.tl);
    }
    const shown = op.operands[op.operands.length - 1];
    const expected = op.op === '"' ? 3 : 1;
    if (op.operands.length !== expected || !shown) throw new Unreadable("");
    if (op.op === "TJ" ? shown.kind !== "array" : shown.kind !== "string") throw new Unreadable("");

    const font = s.font?.measurable ? s.font : null;
    const known = this.tmKnown && font !== null && s.fs !== 0 && s.th !== 0 && !op.split;
    const record: ShowOp = {
      stream,
      start: op.start,
      end: op.end,
      op: op.op,
      operands: op.operands,
      font: s.font,
      fontResource: s.fontResource,
      fs: s.fs,
      tc: s.tc,
      tw: s.tw,
      th: s.th,
      ts: s.ts,
      tr: s.tr,
      trm: null,
      advance: 0,
      glyphs: [],
      items: [],
      clip: s.clip,
      clipShaped: s.clipShaped,
      textClip: s.textClip,
      marked: [...this.marked],
      known,
    };
    for (const m of this.marked) m.ops.push(record);
    this.ops.push(record);
    if (s.tr >= 4) this.clipInText = true;
    if (!known || !font) {
      // Where later text in this text object goes isn't known until it's positioned again.
      this.tmKnown = false;
      return;
    }
    const device = this.device();
    const scale: Matrix6 = [s.fs * s.th, 0, 0, s.fs, 0, s.ts];
    record.trm = mul(mul(scale, this.tm), device);
    const items = shown.kind === "array" ? shown.items : [shown];
    for (const item of items) {
      if (item.kind === "number") {
        const tx = (-item.value / 1000) * s.fs * s.th;
        this.advance(record, tx);
        record.items.push({ value: item.value, tx });
        continue;
      }
      if (item.kind !== "string") throw new Unreadable("");
      const bytes = item.bytes;
      const step = font.twoByte ? 2 : 1;
      if (bytes.length % step !== 0) {
        record.known = false;
        this.tmKnown = false;
        return;
      }
      for (let i = 0; i < bytes.length; i += step) {
        const code =
          step === 2
            ? ((bytes[i] as number) << 8) | (bytes[i + 1] as number)
            : (bytes[i] as number);
        const w = font.width(code) / 1000;
        const tx = (w * s.fs + s.tc + (step === 1 && code === 32 ? s.tw : 0)) * s.th;
        const [x, y] = apply(mul(mul(scale, this.tm), device), 0, 0);
        this.advance(record, tx);
        const [ex, ey] = apply(mul(mul(scale, this.tm), device), 0, 0);
        if (this.glyphs.length >= MAX_GLYPHS)
          throw new Unreadable("This page has too much text to edit.");
        const glyph: Glyph = { op: record, code, text: font.unicode(code), x, y, ex, ey, line: -1 };
        record.glyphs.push(glyph);
        record.items.push({ glyph, bytes: bytes.subarray(i, i + step), tx });
        this.glyphs.push(glyph);
      }
    }
  }

  private advance(record: ShowOp, tx: number): void {
    this.tm = mul([1, 0, 0, 1, tx, 0], this.tm);
    record.advance += tx;
  }
}

// ---------------------------------------------------------------------------------------------
// Matching glyphs to MuPDF's characters

const MATCH_TOLERANCE = 0.25;

function matchGlyphs(glyphs: Glyph[], lines: PageLine[]): void {
  const grid = new Map<string, PageChar[]>();
  for (const line of lines) {
    for (const ch of line.chars) {
      const key = `${Math.round(ch.x)}:${Math.round(ch.y)}`;
      const cell = grid.get(key);
      if (cell) cell.push(ch);
      else grid.set(key, [ch]);
    }
  }
  for (const g of glyphs) {
    let best: PageChar | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const cx = Math.round(g.x);
    const cy = Math.round(g.y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const ch of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const d = Math.hypot(ch.x - g.x, ch.y - g.y);
          if (d > MATCH_TOLERANCE) continue;
          // The same character wins over a nearer different one (text drawn over text).
          const score = d + (g.text && g.text[0] === ch.c ? 0 : 1);
          if (score < bestScore) {
            bestScore = score;
            best = ch;
          }
        }
      }
    }
    if (best) g.line = best.line;
  }
}

/**
 * Where a line's glyphs are in an op's items: the first and last, or null if other text is
 * drawn in between. Glyphs MuPDF didn't list (text drawn twice for a bold look, say) count as
 * the line's when they're on it.
 */
function rangeIn(op: ShowOp, id: number, line: PageLine): [number, number] | null {
  const near: Rect4 = [
    line.bbox[0] - line.size,
    line.bbox[1] - line.size / 2,
    line.bbox[2] + line.size,
    line.bbox[3] + line.size / 2,
  ];
  let from = -1;
  let to = -1;
  op.items.forEach((item, i) => {
    if ("glyph" in item && item.glyph.line === id) {
      if (from < 0) from = i;
      to = i;
    }
  });
  if (from < 0) return null;
  for (let i = from; i <= to; i++) {
    const item = op.items[i] as Item;
    if (!("glyph" in item) || item.glyph.line === id) continue;
    const g = item.glyph;
    if (g.line >= 0 || !(g.x >= near[0] && g.x <= near[2] && g.y >= near[1] && g.y <= near[3]))
      return null;
  }
  return [from, to];
}

/**
 * Join lines that one operator draws together on one baseline: MuPDF splits a line where there's
 * a wide gap ("1   Introduction", or justified text), but it's one piece of text in the file.
 * Parts further apart than a few characters (columns, say) aren't joined.
 */
function mergeLines(raw: PageLine[], ops: ShowOp[]): { lines: PageLine[]; groupOf: number[] } {
  const parent = raw.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    parent[i] = r;
    return r;
  };
  for (const op of ops) {
    if (!op.trm || readingRotation(op.trm) === null) continue;
    const touched = [...new Set(op.glyphs.map((g) => g.line).filter((l) => l >= 0))];
    if (touched.length < 2) continue;
    const rotation = readingRotation(op.trm) as number;
    const boxes = touched
      .map((l) => ({ l, box: rectToFrame(rotation, (raw[l] as PageLine).bbox) }))
      .sort((a, b) => a.box[0] - b.box[0]);
    const size = Math.max(...touched.map((l) => (raw[l] as PageLine).size), 1);
    let close = true;
    for (let i = 1; i < boxes.length; i++) {
      const prev = (boxes[i - 1] as { box: Rect4 }).box;
      const next = (boxes[i] as { box: Rect4 }).box;
      if (
        next[0] - prev[2] > 3 * size ||
        (raw[(boxes[i] as { l: number }).l] as PageLine).wmode !== 0
      ) {
        close = false;
      }
    }
    if (!close) continue;
    for (const l of touched) parent[find(l)] = find(touched[0] as number);
  }
  const groups = new Map<number, number[]>();
  raw.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  const lines: PageLine[] = [];
  const groupOf = raw.map(() => 0);
  for (const members of groups.values()) {
    const index = lines.length;
    for (const m of members) groupOf[m] = index;
    if (members.length === 1) {
      const only = raw[members[0] as number] as PageLine;
      lines.push({ ...only, chars: only.chars.map((c) => ({ ...c, line: index })) });
      continue;
    }
    // In reading order: by where each part starts along the line.
    const parts = members.map((m) => raw[m] as PageLine);
    const first = parts[0] as PageLine;
    const dx = (first.chars[1]?.x ?? first.chars[0]?.x ?? 0) - (first.chars[0]?.x ?? 0);
    const dy = (first.chars[1]?.y ?? first.chars[0]?.y ?? 0) - (first.chars[0]?.y ?? 0);
    const along = (l: PageLine) => (l.chars[0] ? l.chars[0].x * dx + l.chars[0].y * dy : 0);
    if (dx !== 0 || dy !== 0) parts.sort((a, b) => along(a) - along(b));
    else parts.sort((a, b) => a.bbox[0] - b.bbox[0]);
    let text = "";
    const chars: PageChar[] = [];
    for (const part of parts) {
      if (text && !/\s$/.test(text) && !/^\s/.test(part.text)) text += " ";
      text += part.text;
      for (const c of part.chars) chars.push({ ...c, line: index });
    }
    const lead = parts[0] as PageLine;
    lines.push({
      ...lead,
      text,
      chars,
      bbox: [
        Math.min(...parts.map((p) => p.bbox[0])),
        Math.min(...parts.map((p) => p.bbox[1])),
        Math.max(...parts.map((p) => p.bbox[2])),
        Math.max(...parts.map((p) => p.bbox[3])),
      ],
      rtl: parts.some((p) => p.rtl),
    });
  }
  return { lines, groupOf };
}

const CJK =
  /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff00-\uffef]|[\u{20000}-\u{3ffff}]/u;
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/** Whether a line can be edited: null and its ops, or the reason it can't. */
function judgeLine(
  walk: Walk,
  lines: PageLine[],
  index: number,
): { reason: string | null; ops: ShowOp[] } {
  const line = lines[index] as PageLine;
  const no = (reason: string) => ({ reason, ops: [] });
  if (line.wmode !== 0) return no("Vertical text can't be edited yet.");
  if (CJK.test(line.text)) return no("Chinese, Japanese and Korean text can't be edited yet.");
  if (line.rtl || RTL.test(line.text)) return no("Right-to-left text can't be edited yet.");

  const glyphs = walk.glyphs.filter((g) => g.line === index);
  const inForm = () => walk.forms.some((f) => overlaps(f, line.bbox));
  if (glyphs.length === 0) {
    return no(
      inForm()
        ? "This text is part of a graphic placed on the page (a form XObject), which can't be edited yet."
        : "This text couldn't be matched to the page's drawing instructions, so it can't be edited.",
    );
  }
  // Every character must come from a glyph found here, except spaces MuPDF adds between words
  // and the extra letters of a ligature (which sit inside its glyph's width).
  for (const ch of line.chars) {
    if (/\s/.test(ch.c)) continue;
    const covered = glyphs.some((g) => {
      if (Math.hypot(g.x - ch.x, g.y - ch.y) <= MATCH_TOLERANCE) return true;
      const minX = Math.min(g.x, g.ex) - MATCH_TOLERANCE;
      const maxX = Math.max(g.x, g.ex) + MATCH_TOLERANCE;
      const minY = Math.min(g.y, g.ey) - MATCH_TOLERANCE;
      const maxY = Math.max(g.y, g.ey) + MATCH_TOLERANCE;
      return ch.x >= minX && ch.x <= maxX && ch.y >= minY && ch.y <= maxY;
    });
    if (!covered) {
      return no(
        inForm()
          ? "Part of this line is in a graphic placed on the page (a form XObject), which can't be edited yet."
          : "Part of this line couldn't be matched to the page's drawing instructions, so it can't be edited.",
      );
    }
  }
  const ops: ShowOp[] = [];
  for (const g of glyphs) if (!ops.includes(g.op)) ops.push(g.op);
  ops.sort((a, b) => a.stream - b.stream || a.start - b.start);
  let rotation: number | null = null;
  for (const op of ops) {
    if (!rangeIn(op, index, line)) {
      return no(
        "This line is drawn mixed in with other text, so it can't be edited on its own yet.",
      );
    }
    if (!op.known || !op.trm || !op.font || op.font.problem) {
      return no(
        op.font?.problem ??
          "This text's position or font couldn't be worked out, so it can't be edited.",
      );
    }
    if (op.tr === 3) {
      return no(
        "This text is invisible (often the searchable text of a scan), so editing it wouldn't change what you see.",
      );
    }
    if (op.tr > 3) return no("This text is used as a clipping shape, which can't be edited.");
    const r = readingRotation(op.trm);
    if (r === null)
      return no("This text is slanted, stretched or mirrored, which can't be edited yet.");
    if (rotation !== null && r !== rotation)
      return no("This line turns part way along, which can't be edited.");
    rotation = r;
    if (op.textClip || (op.clip && !contains(op.clip, line.bbox, 1))) {
      return no("Part of this text is hidden (clipped), so it can't be edited safely.");
    }
  }
  return { reason: null, ops };
}

function describeLine(
  line: PageLine,
  id: number,
  bounds: Rect4,
  reason: string | null,
  ops: ShowOp[],
): TextLineInfo {
  const [x0, y0] = bounds;
  const first = ops[0];
  const rotation = (first?.trm ? readingRotation(first.trm) : 0) ?? 0;
  const font = first?.font;
  const style = font ? mergeStyle(font.style, line.style) : line.style;
  return {
    id,
    text: line.text,
    rect: [line.bbox[0] - x0, line.bbox[1] - y0, line.bbox[2] - x0, line.bbox[3] - y0],
    rotation,
    size: line.size,
    font: readableFontName(font?.baseFont || line.fontName),
    bold: style.bold,
    italic: style.italic,
    serif: style.serif,
    mono: style.mono,
    color: line.color,
    editable: reason === null,
    reason,
  };
}

function mergeStyle(a: FontStyle, b: FontStyle): FontStyle {
  // MuPDF's flags for an embedded font aren't always right (it may call a sans font serif),
  // so the font's own description and name come first; MuPDF only adds bold and italic.
  return { serif: a.serif, mono: a.mono, bold: a.bold || b.bold, italic: a.italic || b.italic };
}

// ---------------------------------------------------------------------------------------------
// Planning an edit

/**
 * The new text as codes: a run of codes in one font (0 is the line's own font, 1 the standard
 * font standing in for it), or a gap where a space goes.
 */
type Piece = { font: number; codes: number[] } | { gap: number };

interface Encoded {
  pieces: Piece[];
  /** Width along the line in text space, at the op's size and spacing. */
  advance: number;
  /** Characters none of the fonts has. */
  missing: string[];
  /** Whether any of it is in the line's own font. */
  usesOwn: boolean;
}

export interface EditPlan {
  check: TextEditCheck;
  /** Byte-range replacements per stream index. */
  edits: Map<number, { start: number; end: number; text: string }[]>;
  /** A standard font to add to the page's resources, under this name. */
  addFont: { name: string; font: StandardFont } | null;
}

/** Check new text for a line: one line, no control characters, not too long. */
export function checkNewText(text: string): string {
  if (typeof text !== "string") throw new Error("The new text must be text");
  if (/[\r\n\u2028\u2029]/.test(text))
    throw new Error("Type one line only. Splitting a line isn't supported yet.");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
  if (/[\u0000-\u001f\u007f]/.test(text))
    throw new Error("The new text has a character that can't be written.");
  if ([...text].length > MAX_LINE_TEXT)
    throw new Error(`The new text is too long (${MAX_LINE_TEXT} characters at most).`);
  if (CJK.test(text)) throw new Error("Chinese, Japanese and Korean text can't be written yet.");
  if (RTL.test(text)) throw new Error("Right-to-left text can't be written yet.");
  return text;
}

/**
 * Work out an edit of a line: which font, whether it fits, and the replacement for each
 * operator. Throws (in plain words) when it can't be done.
 */
export function planLineEdit(analysis: PageAnalysis, id: number, newText: string): EditPlan {
  const text = checkNewText(newText);
  const info = analysis.infos[id];
  const ops = analysis.lineOps.get(id);
  if (!info || !ops || ops.length === 0)
    throw new Error(info?.reason ?? "That line isn't on the page");
  const line = analysis.lines[id] as PageLine;
  const firstGlyph = firstGlyphOf(line, ops, id);
  const first = firstGlyph.op;
  const font = first.font as FontInfo;
  const trm = first.trm as Matrix6;
  const rotation = readingRotation(trm) ?? 0;

  const ranges = new Map<ShowOp, [number, number]>();
  for (const op of ops) {
    const range = rangeIn(op, id, line);
    if (!range) {
      throw new Error(
        "This line is drawn mixed in with other text, so it can't be edited on its own yet.",
      );
    }
    ranges.set(op, range);
  }
  // Where the new text starts: the first of the line's glyphs in the first op.
  const startItem = first.items[(ranges.get(first) as [number, number])[0]] as Item & {
    glyph: Glyph;
  };

  // In the line's own font if it has every character. If not, in a standard font that looks
  // like it: all of the line if the standard font has every character, else only the
  // characters the line's font lacks.
  const spaceGap = estimateSpace(line, ops, id);
  const own = encode(text, [[0, font]], first, spaceGap, font.twoByte);
  let encoded = own;
  let fallback: StandardFont | null = null;
  if (own.missing.length > 0) {
    fallback = pickStandardFont(font, line, ops, id);
    const standard = standardFontInfo(fallback);
    encoded = encode(text, [[1, standard]], first, spaceGap, font.twoByte);
    if (encoded.missing.length > 0)
      encoded = encode(
        text,
        [
          [0, font],
          [1, standard],
        ],
        first,
        spaceGap,
        font.twoByte,
      );
    if (encoded.missing.length > 0) {
      throw new Error(
        `${quoteList(encoded.missing)} can't be written in this line: neither its font nor the standard fonts have ${
          encoded.missing.length === 1 ? "it" : "them"
        }.`,
      );
    }
  }

  // Width and room, along the line in page space.
  const unit = Math.hypot(trm[0], trm[1]) / (first.fs * first.th);
  const width = Math.abs(encoded.advance * unit);
  const start = toFrame(rotation, startItem.glyph.x, startItem.glyph.y)[0];
  const lineBox = rectToFrame(rotation, line.bbox);
  let limit = rectToFrame(rotation, analysis.bounds)[2];
  for (let i = 0; i < analysis.lines.length; i++) {
    if (i === id) continue;
    const other = rectToFrame(rotation, (analysis.lines[i] as PageLine).bbox);
    const overlap = Math.min(other[3], lineBox[3]) - Math.max(other[1], lineBox[1]);
    const smaller = Math.min(other[3] - other[1], lineBox[3] - lineBox[1]);
    if (overlap > smaller / 2 && other[0] >= lineBox[2] - 1) limit = Math.min(limit, other[0]);
  }
  const room = Math.max(0, limit - start - 1);
  const oldWidth = lineBox[2] - start;
  const tooWide = width > room && width > oldWidth + 0.5;
  // Under a clipping shape that isn't an upright rectangle, only its bounding box is known, and
  // longer text could go where the shape hides it: refused.
  if (ops.some((op) => op.clipShaped) && width > oldWidth + 0.5) {
    throw new Error(
      "This line is inside a shaped area that hides what's outside it, so the new text can't be longer than the old.",
    );
  }
  // Past the edge of a clipping area, the end of the text would be cut off: refused.
  if (first.clip) {
    const edge = rectToFrame(rotation, first.clip)[2];
    if (start + width > edge + 0.5 && width > oldWidth + 0.5) {
      throw new Error(
        "The new text is too long for the space this line is in: its end would be hidden. Try something shorter.",
      );
    }
  }

  const keys = new Set(ops.map((op) => `${op.fontResource}@${op.fs}`));
  const check: TextEditCheck = {
    font: readableFontName(encoded.usesOwn || !fallback ? font.baseFont : fallback),
    fallback: fallback ? readableFontName(fallback) : null,
    missing: own.missing,
    tooWide,
    mixedFonts: keys.size > 1,
    width,
    room,
  };

  // The replacements.
  const edits = new Map<number, { start: number; end: number; text: string }[]>();
  const add = (place: Place, replacement: string) => {
    const list = edits.get(place.stream) ?? [];
    list.push({ start: place.start, end: place.end, text: replacement });
    edits.set(place.stream, list);
  };
  const fontName = fallback ? freeFontName(analysis, fallback) : null;
  for (const op of ops) {
    const [from, to] = ranges.get(op) as [number, number];
    // Before and after the line, the op's own glyphs and moves are kept as they were.
    const before = showItems(op.items.slice(0, from));
    const after = op.items.slice(to + 1);
    let drawn = 0;
    for (let i = from; i <= to; i++) drawn += (op.items[i] as Item).tx;
    const parts: string[] = [];
    const prefix = linePrefix(op);
    if (prefix) parts.push(prefix);
    if (before) parts.push(`[${before}] TJ`);
    let advance = 0;
    if (op === first) {
      parts.push(...drawRuns(encoded.pieces, op, font, fontName));
      advance = encoded.advance;
    }
    // A move the length of what's gone, so whatever comes next stays where it was.
    const n = (-(drawn - advance) * 1000) / (op.fs * op.th);
    const rest = [Math.abs(n) > 1e-4 ? formatNumber(n) : "", showItems(after)]
      .filter(Boolean)
      .join(" ");
    if (rest) parts.push(`[${rest}] TJ`);
    add(op, parts.join(" "));
  }
  // Marked content giving the old text as "actual text" would still read as the old words.
  const seen = new Set<Marked>();
  for (const op of ops) {
    for (const m of op.marked) {
      if (seen.has(m) || !m.actualText || !m.end) continue;
      seen.add(m);
      const whole = (o: ShowOp) => {
        const r = ranges.get(o);
        return r !== undefined && r[0] === 0 && r[1] === o.items.length - 1;
      };
      if (m.ops.every(whole)) {
        add(m.begin, "");
        add(m.end, "");
      }
    }
  }
  for (const list of edits.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if ((list[i] as { start: number }).start < (list[i - 1] as { end: number }).end) {
        throw new Error("This line's drawing instructions overlap, so it can't be edited safely.");
      }
    }
  }
  return {
    check,
    edits,
    addFont: fallback && fontName ? { name: fontName, font: fallback } : null,
  };
}

function firstGlyphOf(line: PageLine, ops: ShowOp[], id: number): Glyph {
  // The glyph drawing the line's first character; the new text starts where its op starts.
  const all = ops.flatMap((op) => op.glyphs.filter((g) => g.line === id));
  for (const ch of line.chars) {
    if (/\s/.test(ch.c)) continue;
    const g = all.find((g) => Math.hypot(g.x - ch.x, g.y - ch.y) <= MATCH_TOLERANCE);
    if (g) return g;
  }
  return all[0] as Glyph;
}

/** Operators that an op does before drawing (a line move for ' and "), kept as they were. */
function linePrefix(op: ShowOp): string {
  if (op.op === "'") return "T* ";
  if (op.op === '"') {
    const [aw, ac] = op.operands as [Operand, Operand];
    return `${formatNumber(num(aw))} Tw ${formatNumber(num(ac))} Tc T* `;
  }
  return "";
}

/** Items of a text-showing operator, as the inside of a TJ array. */
function showItems(items: Item[]): string {
  const parts: string[] = [];
  let run: number[] = [];
  for (const item of items) {
    if ("glyph" in item) {
      run.push(...item.bytes);
      continue;
    }
    if (run.length > 0) parts.push(hexString(run));
    run = [];
    parts.push(formatNumber(item.value));
  }
  if (run.length > 0) parts.push(hexString(run));
  return parts.join(" ");
}

function showPieces(pieces: Piece[], twoByte: boolean): string {
  const parts: string[] = [];
  for (const p of pieces) {
    if ("gap" in p) {
      parts.push(formatNumber(-p.gap));
      continue;
    }
    const bytes: number[] = [];
    for (const code of p.codes) {
      if (twoByte) bytes.push(code >> 8, code & 0xff);
      else bytes.push(code);
    }
    parts.push(hexString(bytes));
  }
  return parts.join(" ");
}

/**
 * The new text in fonts: each character in the first font that has it. A space no font can
 * draw (common in TeX fonts, which leave gaps instead) becomes a gap of `spaceGap` thousandths
 * of the font size. Fonts come with their number in Piece (0 own, 1 standard).
 *
 * Word spacing (Tw) applies to one-byte spaces. The standard font keeps the line's word
 * spacing when the line's own font showed it (a simple font); when the line's font is a
 * two-byte one, where Tw never applied, it's turned off for the standard font (drawRuns).
 */
function encode(
  text: string,
  fonts: [number, FontInfo][],
  op: Pick<ShowOp, "fs" | "tc" | "tw" | "th">,
  spaceGap: number,
  ownTwoByte: boolean,
): Encoded {
  const pieces: Piece[] = [];
  const missing: string[] = [];
  let advance = 0;
  let usesOwn = false;
  for (const ch of text) {
    const normal = ch === "\u00a0" ? " " : ch;
    let font = -1;
    let info: FontInfo | null = null;
    let code: number | null = null;
    for (const [id, f] of fonts) {
      code = f.encode(normal);
      if (code !== null) {
        font = id;
        info = f;
        break;
      }
    }
    if (code === null || !info) {
      if (normal === " ") {
        pieces.push({ gap: spaceGap });
        advance += (spaceGap / 1000) * op.fs * op.th;
      } else if (!missing.includes(ch)) {
        missing.push(ch);
      }
      continue;
    }
    if (font === 0) usesOwn = true;
    const last = pieces[pieces.length - 1];
    if (last && "codes" in last && last.font === font) last.codes.push(code);
    else pieces.push({ font, codes: [code] });
    // Word spacing: only for a one-byte space, and not while a standard font stands in.
    const tw = !info.twoByte && code === 32 && !(font === 1 && ownTwoByte) ? op.tw : 0;
    advance += ((info.width(code) / 1000) * op.fs + op.tc + tw) * op.th;
  }
  return { pieces, advance, missing, usesOwn };
}

/**
 * The operators that draw encoded text: TJ arrays, switching to the standard font (and back)
 * where it's used. Word spacing is turned off while the standard font is in use.
 */
function drawRuns(
  pieces: Piece[],
  op: ShowOp,
  own: FontInfo,
  standardName: string | null,
): string[] {
  const parts: string[] = [];
  let current = 0;
  let run: Piece[] = [];
  const size = formatNumber(op.fs);
  const flush = () => {
    if (run.length > 0) parts.push(`[${showPieces(run, current === 0 && own.twoByte)}] TJ`);
    run = [];
  };
  // Word spacing never applied to the two-byte font's spaces, so it's off for the standard one.
  const resetTw = own.twoByte && op.tw !== 0;
  const switchTo = (font: number) => {
    flush();
    if (font === current || !standardName) return;
    if (font === 1) {
      if (resetTw) parts.push("0 Tw");
      parts.push(`${formatName(standardName)} ${size} Tf`);
    } else {
      parts.push(`${formatName(op.fontResource as string)} ${size} Tf`);
      if (resetTw) parts.push(`${formatNumber(op.tw)} Tw`);
    }
    current = font;
  };
  for (const piece of pieces) {
    if ("codes" in piece && piece.font !== current) switchTo(piece.font);
    run.push(piece);
  }
  switchTo(0);
  flush();
  return parts;
}

/** A space's width on this line in thousandths of the font size, from the gaps between words. */
function estimateSpace(line: PageLine, ops: ShowOp[], id: number): number {
  const op = ops[0] as ShowOp;
  const unit = Math.hypot((op.trm as Matrix6)[0], (op.trm as Matrix6)[1]);
  const space = op.font?.encode(" ");
  if (space !== null && space !== undefined && op.font) return op.font.width(space);
  const glyphs = ops.flatMap((o) => o.glyphs.filter((g) => g.line === id));
  const gaps: number[] = [];
  for (let i = 0; i + 1 < line.chars.length; i++) {
    const ch = line.chars[i] as PageChar;
    if (ch.c !== " ") continue;
    const before = glyphs.find((g) => Math.hypot(g.ex - ch.x, g.ey - ch.y) <= 0.5);
    const next = line.chars[i + 1] as PageChar;
    if (!before) continue;
    const gap = Math.hypot(next.x - before.ex, next.y - before.ey);
    if (gap > 0 && unit > 0) gaps.push((gap / unit) * 1000);
  }
  if (gaps.length === 0) return 300;
  gaps.sort((a, b) => a - b);
  return Math.min(Math.max(gaps[Math.floor(gaps.length / 2)] as number, 150), 600);
}

/**
 * The standard font closest to a line's font: the same weight and slant, and of Helvetica,
 * Times and Courier the family that matches its style and comes closest to its widths.
 */
function pickStandardFont(font: FontInfo, line: PageLine, ops: ShowOp[], id: number): StandardFont {
  const style = mergeStyle(font.style, line.style);
  const glyphs = ops.flatMap((o) => o.glyphs.filter((g) => g.line === id));
  const original = glyphs.reduce((sum, g) => sum + (g.op.font?.width(g.code) ?? 0), 0);
  const text = glyphs.map((g) => g.text).join("");
  let best: StandardFont = standardFontFor("Helvetica", style);
  let bestScore = Number.POSITIVE_INFINITY;
  for (const family of ["Helvetica", "Times", "Courier"] as const) {
    const name = standardFontFor(family, style);
    const info = standardFontInfo(name);
    let width = 0;
    for (const ch of text) {
      const code = info.encode(ch);
      width += code === null ? 500 : info.width(code);
    }
    const ratio = original > 0 && width > 0 ? Math.abs(Math.log(width / original)) : 0;
    const wanted = style.mono ? "Courier" : style.serif ? "Times" : "Helvetica";
    const score = ratio + (family === wanted ? 0 : 0.35);
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

/** A resource name for a standard font: ours if the page has it already, else one not in use. */
function freeFontName(analysis: PageAnalysis, font: StandardFont): string {
  const base = `PdfoStd${font.replace(/[^A-Za-z]/g, "")}`;
  let name = base;
  for (let i = 2; analysis.fontNames.has(name) && analysis.fontNames.get(name) !== font; i++) {
    name = `${base}${i}`;
  }
  return name;
}

function quoteList(chars: string[]): string {
  const q = chars.map((c) => `“${c}”`);
  if (q.length === 1) return q[0] as string;
  return `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// Making the edit

export interface MadeEdit {
  contents: mupdf.PDFObject;
  resources: mupdf.PDFObject | null;
  /** Objects created, to delete if the edit is dropped. */
  created: mupdf.PDFObject[];
}

/** Create the new content streams (and font) for a plan. Nothing on the page changes yet. */
export function makeEdit(
  pdf: mupdf.PDFDocument,
  index: number,
  analysis: PageAnalysis,
  plan: EditPlan,
): MadeEdit {
  const pageObj = pdf.findPage(index);
  const created: mupdf.PDFObject[] = [];
  const replaced = new Map<number, mupdf.PDFObject>();
  for (const [s, list] of plan.edits) {
    const original = (analysis.streams[s] as { bytes: Uint8Array }).bytes;
    const bytes = splice(original, list);
    const stream = pdf.addStream(bytes, pdf.newDictionary());
    created.push(stream);
    replaced.set(s, stream);
  }
  const old = pageObj.get("Contents");
  let contents: mupdf.PDFObject;
  if (old.isArray()) {
    contents = pdf.newArray();
    for (let i = 0; i < old.length; i++) contents.push(replaced.get(i) ?? old.get(i));
  } else {
    contents = replaced.get(0) ?? old;
  }
  let resources: mupdf.PDFObject | null = null;
  if (plan.addFont) {
    const current = pageObj.getInheritable("Resources");
    resources = current.isDictionary() ? copyContainer(pdf, current) : pdf.newDictionary();
    const fonts = resources.get("Font");
    const fontDict = fonts.isDictionary() ? copyContainer(pdf, fonts) : pdf.newDictionary();
    const existing = fontDict.get(plan.addFont.name);
    const base = existing.isDictionary() ? existing.get("BaseFont") : null;
    if (!(base?.isName() && base.asName() === plan.addFont.font)) {
      const font = standardFontObject(pdf, plan.addFont.font);
      created.push(font);
      fontDict.put(plan.addFont.name, font);
    }
    resources.put("Font", fontDict);
  }
  return { contents, resources, created };
}

/** Apply byte-range replacements (sorted, not overlapping) to a stream's bytes. */
export function splice(
  bytes: Uint8Array,
  edits: readonly { start: number; end: number; text: string }[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  const regular = (c: number | undefined) =>
    c !== undefined &&
    !(c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32) &&
    !"()<>[]{}/%".includes(String.fromCharCode(c));
  for (const e of edits) {
    parts.push(bytes.subarray(at, e.start));
    let text = e.text;
    // Keep tokens apart from whatever is next to them.
    if (text && regular(bytes[e.start - 1]) && regular(text.charCodeAt(0))) text = ` ${text}`;
    if (text && regular(bytes[e.end]) && regular(text.charCodeAt(text.length - 1)))
      text = `${text} `;
    parts.push(latin1Bytes(text));
    at = e.end;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * After an edit: every other line must still be there, where it was (it may have joined the
 * edited line), and the new text must be on the page.
 */
export function editLooksRight(
  before: PageAnalysis,
  id: number,
  after: PageLine[],
  newText: string,
): boolean {
  const squash = (s: string) => s.replace(/\s+/g, "");
  for (let i = 0; i < before.raw.length; i++) {
    if (before.groupOf[i] === id) continue;
    const old = before.raw[i] as PageLine;
    const want = squash(old.text);
    if (!want) continue;
    const found = after.some(
      (l) => squash(l.text).includes(want) && contains(l.bbox, old.bbox, 0.6),
    );
    if (!found) return false;
  }
  const wanted = squash(newText);
  return !wanted || after.some((l) => squash(l.text).includes(wanted));
}
