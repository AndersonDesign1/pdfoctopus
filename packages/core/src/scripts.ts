// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writing systems for text editing (Phase 6, step 3): which way text reads, Arabic letter
// forms, and where Chinese, Japanese and Korean text may break. Pure functions, no MuPDF.
//
// Right-to-left text is drawn in a PDF in visual order: the glyphs left to right as they're
// seen. People read and type it in logical order. `toLogical` and `toVisual` turn one into the
// other for a line read right to left (a small part of the Unicode bidirectional algorithm:
// right-to-left runs, with numbers and left-to-right words inside them). Where the result is in
// doubt (`toLogical` gives text that doesn't come back the same), the line is refused.
//
// Arabic letters change shape with their neighbours. A PDF draws each shape as its own glyph;
// only a font whose ToUnicode map gives each glyph's Presentation Forms character tells which
// shape a glyph is, so only then can new text be shaped (`shapeArabic`) and drawn with it.

// ---------------------------------------------------------------------------------------------
// Character classes

export const CJK = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿＀-￯]|[\u{20000}-\u{3ffff}]/u;
export const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const HEBREW = /[֐-׿יִ-ﭏ]/;
export const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
/** Arabic and Hebrew marks (vowel points), which sit on the letter before. */
const MARK = /[֑-ׇؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿ]/;
/** Characters that change the direction of text explicitly. */
export const BIDI_CONTROL = /[؜‎‏‪-‮⁦-⁩]/;

type Bidi = "R" | "L" | "EN" | "ES" | "ET" | "CS" | "WS" | "ON" | "NSM";

function bidiClass(ch: string): Bidi {
  const cp = ch.codePointAt(0) as number;
  if (MARK.test(ch)) return "NSM";
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x660 && cp <= 0x669) || (cp >= 0x6f0 && cp <= 0x6f9))
    return "EN";
  if (cp === 0x66b || cp === 0x66c) return "CS";
  if (HEBREW.test(ch) || ARABIC.test(ch)) return "R";
  if (ch === "+" || ch === "-" || ch === "−") return "ES";
  if (ch === "," || ch === "." || ch === ":" || ch === "/" || ch === " ") return "CS";
  if (/[#$%°¢£¤¥±‰′″₠-⃏]/.test(ch)) return "ET";
  if (/\s/.test(ch)) return "WS";
  if (/[\p{L}\p{M}]/u.test(ch)) return "L";
  return "ON";
}

const MIRROR: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
  "«": "»",
  "»": "«",
  "‹": "›",
  "›": "‹",
};

/**
 * Embedding levels for text in a paragraph read right to left: 1 for right-to-left (and
 * neutral) characters, 2 for left-to-right words and numbers.
 */
function levels(chars: string[]): number[] {
  const types: Bidi[] = chars.map(bidiClass);
  // W1: a mark takes the type of the character before it.
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "NSM") types[i] = i > 0 ? (types[i - 1] as Bidi) : "R";
  }
  // W4: one separator between two numbers joins them ("1,250", "12.5").
  for (let i = 1; i + 1 < types.length; i++) {
    const t = types[i];
    if ((t === "ES" || t === "CS") && types[i - 1] === "EN" && types[i + 1] === "EN") {
      types[i] = "EN";
    }
  }
  // W5: currency and percent signs next to a number go with it.
  for (let i = 0; i < types.length; i++) {
    if (types[i] !== "ET") continue;
    let j = i;
    while (j < types.length && types[j] === "ET") j++;
    const next = types[j];
    const prev = types[i - 1];
    if (prev === "EN" || next === "EN") for (let k = i; k < j; k++) types[k] = "EN";
    i = j - 1;
  }
  // W6: other separators are neutral.
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === "ES" || t === "ET" || t === "CS") types[i] = "ON";
  }
  // W7: a number after left-to-right text is left-to-right.
  let strong: Bidi = "R";
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === "L" || t === "R") strong = t;
    else if (t === "EN" && strong === "L") types[i] = "L";
  }
  // N1, N2: neutrals between two left-to-right characters are left-to-right; others go with the
  // paragraph (right to left). Numbers count as right-to-left here.
  const dir = (t: Bidi | undefined) => (t === "L" ? "L" : t === "R" || t === "EN" ? "R" : null);
  for (let i = 0; i < types.length; i++) {
    if (dir(types[i]) !== null) continue;
    let j = i;
    while (j < types.length && dir(types[j]) === null) j++;
    const before = i > 0 ? dir(types[i - 1]) : "R";
    const after = j < types.length ? dir(types[j]) : "R";
    const resolved: Bidi = before === "L" && after === "L" ? "L" : "R";
    for (let k = i; k < j; k++) types[k] = resolved;
    i = j - 1;
  }
  // L1: spaces at the end of the line are at the paragraph's level.
  const out = types.map((t) => (t === "L" || t === "EN" ? 2 : 1));
  for (let i = out.length - 1; i >= 0 && /\s/.test(chars[i] as string); i--) out[i] = 1;
  return out;
}

