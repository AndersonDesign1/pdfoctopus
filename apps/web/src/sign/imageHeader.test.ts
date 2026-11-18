// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readPictureHeader } from "./imageHeader";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];

describe("readPictureHeader", () => {
  it("reads a PNG's size, including a huge one", () => {
    const png = (w: number, h: number) =>
      bytes([0x89], "PNG", [13, 10, 26, 10], be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);
    expect(readPictureHeader(png(640, 480))).toEqual({ format: "png", width: 640, height: 480 });
    expect(readPictureHeader(png(100000, 100000))).toMatchObject({ width: 100000 });
  });

  it("reads GIF and BMP sizes", () => {
    expect(readPictureHeader(bytes("GIF89a", le16(320), le16(200)))).toEqual({
      format: "gif",
      width: 320,
      height: 200,
    });
    const bmp = bytes("BM", new Array(16).fill(0), le32(800), le32(-600), [1, 0, 24, 0]);
    expect(readPictureHeader(bmp)).toEqual({ format: "bmp", width: 800, height: 600 });
  });

  it("finds a JPEG's size after its camera data", () => {
    const exif = new Array(5000).fill(0);
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1],
      be16(exif.length + 2),
      exif,
      [0xff, 0xdb],
      be16(4),
      [0, 0],
      [0xff, 0xc0],
      be16(17),
      [8],
      be16(3000),
      be16(4000),
      [3],
      new Array(9).fill(0),
    );
    expect(readPictureHeader(jpeg)).toEqual({ format: "jpeg", width: 4000, height: 3000 });
    // Cut off before the frame header: a JPEG, size unknown.
    expect(readPictureHeader(jpeg.slice(0, 100))).toEqual({
      format: "jpeg",
      width: null,
      height: null,
    });
  });

  it("reads WebP (extended) and AVIF sizes", () => {
    const u24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
    const webp = bytes(
      "RIFF",
      le32(30),
      "WEBP",
      "VP8X",
      le32(10),
      [0, 0, 0, 0],
      u24(1919),
      u24(1079),
    );
    expect(readPictureHeader(webp)).toEqual({ format: "webp", width: 1920, height: 1080 });
    const avif = bytes(
      be32(24),
      "ftypavif",
      new Array(12).fill(0),
      be32(20),
      "ispe",
      [0, 0, 0, 0],
      be32(1200),
      be32(800),
    );
    expect(readPictureHeader(avif)).toEqual({ format: "avif", width: 1200, height: 800 });
  });

  it("knows nothing else", () => {
    expect(readPictureHeader(bytes("not really a png"))).toBeNull();
    expect(readPictureHeader(new Uint8Array(0))).toBeNull();
  });
});
