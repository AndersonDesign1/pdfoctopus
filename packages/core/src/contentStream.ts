// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A tokenizer and parser for PDF content streams (the drawing instructions of a page), used to
// find and rewrite the operators that draw a line of text. It knows nothing about MuPDF.
//
// Every operator comes back with its operands and its exact byte range, so an edit can replace
// one operator and leave every other byte of the stream as it was. Parsing is bounded (stream
// size, operator count, nesting) and throws ContentStreamError on anything it can't read, so a
// hostile file is refused rather than misread.

/** An operand: the PDF objects a content stream can hold. */
export type Operand =
  | { kind: "number"; value: number }
  | { kind: "string"; bytes: Uint8Array; hex: boolean }
  | { kind: "name"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "array"; items: Operand[] }
  | { kind: "dict"; entries: Map<string, Operand> };

export interface Operation {
  /** The operator, e.g. "Tj". An inline image is one operation, "BI", through its "EI". */
  op: string;
  operands: Operand[];
  /** Byte offset of the first operand (or of the operator when it has none). */
  start: number;
  /** Byte offset just after the operator. */
  end: number;
  /** Some of its operands were at the end of the previous stream (`start` is then 0). */
  split?: boolean;
}

export interface ParseLimits {
  /** Largest stream, in bytes. */
  maxBytes: number;
  /** Most operators. */
  maxOperations: number;
  /** Deepest nesting of arrays and dictionaries. */
  maxDepth: number;
  /** Most objects (operands and the items inside them) in one stream. */
  maxObjects: number;
}

export const DEFAULT_LIMITS: ParseLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxOperations: 1_000_000,
  maxDepth: 32,
  maxObjects: 4_000_000,
};

export class ContentStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentStreamError";
  }
}

const WHITESPACE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITESPACE[c] = 1;
const DELIMITER = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIMITER[c.charCodeAt(0)] = 1;

const isRegular = (c: number) => !WHITESPACE[c] && !DELIMITER[c];

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

type Token =
  | { type: "object"; value: Operand; start: number; end: number }
  | { type: "keyword"; value: string; start: number; end: number }
  | { type: "open-array" | "close-array" | "open-dict" | "close-dict"; start: number; end: number };