/** Reorder by levels (L2) and mirror brackets read right to left (L4). Its own inverse. */
function reorder(chars: string[], lv: number[]): string[] {
  const out = [...chars];
  for (let i = 0; i < out.length; i++) {
    if ((lv[i] as number) < 2) continue;
    let j = i;
    while (j < out.length && (lv[j] as number) >= 2) j++;
    const run = out.slice(i, j).reverse();
    out.splice(i, j - i, ...run);
    i = j - 1;
  }
  out.reverse();
  // After reversing, level i of out is level (n - 1 - i) of the input.
  const n = out.length;
  return out.map((c, i) => ((lv[n - 1 - i] as number) === 1 ? (MIRROR[c] ?? c) : c));
}

/** A line read right to left, in the order it's drawn (left to right). */
export function toVisual(logical: string): string {
  const chars = [...logical];
  return reorder(chars, levels(chars)).join("");
}

/**
 * The reading order of a line drawn left to right (`visual`) that reads right to left, or null
 * when it can't be told for certain: drawing the result again wouldn't give the same glyphs, or
 * the line is mostly left-to-right text with some right-to-left words in it.
 */
export function toLogical(visual: string): string | null {
  const chars = [...visual];
  if (BIDI_CONTROL.test(visual)) return null;
  const strong = chars.map(bidiClass).filter((t) => t === "L" || t === "R");
  if (!strong.includes("R")) return null;
  if (strong[0] === "L" && strong[strong.length - 1] === "L") return null;
  const logical = reorder(chars, levels(chars)).join("");
  return toVisual(logical) === visual ? logical : null;
}

// ---------------------------------------------------------------------------------------------
// Arabic letter forms

/** Each letter's forms: isolated, final, initial, medial (the last two for letters that join on
 * both sides). From Arabic Presentation Forms-A and -B. */
const FORMS: Record<string, readonly number[]> = {
  ء: [0xfe80],
  آ: [0xfe81, 0xfe82],
  أ: [0xfe83, 0xfe84],
  ؤ: [0xfe85, 0xfe86],
  إ: [0xfe87, 0xfe88],
  ئ: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  ا: [0xfe8d, 0xfe8e],
  ب: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  ة: [0xfe93, 0xfe94],
  ت: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  ث: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  ج: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  ح: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  خ: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  د: [0xfea9, 0xfeaa],
  ذ: [0xfeab, 0xfeac],
  ر: [0xfead, 0xfeae],
  ز: [0xfeaf, 0xfeb0],
  س: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  ش: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  ص: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  ض: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  ط: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  ظ: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  ع: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  غ: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  ف: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  ق: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  ك: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  ل: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  م: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  ن: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  ه: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  و: [0xfeed, 0xfeee],
  ى: [0xfeef, 0xfef0],
  ي: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  پ: [0xfb56, 0xfb57, 0xfb58, 0xfb59],
  چ: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d],
  ژ: [0xfb8a, 0xfb8b],
  ک: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91],
  گ: [0xfb92, 0xfb93, 0xfb94, 0xfb95],
  ی: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff],
};
/** Lam followed by an alef: one glyph, isolated or final. */
const LAM_ALEF: Record<string, readonly [number, number]> = {
  آ: [0xfef5, 0xfef6],
  أ: [0xfef7, 0xfef8],
  إ: [0xfef9, 0xfefa],
  ا: [0xfefb, 0xfefc],
};
const TATWEEL = "ـ";

