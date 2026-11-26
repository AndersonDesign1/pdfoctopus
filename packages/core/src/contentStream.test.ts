// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The content stream parser: tokens, strings, arrays, inline images, byte ranges and limits.

import { describe, expect, it } from "vitest";
import {
  ContentStreamError,
  DEFAULT_LIMITS,
  formatName,
  formatNumber,
  hexString,
  type Operand,
  parseContent,
  parseContentStreams,
} from "./contentStream";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (o: Operand | undefined) => {
  if (o?.kind !== "string") throw new Error(`Not a string: ${JSON.stringify(o)}`);
  return String.fromCharCode(...o.bytes);
};

describe("parseContent", () => {
  it("reads operators with their operands and exact byte ranges", () => {
    const src = "q 1 0 0 1 72 -3.5 cm\nBT /F1 12 Tf (Hi) Tj ET Q";
    const ops = parseContent(bytes(src));
    expect(ops.map((o) => o.op)).toEqual(["q", "cm", "BT", "Tf", "Tj", "ET", "Q"]);
    const cm = ops[1];
    expect(cm?.operands).toEqual(
      [1, 0, 0, 1, 72, -3.5].map((value) => ({ kind: "number", value })),
    );
    for (const op of ops) {
      // Each range is the operands and the operator, nothing else.
      expect(src.slice(op.start, op.end).endsWith(op.op)).toBe(true);
    }
    expect(src.slice(ops[3]?.start, ops[3]?.end)).toBe("/F1 12 Tf");
    expect(src.slice(ops[4]?.start, ops[4]?.end)).toBe("(Hi) Tj");
  });

  it("reads numbers in all their forms", () => {
    const [op] = parseContent(bytes("+1 -2 .5 -.25 3. 0.0 007 x"));
    expect(op?.operands.map((o) => (o.kind === "number" ? o.value : null))).toEqual([
      1, -2, 0.5, -0.25, 3, 0, 7,
    ]);
  });

  it("reads literal strings with escapes, nested brackets and line continuations", () => {
    const src =
      "(a\\(b\\)c) Tj (x(y(z))w) Tj (\\n\\r\\t\\b\\f\\\\) Tj (\\101\\60\\0618) Tj (ab\\\ncd) Tj (\\q) Tj";
    const ops = parseContent(bytes(src));
    expect(ops.map((o) => text(o.operands[0]))).toEqual([
      "a(b)c",
      "x(y(z))w",
      "\n\r\t\b\f\\",
      "A0" + "18",
      "abcd",
      "q",
    ]);
  });

  it("reads an end of line inside a string as a line feed", () => {
    const [crlf, cr] = parseContent(bytes("(a\r\nb) Tj (c\rd) Tj"));
    expect(text(crlf?.operands[0])).toBe("a\nb");
    expect(text(cr?.operands[0])).toBe("c\nd");
  });

  it("reads hex strings, ignoring whitespace and padding an odd digit", () => {
    const [a, b, c] = parseContent(bytes("<00 41\n4a> Tj <7> Tj <> Tj"));
    expect(a?.operands[0]).toEqual({
      kind: "string",
      bytes: Uint8Array.of(0, 0x41, 0x4a),
      hex: true,
    });
    expect(b?.operands[0]).toEqual({ kind: "string", bytes: Uint8Array.of(0x70), hex: true });
    expect(c?.operands[0]).toEqual({ kind: "string", bytes: new Uint8Array(0), hex: true });
  });

  it("reads TJ arrays of strings and numbers", () => {
    const src = "[(A) -120 <0042> 33.5 (C)] TJ";
    const [op] = parseContent(bytes(src));
    expect(op?.op).toBe("TJ");
    expect(op?.start).toBe(0);
    const arr = op?.operands[0];
    expect(arr?.kind).toBe("array");
    if (arr?.kind !== "array") return;
    expect(arr.items.map((i) => (i.kind === "number" ? i.value : text(i)))).toEqual([
      "A",
      -120,
      "\u0000B",
      33.5,
      "C",
    ]);
  });

  it("reads names with # escapes, dictionaries, booleans and null", () => {
    const [op] = parseContent(
      bytes("/Span <</ActualText (fi) /Lang/en#2DGB /On true /X null>> BDC"),
    );
    expect(op?.operands[0]).toEqual({ kind: "name", value: "Span" });
    const dict = op?.operands[1];
    expect(dict?.kind).toBe("dict");
    if (dict?.kind !== "dict") return;
    expect(text(dict.entries.get("ActualText"))).toBe("fi");
    expect(dict.entries.get("Lang")).toEqual({ kind: "name", value: "en-GB" });
    expect(dict.entries.get("On")).toEqual({ kind: "bool", value: true });
    expect(dict.entries.get("X")).toEqual({ kind: "null" });
  });

  it("skips comments, but not % inside strings", () => {
    const ops = parseContent(bytes("% a comment (not a string\n(100%) Tj % another\r1 w"));
    expect(ops.map((o) => o.op)).toEqual(["Tj", "w"]);
    expect(text(ops[0]?.operands[0])).toBe("100%");
  });

  it("skips an inline image's binary data, even when it holds EI by chance", () => {
    const data = "\x00\xffEI\x01 EIx \x7f\x80";
    const src = `q BI /W 4 /H 4 /BPC 8 /CS /G /F [/AHx] ID ${data} EI Q BT (after) Tj ET`;
    const ops = parseContent(bytes(src));
    expect(ops.map((o) => o.op)).toEqual(["q", "BI", "Q", "BT", "Tj", "ET"]);
    const image = ops[1];
    expect(src.slice(image?.start, image?.end).startsWith("BI")).toBe(true);
    expect(src.slice(image?.start, image?.end).endsWith(" EI")).toBe(true);
    expect(text(ops[4]?.operands[0])).toBe("after");
  });

  it("finds an inline image's end at the end of the stream", () => {
    const ops = parseContent(bytes("BI /W 1 /H 1 ID \x01\x02 EI"));
    expect(ops.map((o) => o.op)).toEqual(["BI"]);
  });

  it("refuses broken content instead of guessing", () => {
    for (const bad of [
      "(never closed Tj",
      "<41 Tj",
      "<4G> Tj",
      "[(a) Tj",
      "(a)] Tj",
      "<< /A 1 Tj",
      "<< /A >> BDC",
      "1 2",
      "{ 1 } Tj",
      "BI /W 1 ID data with no end",
      ") Tj",
    ]) {
      expect(() => parseContent(bytes(bad)), bad).toThrow(ContentStreamError);
    }
  });

  it("stops at its limits", () => {
    const deep = `${"[".repeat(40)}${"]".repeat(40)} TJ`;
    expect(() => parseContent(bytes(deep))).toThrow(/nested too deeply/);
    const many = "q Q ".repeat(50);
    expect(() => parseContent(bytes(many), { ...DEFAULT_LIMITS, maxOperations: 99 })).toThrow(
      /too complex/,
    );
    expect(() => parseContent(bytes("q"), { ...DEFAULT_LIMITS, maxBytes: 0 })).toThrow(/too large/);
  });

  it("parses a large stream quickly", () => {
    const line = "BT /F1 10 Tf 1 0 0 1 72 700 Tm [(Hello) -250 (world)] TJ ET\n";
    const big = bytes(line.repeat(20_000));
    const start = performance.now();
    expect(parseContent(big)).toHaveLength(100_000);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe("parseContentStreams", () => {
  it("joins operands at the end of one stream to the operator in the next", () => {
    const parsed = parseContentStreams([bytes("q 1 0 0"), bytes("1 0 0 cm (x) Tj"), bytes("Q")]);
    expect(parsed.map((p) => [p.operation.op, p.stream, p.operation.split ?? false])).toEqual([
      ["q", 0, false],
      ["cm", 1, true],
      ["Tj", 1, false],
      ["Q", 2, false],
    ]);
    expect(parsed[1]?.operation.operands).toHaveLength(6);
  });

  it("refuses operands left over at the very end", () => {
    expect(() => parseContentStreams([bytes("q"), bytes("1 2")])).toThrow(ContentStreamError);
  });
});

describe("writing", () => {
  it("formats numbers without exponents or trailing zeros", () => {
    expect(formatNumber(12)).toBe("12");
    expect(formatNumber(-0.5)).toBe("-0.5");
    expect(formatNumber(1 / 3)).toBe("0.33333");
    expect(formatNumber(1e-9)).toBe("0");
    expect(formatNumber(-1e-9)).toBe("0");
    expect(formatNumber(123456.789)).toBe("123456.789");
    expect(() => formatNumber(Number.NaN)).toThrow();
  });

  it("writes hex strings and names that read back the same", () => {
    expect(hexString([0, 0x41, 255])).toBe("<0041FF>");
    expect(formatName("F1")).toBe("/F1");
    expect(formatName("A B#(")).toBe("/A#20B#23#28");
    const [op] = parseContent(bytes(`${formatName("A B#(")} ${hexString([0, 0x41])} Tf`));
    expect(op?.operands[0]).toEqual({ kind: "name", value: "A B#(" });
    expect(text(op?.operands[1])).toBe("\u0000A");
  });
});