/** Reads tokens from a stream one at a time. */
export class Lexer {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  /** The next token, or null at the end. Comments and whitespace are skipped. */
  next(): Token | null {
    const b = this.bytes;
    const n = b.length;
    for (;;) {
      while (this.pos < n && WHITESPACE[b[this.pos] as number]) this.pos++;
      if (this.pos >= n) return null;
      if (b[this.pos] !== 37 /* % */) break;
      while (this.pos < n && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
    }
    const start = this.pos;
    const c = b[start] as number;
    switch (c) {
      case 40 /* ( */:
        return { type: "object", value: this.literalString(), start, end: this.pos };
      case 60 /* < */:
        if (b[start + 1] === 60) {
          this.pos += 2;
          return { type: "open-dict", start, end: this.pos };
        }
        return { type: "object", value: this.hexString(), start, end: this.pos };
      case 62 /* > */:
        if (b[start + 1] === 62) {
          this.pos += 2;
          return { type: "close-dict", start, end: this.pos };
        }
        throw new ContentStreamError(`Unexpected ">" at byte ${start}`);
      case 91 /* [ */:
        this.pos++;
        return { type: "open-array", start, end: this.pos };
      case 93 /* ] */:
        this.pos++;
        return { type: "close-array", start, end: this.pos };
      case 47 /* / */:
        return { type: "object", value: this.name(), start, end: this.pos };
      case 41 /* ) */:
      case 123 /* { */:
      case 125 /* } */:
        throw new ContentStreamError(`Unexpected "${String.fromCharCode(c)}" at byte ${start}`);
    }
    while (this.pos < n && isRegular(b[this.pos] as number)) this.pos++;
    const word = latin1(b, start, this.pos);
    const end = this.pos;
    if (NUMBER.test(word))
      return { type: "object", value: { kind: "number", value: Number(word) }, start, end };
    if (word === "true" || word === "false") {
      return { type: "object", value: { kind: "bool", value: word === "true" }, start, end };
    }
    if (word === "null") return { type: "object", value: { kind: "null" }, start, end };
    return { type: "keyword", value: word, start, end };
  }

  private literalString(): Operand {
    const b = this.bytes;
    const n = b.length;
    const out: number[] = [];
    let depth = 1;
    this.pos++; // (
    while (this.pos < n) {
      const c = b[this.pos++] as number;
      if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) return { kind: "string", bytes: Uint8Array.from(out), hex: false };
        out.push(c);
      } else if (c === 92 /* \ */) {
        if (this.pos >= n) break;
        const e = b[this.pos++] as number;
        switch (e) {
          case 110:
            out.push(10);
            break;
          case 114:
            out.push(13);
            break;
          case 116:
            out.push(9);
            break;
          case 98:
            out.push(8);
            break;
          case 102:
            out.push(12);
            break;
          case 13:
            // A line continuation: backslash and end of line add nothing.
            if (b[this.pos] === 10) this.pos++;
            break;
          case 10:
            break;
          default:
            if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let i = 0; i < 2 && this.pos < n; i++) {
                const d = b[this.pos] as number;
                if (d < 48 || d > 55) break;
                v = v * 8 + d - 48;
                this.pos++;
              }
              out.push(v & 0xff);
            } else {
              // \( \) \\ and any unknown escape: the character itself.
              out.push(e);
            }
        }
      } else if (c === 13) {
        // An end of line inside a string is read as a single line feed.
        if (b[this.pos] === 10) this.pos++;
        out.push(10);
      } else {
        out.push(c);
      }
    }
    throw new ContentStreamError("A string isn't closed");
  }

  private hexString(): Operand {
    const b = this.bytes;
    const n = b.length;
    const out: number[] = [];
    let high = -1;
    this.pos++; // <
    while (this.pos < n) {
      const c = b[this.pos++] as number;
      if (c === 62) {
        if (high >= 0) out.push(high << 4);
        return { kind: "string", bytes: Uint8Array.from(out), hex: true };
      }
      if (WHITESPACE[c]) continue;
      const v = hexValue(c);
      if (v < 0)
        throw new ContentStreamError(`Bad character in a hex string at byte ${this.pos - 1}`);
      if (high < 0) high = v;
      else {
        out.push((high << 4) | v);
        high = -1;
      }
    }
    throw new ContentStreamError("A hex string isn't closed");
  }

  private name(): Operand {
    const b = this.bytes;
    const n = b.length;
    this.pos++; // /
    const out: number[] = [];
    while (this.pos < n && isRegular(b[this.pos] as number)) {
      const c = b[this.pos++] as number;
      if (c === 35 /* # */ && this.pos + 1 < n) {
        const h = hexValue(b[this.pos] as number);
        const l = hexValue(b[this.pos + 1] as number);
        if (h >= 0 && l >= 0) {
          out.push((h << 4) | l);
          this.pos += 2;
          continue;
        }
      }
      out.push(c);
    }
    return { kind: "name", value: latin1(Uint8Array.from(out), 0, out.length) };
  }
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i] as number);
  return s;
}

/**
 * Parse a content stream into its operations. Throws ContentStreamError if the stream can't
 * be read or is past the limits. Operands left over at the end (with no operator) are an
 * error too: they would belong to an operator in the next stream, which isn't supported.
 */
export function parseContent(bytes: Uint8Array, limits: ParseLimits = DEFAULT_LIMITS): Operation[] {
  const { ops, trailing } = parseStream(bytes, limits, []);
  if (trailing.length > 0) {
    throw new ContentStreamError("Operands with no operator at the end of the content");
  }
  return ops;
}

/**
 * Parse a page's content streams, which together are one sequence of operators: an operator's
 * operands may be at the end of the stream before it. Each operation comes with the index of
 * the stream its operator is in.
 */