const BASE = new Map<string, string>();
for (const [letter, forms] of Object.entries(FORMS)) {
  for (const f of forms) BASE.set(String.fromCodePoint(f), letter);
}
for (const [alef, forms] of Object.entries(LAM_ALEF)) {
  for (const f of forms) BASE.set(String.fromCodePoint(f), `ل${alef}`);
}

/** Whether a character is an Arabic letter that changes shape (so needs its forms to write). */
export function needsShaping(ch: string): boolean {
  const forms = FORMS[ch];
  return forms !== undefined && forms.length > 1;
}

/** Whether a character is one of the Presentation Forms this file knows. */
export function isArabicForm(ch: string): boolean {
  return BASE.has(ch);
}

/** A letter's isolated form, or the character itself if it has none. */
export function isolatedForm(ch: string): string {
  const forms = FORMS[ch];
  return forms ? String.fromCodePoint(forms[0] as number) : ch;
}

/** The letter an isolated form stands for, or null if it isn't one (lam-alef included). */
export function isolatedLetter(ch: string): string | null {
  const letter = BASE.get(ch);
  return letter && letter.length === 1 && isolatedForm(letter) === ch ? letter : null;
}

/** Presentation forms back to the letters they stand for (as people type them). */
export function unshapeArabic(text: string): string {
  let out = "";
  for (const ch of text) out += BASE.get(ch) ?? ch;
  return out;
}

const joinsBoth = (ch: string | undefined) =>
  ch === TATWEEL || (ch !== undefined && (FORMS[ch]?.length ?? 0) === 4);
const joinsBefore = (ch: string | undefined) =>
  ch === TATWEEL || (ch !== undefined && (FORMS[ch]?.length ?? 0) >= 2);

/**
 * Arabic letters (in reading order) as their joined forms: each letter takes its isolated,
 * initial, medial or final form from the letters next to it, and lam with alef becomes one
 * glyph. Other characters are left as they are.
 */
export function shapeArabic(text: string): string {
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const fromPrev = joinsBoth(prev) && joinsBefore(ch);
    if (ch === "ل" && next !== undefined && LAM_ALEF[next]) {
      const [isolated, final] = LAM_ALEF[next] as [number, number];
      out += String.fromCodePoint(fromPrev ? final : isolated);
      i++;
      continue;
    }
    const forms = FORMS[ch];
    if (!forms) {
      out += ch;
      continue;
    }
    const toNext = forms.length === 4 && joinsBefore(next);
    const form =
      fromPrev && toNext
        ? forms[3]
        : fromPrev
          ? forms[1]
          : toNext
            ? forms[2]
            : (forms[0] as number);
    out += String.fromCodePoint(form ?? (forms[0] as number));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Breaking Chinese, Japanese and Korean text

/** Characters a line mustn't start with (closing brackets, small kana, punctuation). */
const NO_START = new Set([
  ..."、。，．,.：；:;？！?!）)」』】〕〉》〙〗｝}］]〟’”ー‐゠–〜～・ゝゞヽヾ々〻%％",
  ..."ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ",
]);
/** Characters a line mustn't end with (opening brackets and quotes). */
const NO_END = new Set([..."（(「『【〔〈《〘〖｛{［[〝‘“"]);

/**
 * Where a line of text may break inside a word (a run without spaces): between two characters
 * when either is Chinese, Japanese or Korean, except before closing punctuation or after an
 * opening bracket (kinsoku). Returns the pieces to keep together.
 */
export function breakUnits(word: string): string[] {
  const chars = [...word];
  const units: string[] = [];
  let current = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const prev = chars[i - 1];
    if (
      current &&
      prev !== undefined &&
      (CJK.test(prev) || CJK.test(ch)) &&
      !NO_START.has(ch) &&
      !NO_END.has(prev)
    ) {
      units.push(current);
      current = "";
    }
    current += ch;
  }
  if (current) units.push(current);
  return units;
}

/** Whether a line ending with `a` and the next starting with `b` join without a space. */
export function joinsWithoutSpace(a: string, b: string): boolean {
  return CJK.test(a) && CJK.test(b);
}
