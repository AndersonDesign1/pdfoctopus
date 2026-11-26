// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  glyphNameToUnicode,
  macRomanTable,
  parseToUnicode,
  simpleEncoding,
  standardTable,
  winAnsiTable,
} from "./fontEncoding";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("simple font encodings", () => {
  it("reads the base encodings", () => {
    expect(winAnsiTable()[0x80]).toBe("€");
    expect(winAnsiTable()[0xe9]).toBe("é");
    expect(winAnsiTable()[0x81]).toBe("");
    expect(macRomanTable()[0x8e]).toBe("é");
    expect(standardTable()[0x27]).toBe("’");
    expect(standardTable()[0xae]).toBe("ﬁ");
    expect(standardTable()[0xe9]).toBe("Ø");
  });

  it("reads glyph names", () => {
    expect(glyphNameToUnicode("eacute")).toBe("é");
    expect(glyphNameToUnicode("quoteright")).toBe("’");
    expect(glyphNameToUnicode("uni20AC")).toBe("€");
    expect(glyphNameToUnicode("u1F600")).toBe("😀");
    expect(glyphNameToUnicode("zero")).toBe("0");
    expect(glyphNameToUnicode("a.sc")).toBe("");
  });

  it("applies /Differences over a base encoding", () => {
    const { table, fromDifferences } = simpleEncoding(winAnsiTable(), [
      65,
      "Alpha",
      "B",
      200,
      "eacute",
    ]);
    expect(table[65]).toBe("");
    expect(table[66]).toBe("B");
    expect(table[200]).toBe("é");
    expect(table[67]).toBe("C");
    expect([...fromDifferences].sort()).toEqual([200, 65, 66].sort());
  });
});

describe("ToUnicode CMaps", () => {
  const cmap = bytes(`/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <0020>
<0011> <002E>
<13B2> <00660069>
endbfchar
2 beginbfrange
<0024> <003D> <0041>
<0044> <0046> [<0061> <0062> <00E9>]
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`);

  it("maps codes to text, both ways", () => {
    const map = parseToUnicode(cmap);
    expect(map).not.toBeNull();
    if (!map) return;
    expect(map.lookup(0x03, 2)).toBe(" ");
    expect(map.lookup(0x13b2, 2)).toBe("fi");
    expect(map.lookup(0x24, 2)).toBe("A");
    expect(map.lookup(0x3d, 2)).toBe("Z");
    expect(map.lookup(0x46, 2)).toBe("é");
    expect(map.lookup(0x99, 2)).toBeUndefined();
    expect(map.lookup(0x03, 1)).toBeUndefined();
    expect(map.find(" ")).toEqual({ code: 3, bytes: 2 });
    expect(map.find("M")).toEqual({ code: 0x24 + 12, bytes: 2 });
    expect(map.find("é")).toEqual({ code: 0x46, bytes: 2 });
    expect(map.find("fi")).toEqual({ code: 0x13b2, bytes: 2 });
    expect(map.find("q")).toBeNull();
  });

  it("gives up on a CMap it can't read", () => {
    expect(parseToUnicode(bytes("begincmap (unclosed endcmap"))).toBeNull();
  });
});