export function parseContentStreams(
  streams: readonly Uint8Array[],
  limits: ParseLimits = DEFAULT_LIMITS,
): { operation: Operation; stream: number }[] {
  const out: { operation: Operation; stream: number }[] = [];
  let carry: Operand[] = [];
  let total = 0;
  streams.forEach((bytes, stream) => {
    total += bytes.length;
    if (total > limits.maxBytes) throw new ContentStreamError("The page's content is too large");
    const { ops, trailing } = parseStream(bytes, limits, carry);
    for (const operation of ops) out.push({ operation, stream });
    if (out.length > limits.maxOperations) {
      throw new ContentStreamError("The page's content is too complex");
    }
    carry = trailing;
  });
  if (carry.length > 0) {
    throw new ContentStreamError("Operands with no operator at the end of the content");
  }
  return out;
}

function parseStream(
  bytes: Uint8Array,
  limits: ParseLimits,
  carry: Operand[],
): { ops: Operation[]; trailing: Operand[] } {
  if (bytes.length > limits.maxBytes)
    throw new ContentStreamError("The page's content is too large");
  const lexer = new Lexer(bytes);
  const ops: Operation[] = [];
  let operands: Operand[] = [...carry];
  let carried = carry.length > 0;
  let operandStart = carried ? 0 : -1;
  let objects = 0;

  // Containers being read: arrays and dictionaries, innermost last.
  type Frame = { kind: "array"; items: Operand[] } | { kind: "dict"; items: Operand[] };
  const stack: Frame[] = [];

  const push = (value: Operand, start: number) => {
    if (++objects > limits.maxObjects)
      throw new ContentStreamError("The page's content is too complex");
    const top = stack[stack.length - 1];
    if (top) top.items.push(value);
    else {
      if (operandStart < 0) operandStart = start;
      operands.push(value);
    }
  };

  for (;;) {
    const token = lexer.next();
    if (!token) break;
    switch (token.type) {
      case "object":
        push(token.value, token.start);
        break;
      case "open-array":
      case "open-dict":
        if (stack.length >= limits.maxDepth)
          throw new ContentStreamError("The page's content is nested too deeply");
        if (stack.length === 0 && operandStart < 0) operandStart = token.start;
        stack.push({ kind: token.type === "open-array" ? "array" : "dict", items: [] });
        break;
      case "close-array": {
        const frame = stack.pop();
        if (frame?.kind !== "array")
          throw new ContentStreamError(`Unexpected "]" at byte ${token.start}`);
        push({ kind: "array", items: frame.items }, token.start);
        break;
      }
      case "close-dict": {
        const frame = stack.pop();
        if (frame?.kind !== "dict")
          throw new ContentStreamError(`Unexpected ">>" at byte ${token.start}`);
        push(toDict(frame.items), token.start);
        break;
      }
      case "keyword": {
        if (stack.length > 0) {
          throw new ContentStreamError(`Operator "${token.value}" inside an array or dictionary`);
        }
        if (ops.length >= limits.maxOperations)
          throw new ContentStreamError("The page's content is too complex");
        const start = operandStart >= 0 ? operandStart : token.start;
        if (token.value === "BI") {
          if (operands.length > 0) throw new ContentStreamError("Operands before an inline image");
          const image = readInlineImage(lexer, limits);
          ops.push({ op: "BI", operands: [image], start: token.start, end: lexer.pos });
        } else {
          const operation: Operation = { op: token.value, operands, start, end: token.end };
          if (carried) operation.split = true;
          ops.push(operation);
        }
        operands = [];
        operandStart = -1;
        carried = false;
      }
    }
  }
  if (stack.length > 0) throw new ContentStreamError("An array or dictionary isn't closed");
  return { ops, trailing: operands };
}

function toDict(items: Operand[]): Operand {
  if (items.length % 2 !== 0) throw new ContentStreamError("A dictionary has a key with no value");
  const entries = new Map<string, Operand>();
  for (let i = 0; i < items.length; i += 2) {
    const key = items[i] as Operand;
    if (key.kind !== "name") throw new ContentStreamError("A dictionary key isn't a name");
    entries.set(key.value, items[i + 1] as Operand);
  }
  return { kind: "dict", entries };
}

/**
 * Read an inline image after "BI": its dictionary up to "ID", then skip its data up to "EI".
 * The data has no length, so the end is the first "EI" that has whitespace before it and
 * whitespace (or the end) after it, and is followed by readable text: binary image data can
 * contain "EI" by chance, but it's very unlikely to be followed by more than a few
 * printable characters.
 */
function readInlineImage(lexer: Lexer, limits: ParseLimits): Operand {
  const items: Operand[] = [];
  for (;;) {
    const token = lexer.next();
    if (!token) throw new ContentStreamError("An inline image isn't finished");
    if (token.type === "keyword" && token.value === "ID") break;
    if (token.type === "object") {
      items.push(token.value);
    } else if (token.type === "open-array") {
      items.push(readArray(lexer, limits, 1));
    } else {
      throw new ContentStreamError("An inline image's dictionary can't be read");
    }
    if (items.length > 200)
      throw new ContentStreamError("An inline image's dictionary is too long");
  }
  const dict = toDict(items);
  const b = lexer.bytes;
  const n = b.length;
  // One whitespace byte follows ID (CR LF counts as one in practice too).
  let pos = lexer.pos;
  if (b[pos] === 13 && b[pos + 1] === 10) pos += 2;
  else if (WHITESPACE[b[pos] as number]) pos++;
  for (let i = pos; i + 1 < n; i++) {
    if (b[i] !== 69 || b[i + 1] !== 73) continue; // "EI"
    const before = i === pos || WHITESPACE[b[i - 1] as number];
    const after = i + 2 >= n || WHITESPACE[b[i + 2] as number];
    if (!before || !after || !looksLikeContent(b, i + 2)) continue;
    lexer.pos = i + 2;
    return dict;
  }
  throw new ContentStreamError("An inline image's end (EI) can't be found");
}

function readArray(lexer: Lexer, limits: ParseLimits, depth: number): Operand {
  if (depth > limits.maxDepth)
    throw new ContentStreamError("The page's content is nested too deeply");
  const items: Operand[] = [];
  for (;;) {
    const token = lexer.next();
    if (!token) throw new ContentStreamError("An array isn't closed");
    if (token.type === "close-array") return { kind: "array", items };
    if (token.type === "object") items.push(token.value);
    else if (token.type === "open-array") items.push(readArray(lexer, limits, depth + 1));
    else throw new ContentStreamError("An array can't be read");
    if (items.length > 10_000) throw new ContentStreamError("An array is too long");
  }
}

/** Whether the bytes after a possible "EI" read as content stream text (or nothing). */
function looksLikeContent(b: Uint8Array, from: number): boolean {
  const end = Math.min(b.length, from + 32);
  for (let i = from; i < end; i++) {
    const c = b[i] as number;
    if (WHITESPACE[c]) continue;
    if (c < 32 || c > 126) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Writing

/** A number as short PDF text: no exponent, at most 5 decimals, no trailing zeros. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error("Not a finite number");
  const rounded = Math.round(v * 100000) / 100000;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  let s = rounded.toFixed(5);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Bytes as a PDF hex string, e.g. <0041>. */
export function hexString(bytes: Uint8Array | readonly number[]): string {
  let s = "<";
  for (const v of bytes) s += (v & 0xff).toString(16).padStart(2, "0").toUpperCase();
  return `${s}>`;
}

/** A name with anything unusual escaped as #xx. */
export function formatName(name: string): string {
  let s = "/";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c > 32 && c < 127 && isRegular(c) && ch !== "#") s += ch;
    else s += `#${(c & 0xff).toString(16).padStart(2, "0")}`;
  }
  return s;
}
