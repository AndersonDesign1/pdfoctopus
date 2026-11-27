// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hand-made hostile PDFs: each breaks one rule a careless reader trusts, such as a page tree
// that contains itself, a /Count of two billion, a form field that is its own parent, an
// image a billion pixels wide or a filter with impossible parameters. The fuzzer runs every
// one of them, and mutates them too.

import { onePage, type RawObject, rawPdf, stream } from "./rawPdf";

export interface CraftedPdf {
  name: string;
  bytes: Uint8Array;
}

const CATALOG = "<</Type /Catalog /Pages 2 0 R>>";
const PAGE = "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]";

/** One page with `content`, plus extra objects from number 6 on. */
function page(content: string, pageExtra = "", extra: RawObject[] = [], trailer?: string) {
  return rawPdf([...onePage(content, pageExtra), ...extra], { trailer });
}

/** A catalog with extra entries, one plain page, and extra objects from number 6 on. */
function catalog(entries: string, extra: RawObject[] = []) {
  const objects = onePage();
  objects[0] = `<</Type /Catalog /Pages 2 0 R ${entries}>>`;
  return rawPdf([...objects, ...extra]);
}

function nested(open: string, close: string, depth: number, inner = "0") {
  return open.repeat(depth) + inner + close.repeat(depth);
}

/** A page tree where every node lists the next node twice: 2^depth pages from a tiny file. */
function sharedPageTree(depth: number): Uint8Array {
  const objects: RawObject[] = [CATALOG];
  // Object 2 is the root; objects 2..depth+1 are tree nodes, the last one points at the page.
  for (let level = 0; level < depth; level++) {
    const num = level + 2;
    const kid = num + 1;
    objects.push(`<</Type /Pages /Kids [${kid} 0 R ${kid} 0 R] /Count ${2 ** (depth - level)}>>`);
  }
  const pageNum = depth + 2;
  objects.push(`<</Type /Page /Parent ${pageNum - 1} 0 R /MediaBox [0 0 100 100]>>`);
  return rawPdf(objects);
}

/** A page drawing a chain of `depth` forms (or tiling patterns), each drawing the next. */
function nestedDrawings(kind: "form" | "pattern", depth: number): Uint8Array {
  const use = (n: number) =>
    kind === "form"
      ? { res: `/XObject <</X ${n} 0 R>>`, draw: "/X Do" }
      : { res: `/Pattern <</P ${n} 0 R>>`, draw: "/Pattern cs /P scn 0 0 10 10 re f" };
  const objects: RawObject[] = [
    CATALOG,
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    `<<${PAGE} /Contents 4 0 R /Resources <<${use(5).res}>>>>`,
    stream("", use(5).draw),
  ];
  for (let i = 0; i < depth; i++) {
    const last = i === depth - 1;
    const res = last ? "" : `/Resources <<${use(6 + i).res}>>`;
    const draw = last ? "0 0 10 10 re f" : use(6 + i).draw;
    objects.push(
      kind === "form"
        ? stream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] ${res}`, draw)
        : stream(
            `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 ${res}`,
            draw,
          ),
    );
  }
  return rawPdf(objects);
}

/** A page label tree in which each level lists the next level twice. */
function sharedLabelTree(depth: number): Uint8Array {
  const extra: RawObject[] = [];
  for (let level = 0; level < depth; level++) {
    const kid = 7 + level;
    extra.push(`<</Kids [${kid} 0 R ${kid} 0 R]>>`);
  }
  extra.push("<</Nums [0 <</S /r>>]>>");
  return catalog("/PageLabels 6 0 R", extra);
}

/** A fixed list of hostile files, always the same, in the same order. */
export function craftedPdfs(): CraftedPdf[] {
  const list: [string, () => Uint8Array][] = [
    // ---- The page tree
    [
      "page-tree-contains-itself",
      () => rawPdf([CATALOG, "<</Type /Pages /Kids [2 0 R 3 0 R] /Count 2>>", `<<${PAGE}>>`]),
    ],
    [
      "page-tree-loop-two-nodes",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Pages /Parent 2 0 R /Kids [2 0 R 4 0 R] /Count 1>>",
          "<</Type /Page /Parent 3 0 R /MediaBox [0 0 612 792]>>",
        ]),
    ],
    [
      "page-parent-is-itself",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 3 0 R>>",
        ]),
    ],
    [
      "page-parent-cycle-inherits",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1 /Parent 4 0 R>>",
          "<</Type /Page /Parent 2 0 R>>",
          "<</Type /Pages /Kids [2 0 R] /Count 1 /Parent 2 0 R>>",
        ]),
    ],
    [
      "page-tree-count-huge",
      () => rawPdf([CATALOG, "<</Type /Pages /Kids [3 0 R] /Count 2147483647>>", `<<${PAGE}>>`]),
    ],
    [
      "page-tree-count-negative",
      () => rawPdf([CATALOG, "<</Type /Pages /Kids [3 0 R] /Count -5>>", `<<${PAGE}>>`]),
    ],
    [
      "page-tree-count-wrong-type",
      () => rawPdf([CATALOG, "<</Type /Pages /Kids [3 0 R] /Count (lots)>>", `<<${PAGE}>>`]),
    ],
    [
      "page-tree-kids-not-array",
      () => rawPdf([CATALOG, "<</Type /Pages /Kids 3 0 R /Count 1>>", `<<${PAGE}>>`]),
    ],
    ["page-tree-kid-missing", () => rawPdf([CATALOG, "<</Type /Pages /Kids [9 0 R] /Count 1>>"])],
    ["page-tree-shared-kids", () => sharedPageTree(22)],
    [
      "page-tree-deep",
      () => {
        const depth = 400;
        const objects: RawObject[] = [CATALOG];
        for (let i = 0; i < depth; i++)
          objects.push(`<</Type /Pages /Kids [${i + 3} 0 R] /Count 1>>`);
        objects.push(`<</Type /Page /Parent ${depth + 1} 0 R /MediaBox [0 0 99 99]>>`);
        return rawPdf(objects);
      },
    ],
    ["no-pages-at-all", () => rawPdf(["<</Type /Catalog>>"])],
    ["root-not-a-dictionary", () => rawPdf(["[1 2 3]"])],
    [
      // Found by the fuzzer: inserting a page into this tree made MuPDF loop for ever.
      "page-tree-unreadable-page-parent-loop",
      () => {
        const bytes = rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1 /Parent 4 0 R>>",
          "<</Type /Page /Parent 2 0 R>>",
          "<</Type /Pages /Kids [2 0 R] /Count 1 /Parent 2 0 R>>",
        ]);
        const text = new TextDecoder("latin1").decode(bytes).replace("3 0 obj", "3  obj");
        return Uint8Array.from(text, (c) => c.charCodeAt(0));
      },
    ],
    // Found by the fuzzer: these overflowed MuPDF's stack (see nesting.ts, drawingDepth.ts).
    ["objects-nested-200-arrays", () => page("BT ET", `/Junk ${nested("[", "]", 200)}`)],
    ["objects-nested-200-dicts", () => page("BT ET", `/Junk ${nested("<</A ", ">>", 200)}`)],
    ["forms-nested-40", () => nestedDrawings("form", 40)],
    ["patterns-nested-40", () => nestedDrawings("pattern", 40)],

    // ---- Page boxes, rotation and size
    [
      "mediabox-huge",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 2 0 R /MediaBox [0 0 1e30 1e30]>>",
        ]),
    ],
    [
      "mediabox-huge-int",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 2 0 R /MediaBox [-2147483648 -2147483648 2147483647 2147483647]>>",
        ]),
    ],
    [
      "mediabox-empty",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 2 0 R /MediaBox [0 0 0 0]>>",
        ]),
    ],
    [
      "mediabox-inverted",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 2 0 R /MediaBox [612 792 0 0] /CropBox [900 900 -5 3]>>",
        ]),
    ],
    [
      "mediabox-wrong-types",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 2 0 R /MediaBox [(a) /b null [1]]>>",
        ]),
    ],
    [
      "mediabox-short",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          "<</Type /Page /Parent 2 0 R /MediaBox [0 0]>>",
        ]),
    ],
    ["rotate-odd", () => page("0 0 m 100 100 l S", "/Rotate 45")],
    ["rotate-huge", () => page("0 0 m 100 100 l S", "/Rotate 2147483647")],
    ["userunit-huge", () => page("0 0 m 100 100 l S", "/UserUnit 1e9")],

    // ---- Deep nesting
    ["content-deep-arrays", () => page(`${nested("[", "]", 50_000)} pop`)],
    ["content-deep-dicts", () => page(`${nested("<</A ", ">>", 20_000)} pop`)],
    ["content-deep-q", () => page(`${"q ".repeat(100_000)}0 0 m 10 10 l S`)],
    ["content-unbalanced-Q", () => page(`${"Q ".repeat(10_000)}BT ET`)],
    ["object-deep-array", () => page("", `/Junk ${nested("[", "]", 100_000)}`)],
    ["object-deep-dict", () => page("", `/Junk ${nested("<</K ", ">>", 50_000)}`)],
    ["content-many-operands", () => page(`${"1 ".repeat(200_000)}m`)],
    ["content-huge-string", () => page(`BT /F1 12 Tf 10 10 Td (${"A".repeat(100_000)}) Tj ET`)],

    // ---- Recursive drawing
    [
      "form-xobject-draws-itself",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          `<<${PAGE} /Contents 4 0 R /Resources <</XObject <</X0 5 0 R>>>>>>`,
          stream("", "/X0 Do"),
          stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources <</XObject <</X0 5 0 R>>>>",
            "q 0.5 0 0 0.5 0 0 cm /X0 Do Q",
          ),
        ]),
    ],
    [
      "pattern-uses-itself",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          `<<${PAGE} /Contents 4 0 R /Resources <</Pattern <</P0 5 0 R>>>>>>`,
          stream("", "/Pattern cs /P0 scn 0 0 612 792 re f"),
          stream(
            "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources <</Pattern <</P0 5 0 R>>>>",
            "/Pattern cs /P0 scn 0 0 10 10 re f",
          ),
        ]),
    ],
    [
      "pattern-step-tiny",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          `<<${PAGE} /Contents 4 0 R /Resources <</Pattern <</P0 5 0 R>>>>>>`,
          stream("", "/Pattern cs /P0 scn 0 0 612 792 re f"),
          stream(
            "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1e-9 1e-9] /XStep 1e-9 /YStep 1e-9",
            "0 0 1 1 re f",
          ),
        ]),
    ],
    [
      "type3-glyph-draws-itself",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          `<<${PAGE} /Contents 4 0 R /Resources <</Font <</T3 5 0 R>>>>>>`,
          stream("", "BT /T3 12 Tf 10 10 Td (a) Tj ET"),
          "<</Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs <</a 6 0 R>> /Encoding <</Differences [97 /a]>> /FirstChar 97 /LastChar 97 /Widths [1000] /Resources <</Font <</T3 5 0 R>>>>>>",
          stream("", "1000 0 d0 BT /T3 1 Tf (a) Tj ET"),
        ]),
    ],
    [
      "smask-is-itself",
      () =>
        rawPdf([
          CATALOG,
          "<</Type /Pages /Kids [3 0 R] /Count 1>>",
          `<<${PAGE} /Contents 4 0 R /Resources <</XObject <</Im0 5 0 R>>>>>>`,
          stream("", "q 100 0 0 100 0 0 cm /Im0 Do Q"),
          stream(
            "/Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /SMask 5 0 R",
            "\x00\xff\x00\xff",
          ),
        ]),
    ],

    // ---- Images
    ...imageCases(),

    // ---- Fonts
    ...fontCases(),

    // ---- Filters and predictors
    ...filterCases(),

    // ---- Outlines, names, labels
    [
      "outline-next-is-itself",
      () =>
        catalog("/Outlines 6 0 R", [
          "<</Type /Outlines /First 7 0 R /Last 7 0 R /Count 1>>",
          "<</Title (Loop) /Parent 6 0 R /Next 7 0 R /Dest [3 0 R /Fit]>>",
        ]),
    ],
    [
      "outline-first-is-parent",
      () =>
        catalog("/Outlines 6 0 R", [
          "<</Type /Outlines /First 7 0 R /Count 1>>",
          "<</Title (Up) /Parent 6 0 R /First 6 0 R /Count 1 /Dest [3 0 R /Fit]>>",
        ]),
    ],
    [
      "outline-count-huge",
      () =>
        catalog("/Outlines 6 0 R", [
          "<</Type /Outlines /First 7 0 R /Count 2147483647>>",
          "<</Title (Big) /Parent 6 0 R /Count -2147483648 /Dest [3 0 R /Fit]>>",
        ]),
    ],
    [
      "outline-dest-loop",
      () =>
        catalog("/Outlines 6 0 R /Names <</Dests 8 0 R>>", [
          "<</Type /Outlines /First 7 0 R /Count 1>>",
          "<</Title (Named) /Parent 6 0 R /Dest (a)>>",
          "<</Kids [8 0 R] /Names [(a) (a)]>>",
        ]),
    ],
    [
      "name-tree-kids-loop",
      () =>
        catalog("/Names <</Dests 6 0 R /EmbeddedFiles 6 0 R /JavaScript 6 0 R>>", [
          "<</Kids [6 0 R 7 0 R]>>",
          "<</Kids [6 0 R] /Limits [(a) (z)]>>",
        ]),
    ],
    [
      "dests-loop",
      () =>
        catalog("/Dests 6 0 R /OpenAction 7 0 R", [
          "<</a 7 0 R>>",
          "<</S /GoTo /D /a /Next 7 0 R>>",
        ]),
    ],
    [
      "page-labels-loop",
      () =>
        catalog("/PageLabels 6 0 R", [
          "<</Kids [6 0 R 7 0 R]>>",
          "<</Kids [6 0 R] /Nums [0 <</S /D>>]>>",
        ]),
    ],
    ["page-labels-shared", () => sharedLabelTree(40)],
    ["page-labels-huge-start", () => catalog("/PageLabels <</Nums [0 <</S /A /St 1e15>>]>>")],
    [
      "page-labels-huge-prefix",
      () => {
        // A long prefix on every page of a big (shared) page tree.
        const bytes = sharedPageTree(14);
        const text = new TextDecoder("latin1").decode(bytes);
        const prefix = "P".repeat(200_000);
        const patched = text.replace(
          "<</Type /Catalog /Pages 2 0 R>>",
          `<</Type /Catalog /Pages 2 0 R /PageLabels <</Nums [0 <</S /D /P (${prefix})>>]>>>>`,
        );
        // Offsets moved: let MuPDF repair it.
        return Uint8Array.from(patched, (c) => c.charCodeAt(0));
      },
    ],
    [
      "page-labels-wrong-types",
      () => catalog("/PageLabels <</Nums [(a) 5 /b [1] -1 <</S /Q /St -9 /P 3>> 0 7]>>"),
    ],

    // ---- Annotations
    [
      "annots-contains-page",
      () =>
        page("", "/Annots [3 0 R 6 0 R]", [
          "<</Type /Annot /Subtype /Square /Rect [10 10 50 50] /P 3 0 R>>",
        ]),
    ],
    [
      "annot-popup-loop",
      () =>
        page("", "/Annots [6 0 R 7 0 R]", [
          "<</Type /Annot /Subtype /Text /Rect [10 10 30 30] /Popup 7 0 R /IRT 6 0 R /Contents (hi)>>",
          "<</Type /Annot /Subtype /Popup /Rect [40 40 200 100] /Parent 7 0 R /Popup 6 0 R>>",
        ]),
    ],
    [
      "annot-irt-cycle",
      () =>
        page("", "/Annots [6 0 R 7 0 R]", [
          "<</Type /Annot /Subtype /Text /Rect [10 10 30 30] /IRT 7 0 R>>",
          "<</Type /Annot /Subtype /Text /Rect [40 40 60 60] /IRT 6 0 R>>",
        ]),
    ],
    [
      "annot-bad-geometry",
      () =>
        page("", "/Annots [6 0 R 7 0 R 8 0 R]", [
          "<</Type /Annot /Subtype /Ink /Rect [1e30 -1e30 (x) 4] /InkList [[1 2 3] 5 [(a)]]>>",
          "<</Type /Annot /Subtype /Highlight /Rect [0 0 10 10] /QuadPoints [1 2 3]>>",
          "<</Type /Annot /Subtype /Line /Rect [0 0 10 10] /L [1] /C [2 2 2 2 2 2]>>",
        ]),
    ],
    [
      "annot-appearance-loop",
      () =>
        page("", "/Annots [6 0 R]", [
          "<</Type /Annot /Subtype /Square /Rect [10 10 50 50] /AP <</N 7 0 R>>>>",
          stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 40 40] /Resources <</XObject <</A 7 0 R>>>>",
            "/A Do",
          ),
        ]),
    ],
    [
      "annots-many",
      () =>
        page("", `/Annots [${"6 0 R ".repeat(5_000)}]`, [
          "<</Type /Annot /Subtype /Square /Rect [10 10 50 50]>>",
        ]),
    ],

    // ---- Forms
    [
      "field-kids-contains-itself",
      () =>
        catalog("/AcroForm <</Fields [6 0 R]>>", [
          "<</FT /Tx /T (a) /Kids [6 0 R 7 0 R]>>",
          "<</Type /Annot /Subtype /Widget /Rect [10 10 100 30] /Parent 6 0 R /P 3 0 R>>",
        ]),
    ],
    [
      "field-parent-cycle",
      () => {
        const objects = onePage("", "/Annots [7 0 R]");
        objects[0] = "<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R]>>>>";
        objects[2] = `<<${PAGE} /Contents 4 0 R /Annots [7 0 R]>>`;
        return rawPdf([
          ...objects,
          "<</FT /Tx /T (a) /Parent 7 0 R /Kids [7 0 R]>>",
          "<</Type /Annot /Subtype /Widget /Rect [10 10 100 30] /Parent 6 0 R /T (b) /Kids [6 0 R]>>",
        ]);
      },
    ],
    [
      "field-widget-parent-itself",
      () => {
        const objects = onePage("");
        objects[0] = "<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R]>>>>";
        objects[2] = `<<${PAGE} /Contents 4 0 R /Annots [6 0 R]>>`;
        return rawPdf([
          ...objects,
          "<</Type /Annot /Subtype /Widget /FT /Tx /T (a) /Rect [10 10 100 30] /Parent 6 0 R>>",
        ]);
      },
    ],
    [
      "field-deep-tree",
      () => {
        const depth = 2_000;
        const objects = onePage("");
        objects[0] = "<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R]>>>>";
        objects[2] = `<<${PAGE} /Contents 4 0 R /Annots [${depth + 5} 0 R]>>`;
        const extra: RawObject[] = [];
        for (let i = 0; i < depth; i++) {
          const num = 6 + i;
          const parent = i === 0 ? "" : `/Parent ${num - 1} 0 R`;
          extra.push(`<</T (f${i}) /FT /Tx ${parent} /Kids [${num + 1} 0 R]>>`);
        }
        extra.push(
          `<</Type /Annot /Subtype /Widget /Rect [10 10 100 30] /Parent ${depth + 5} 0 R /P 3 0 R>>`,
        );
        return rawPdf([...objects, ...extra]);
      },
    ],
    [
      "field-bad-values",
      () => {
        const objects = onePage("");
        objects[0] =
          "<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R 7 0 R 8 0 R] /DA 5>>>>";
        objects[2] = `<<${PAGE} /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R]>>`;
        return rawPdf([
          ...objects,
          "<</Type /Annot /Subtype /Widget /FT /Ch /T 5 /Rect [10 10 100 30] /Opt [[1] (a) [(b)] 7] /V [/x 9] /Ff -1 /MaxLen -4>>",
          "<</Type /Annot /Subtype /Widget /FT /Btn /T (r) /Rect [10 40 30 60] /AS /Off /AP <</N 5 /D <</On 4>>>> /V 9 /Ff 2147483647>>",
          "<</Type /Annot /Subtype /Widget /FT /Tx /T (t) /Rect [1e30 1e30 -1e30 (q)] /DA (/Nope 1e9 Tf 1 2 3 4 5 k) /V <</no 1>> /Q 99>>",
        ]);
      },
    ],
    ["fields-not-array", () => catalog("/AcroForm <</Fields 5 0 R /NeedAppearances true>>")],

    // ---- Signatures
    ...signatureCases(),

    // ---- Encryption
    ...encryptionCases(),

    // ---- Cross-reference and object streams
    [
      "xref-prev-loop",
      () => {
        const bytes = page("BT ET");
        const text = new TextDecoder("latin1").decode(bytes);
        const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
        const patched = text.replace("/Root 1 0 R ", `/Root 1 0 R /Prev ${startxref} `);
        return Uint8Array.from(patched, (c) => c.charCodeAt(0));
      },
    ],
    [
      "xref-points-past-end",
      () => {
        const text = new TextDecoder("latin1").decode(page("BT ET"));
        return Uint8Array.from(text.replace(/startxref\n\d+/, "startxref\n99999999999"), (c) =>
          c.charCodeAt(0),
        );
      },
    ],
    [
      "xref-size-huge",
      () => {
        const text = new TextDecoder("latin1").decode(page("BT ET"));
        return Uint8Array.from(text.replace(/\/Size \d+/, "/Size 2147483647"), (c) =>
          c.charCodeAt(0),
        );
      },
    ],
    ["xref-stream-bad-w", () => xrefStream("/W [9 9 9] /Index [0 2147483647]")],
    ["xref-stream-zero-w", () => xrefStream("/W [0 0 0]")],
    ["xref-stream-negative-index", () => xrefStream("/W [1 2 1] /Index [-5 3 2147483640 9]")],
    [
      "object-stream-contains-itself",
      () => {
        const objects = onePage("BT ET");
        return rawPdf([
          ...objects,
          stream("/Type /ObjStm /N 2147483647 /First -3 /Extends 6 0 R", "6 0 7 5 "),
        ]);
      },
    ],
    [
      "no-xref-many-objects",
      () => {
        const objects: RawObject[] = onePage("BT ET");
        for (let i = 0; i < 20_000; i++) objects.push(`<</N ${i} /Ref ${i + 7} 0 R>>`);
        return rawPdf(objects, { noXref: true });
      },
    ],
    [
      "reference-chain-long",
      () => {
        const objects: RawObject[] = onePage("BT ET");
        objects[2] = `<<${PAGE} /Contents 4 0 R /Resources 6 0 R>>`;
        for (let i = 0; i < 5_000; i++) objects.push(`${i + 7} 0 R`);
        objects.push("<<>>");
        return rawPdf(objects);
      },
    ],
    [
      "reference-to-itself",
      () => {
        const objects: RawObject[] = onePage("BT ET");
        objects[2] = `<<${PAGE} /Contents 4 0 R /Resources 6 0 R>>`;
        objects.push("6 0 R");
        return rawPdf(objects);
      },
    ],
    [
      "metadata-loop",
      () => {
        const objects: RawObject[] = onePage("BT ET");
        objects.push("<</Title 6 0 R /Author (x) /Producer 7 0 R>>", "7 0 R");
        return rawPdf(objects, { trailer: "/Info 6 0 R" });
      },
    ],
  ];
  return list.map(([name, make]) => ({ name, bytes: make() }));
}

function xrefStream(entries: string): Uint8Array {
  // A file whose only cross-reference section is a broken stream.
  const head =
    "%PDF-1.7\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>\nendobj\n";
  const data = "\x01\x00\x00\x00\x01\x00\x09\x00";
  const xref = head.length;
  const body = `4 0 obj\n<</Type /XRef /Size 5 /Root 1 0 R ${entries} /Length ${data.length}>>\nstream\n${data}\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(head + body, (c) => c.charCodeAt(0));
}

/** Pages showing one image XObject (object 5) with the given dictionary and data. */
function imagePage(dict: string, data: string | Uint8Array, extra: RawObject[] = []) {
  return rawPdf([
    CATALOG,
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    `<<${PAGE} /Contents 4 0 R /Resources <</XObject <</Im0 5 0 R>>>>>>`,
    stream("", "q 200 0 0 200 50 50 cm /Im0 Do Q"),
    stream(`/Type /XObject /Subtype /Image ${dict}`, data),
    ...extra,
  ]);
}

function imageCases(): [string, () => Uint8Array][] {
  return [
    [
      "image-huge-dimensions",
      () =>
        imagePage(
          "/Width 1000000000 /Height 1000000000 /BitsPerComponent 8 /ColorSpace /DeviceRGB",
          "\x00\x00\x00",
        ),
    ],
    [
      "image-negative-dimensions",
      () => imagePage("/Width -5 /Height 0 /BitsPerComponent 8 /ColorSpace /DeviceGray", "\x00"),
    ],
    [
      "image-overflowing-size",
      () =>
        imagePage(
          "/Width 65536 /Height 65536 /BitsPerComponent 16 /ColorSpace /DeviceCMYK",
          "\x00",
        ),
    ],
    [
      "image-bad-bpc",
      () =>
        imagePage(
          "/Width 4 /Height 4 /BitsPerComponent 3 /ColorSpace /DeviceRGB",
          "\x00".repeat(10),
        ),
    ],
    [
      "image-indexed-bad-lookup",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [/Indexed /DeviceRGB 255 <00>]",
          "\xff\xfe\xfd\xfc",
        ),
    ],
    [
      "image-indexed-hival-huge",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [/Indexed /DeviceRGB 2147483647 (abc)]",
          "\x01\x02\x03\x04",
        ),
    ],
    [
      "image-colorspace-loop",
      () =>
        imagePage("/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace 6 0 R", "\x00\x00\x00\x00", [
          "[/Indexed 6 0 R 1 <0000>]",
        ]),
    ],
    [
      "image-iccbased-garbage",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [/ICCBased 6 0 R]",
          "\x00".repeat(12),
          [stream("/N 3", "garbage icc profile")],
        ),
    ],
    [
      "image-iccbased-n-huge",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [/ICCBased 6 0 R]",
          "\x00".repeat(12),
          [stream("/N 2147483647", "x")],
        ),
    ],
    [
      "image-decode-wrong-length",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Decode [1 0 5]",
          "\x00".repeat(12),
        ),
    ],
    [
      "image-jpeg-garbage",
      () =>
        imagePage(
          "/Width 64 /Height 64 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode",
          "\xff\xd8\xff\xc0\x00\x11\x08\xff\xff\xff\xff\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xff\xda",
        ),
    ],
    [
      "image-jpx-garbage",
      () =>
        imagePage(
          "/Width 64 /Height 64 /Filter /JPXDecode",
          "\x00\x00\x00\x0cjP  \r\n\x87\n\x00\x00\x00\x14ftypjp2 garbage",
        ),
    ],
    [
      "image-jbig2-garbage",
      () =>
        imagePage(
          "/Width 64 /Height 64 /BitsPerComponent 1 /ImageMask true /Filter /JBIG2Decode /DecodeParms <</JBIG2Globals 6 0 R>>",
          "\x00\x00\x00\x00\x30\x00\x01\x00\x00\x00\x13",
          [stream("", "\x97JB2\r\n\x1a\n")],
        ),
    ],
    [
      "image-ccitt-bad-params",
      () =>
        imagePage(
          "/Width 64 /Height 64 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms <</K -1 /Columns 1000000000 /Rows -1>>",
          "\xff\x00\xff",
        ),
    ],
    [
      "image-inline-huge",
      () =>
        page("q 100 0 0 100 0 0 cm BI /W 100000 /H 100000 /BPC 8 /CS /RGB ID \x00\x00\x00 EI Q"),
    ],
    ["image-inline-unterminated", () => page("BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\x01")],
    [
      "image-mask-loop",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Mask 5 0 R",
          "\x00\x00\x00\x00",
        ),
    ],
    [
      "image-png-alpha-wrong",
      () =>
        imagePage(
          "/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /SMask 6 0 R",
          "\x00\x00\x00\x00",
          [
            stream(
              "/Type /XObject /Subtype /Image /Width 9999 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray",
              "\x00",
            ),
          ],
        ),
    ],
  ];
}

/** A page writing "Hi" with font 5 (given as its dictionary) and extra objects from 6. */
function fontPage(font: string, extra: RawObject[] = [], text = "<00480069> Tj") {
  return rawPdf([
    CATALOG,
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    `<<${PAGE} /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>`,
    stream("", `BT /F1 24 Tf 72 700 Td ${text} ET`),
    font,
    ...extra,
  ]);
}

function fontCases(): [string, () => Uint8Array][] {
  const tt =
    "\x00\x01\x00\x00\x00\x05\x00\x80\x00\x02\x00\x01glyf\x00\x00\x00\x00\x00\x00\x00\x40\xff\xff\xff\xffhead\x00\x00\x00\x00\x7f\xff\xff\xff\x00\x00\x00\x10";
  return [
    [
      "font-truetype-garbage",
      () =>
        fontPage(
          "<</Type /Font /Subtype /TrueType /BaseFont /Junk /FirstChar 0 /LastChar 255 /Widths [] /FontDescriptor 6 0 R>>",
          [
            "<</Type /FontDescriptor /FontName /Junk /Flags 32 /FontBBox [0 0 1 1] /FontFile2 7 0 R>>",
            stream("", tt),
          ],
          "(Hi) Tj",
        ),
    ],
    [
      "font-cff-garbage",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type1 /BaseFont /Junk /FontDescriptor 6 0 R>>",
          [
            "<</Type /FontDescriptor /FontName /Junk /Flags 32 /FontFile3 7 0 R>>",
            stream("/Subtype /Type1C", "\x01\x00\x04\x04\xff\xff\xff\xff\x00"),
          ],
          "(Hi) Tj",
        ),
    ],
    [
      "font-type1-garbage",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type1 /BaseFont /Junk /FontDescriptor 6 0 R>>",
          [
            "<</Type /FontDescriptor /FontName /Junk /Flags 32 /FontFile 7 0 R>>",
            stream(
              "/Length1 999999 /Length2 -5 /Length3 0",
              "%!PS-AdobeFont-1.0 eexec \x00\x01\x02",
            ),
          ],
          "(Hi) Tj",
        ),
    ],
    [
      "font-widths-huge-firstchar",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 2147483640 /LastChar 2147483647 /Widths [1 2 3]>>",
          [],
          "(Hi) Tj",
        ),
    ],
    [
      "font-widths-negative",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 255 /LastChar 0 /Widths [-1e30 1e30 (x)]>>",
          [],
          "(Hi) Tj",
        ),
    ],
    [
      "font-descendants-loop",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R]>>",
        ),
    ],
    [
      "font-descendants-missing",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts []>>",
        ),
    ],
    [
      "font-cid-w-garbage",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R>>",
          [
            "<</Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /W [0 [1 2] 5 2147483647 9 (x) [3] -1 -9 4] /DW -5>>",
            stream(
              "",
              "/CIDInit /ProcSet findresource begin 1 begincmap 1 beginbfrange <0000> <FFFF> <0041> endbfrange endcmap",
            ),
          ],
        ),
    ],
    [
      "font-tounicode-usecmap-loop",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding 6 0 R /DescendantFonts [7 0 R] /ToUnicode 6 0 R>>",
          [
            stream(
              "/Type /CMap /CMapName /Loop /UseCMap 6 0 R",
              "/Loop usecmap 1 begincidrange <00> <ff> 0 endcidrange",
            ),
            "<</Type /Font /Subtype /CIDFontType0 /BaseFont /X /CIDSystemInfo <</Registry (A) /Ordering (B) /Supplement 0>>>>",
          ],
        ),
    ],
    [
      "font-tounicode-huge-range",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R>>",
          [
            stream(
              "",
              "1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange 1 beginbfrange <00000000> <FFFFFFFF> [<0041>] endbfrange 1 beginbfchar <0041> <D800DC00D800DC00D800DC00D800DC00D800DC00> endbfchar",
            ),
          ],
          "(AA) Tj",
        ),
    ],
    [
      "font-encoding-differences-garbage",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding <</BaseEncoding /Nope /Differences [2147483647 /a -5 /b (c) 3 [/d]]>>>>",
          [],
          "(Hi) Tj",
        ),
    ],
    ["font-not-a-dictionary", () => fontPage("[/Font (no)]", [], "(Hi) Tj")],
    [
      "font-type3-no-charprocs",
      () =>
        fontPage(
          "<</Type /Font /Subtype /Type3 /FontMatrix [0 0 0 0 0 0] /FontBBox [0 0 0 0] /Encoding <</Differences [0 /a]>> /FirstChar 0 /LastChar 255 /Widths [1]>>",
          [],
          "(Hi) Tj",
        ),
    ],
  ];
}

function filterCases(): [string, () => Uint8Array][] {
  const content = (dict: string, data: string) =>
    rawPdf([
      CATALOG,
      "<</Type /Pages /Kids [3 0 R] /Count 1>>",
      `<<${PAGE} /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>`,
      stream(dict, data),
      "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    ]);
  return [
    [
      "filter-flate-garbage",
      () => content("/Filter /FlateDecode", "x\x9c\xff\xff\xff\xff garbage"),
    ],
    ["filter-unknown", () => content("/Filter /NoSuchDecode", "BT ET")],
    ["filter-not-a-name", () => content("/Filter [1 (x) <<>>]", "BT ET")],
    [
      "filter-chain-long",
      () => content(`/Filter [${"/ASCIIHexDecode ".repeat(5_000)}]`, "4254204554>"),
    ],
    [
      "filter-predictor-bad",
      () =>
        content(
          "/Filter /FlateDecode /DecodeParms <</Predictor 15 /Columns 2147483647 /Colors 2147483647 /BitsPerComponent 3>>",
          "x\x9c\x03\x00\x00\x00\x00\x01",
        ),
    ],
    [
      "filter-predictor-zero-columns",
      () =>
        content(
          "/Filter /FlateDecode /DecodeParms <</Predictor 12 /Columns 0 /Colors 0>>",
          "x\x9c\x03\x00\x00\x00\x00\x01",
        ),
    ],
    [
      "filter-tiff-predictor-bad",
      () =>
        content(
          "/Filter /LZWDecode /DecodeParms <</Predictor 2 /Columns -1 /BitsPerComponent 16 /EarlyChange 7>>",
          "\x80\x0b\x60\x50\x22\x0c\x0c\x85\x01",
        ),
    ],
    ["filter-lzw-garbage", () => content("/Filter /LZWDecode", "\xff".repeat(4_000))],
    ["filter-runlength-garbage", () => content("/Filter /RunLengthDecode", "\x81A\x7fB\x80")],
    ["filter-ascii85-garbage", () => content("/Filter /ASCII85Decode", "zzzz!!!!~~~~uuuuuu<~")],
    ["filter-asciihex-odd", () => content("/Filter /ASCIIHexDecode", "4254204554 4")],
    [
      "filter-crypt-without-encryption",
      () => content("/Filter /Crypt /DecodeParms <</Name /StdCF>>", "BT ET"),
    ],
    [
      "filter-decodeparms-mismatch",
      () =>
        content(
          "/Filter [/ASCIIHexDecode /FlateDecode] /DecodeParms [null null null <</Predictor 2>>]",
          "00>",
        ),
    ],
    [
      "stream-length-huge",
      () => {
        const text = new TextDecoder("latin1").decode(page("BT /F1 12 Tf (x) Tj ET"));
        return Uint8Array.from(text.replace(/\/Length \d+/, "/Length 2147483647"), (c) =>
          c.charCodeAt(0),
        );
      },
    ],
    [
      "stream-length-negative",
      () => {
        const text = new TextDecoder("latin1").decode(page("BT /F1 12 Tf (x) Tj ET"));
        return Uint8Array.from(text.replace(/\/Length \d+/, "/Length -100"), (c) =>
          c.charCodeAt(0),
        );
      },
    ],
    [
      "stream-length-is-reference-loop",
      () => {
        const text = new TextDecoder("latin1").decode(page("BT ET", "", ["6 0 R"]));
        return Uint8Array.from(text.replace(/\/Length \d+/, "/Length 6 0 R"), (c) =>
          c.charCodeAt(0),
        );
      },
    ],
    [
      "stream-no-endstream",
      () => {
        const text = new TextDecoder("latin1").decode(page("BT ET"));
        return Uint8Array.from(text.replace("endstream", "endstreem"), (c) => c.charCodeAt(0));
      },
    ],
    [
      "contents-array-loop",
      () => {
        const objects = onePage("BT ET");
        objects[2] = `<<${PAGE} /Contents [4 0 R 6 0 R 6 0 R] >>`;
        return rawPdf([...objects, "[6 0 R 4 0 R]"]);
      },
    ],
  ];
}

function signatureCases(): [string, () => Uint8Array][] {
  const signed = (sig: string, field = "") => {
    const objects = onePage("");
    objects[0] = "<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R] /SigFlags 3>>>>";
    objects[2] = `<<${PAGE} /Contents 4 0 R /Annots [6 0 R]>>`;
    return rawPdf([
      ...objects,
      `<</Type /Annot /Subtype /Widget /FT /Sig /T (Sig1) /Rect [0 0 0 0] /P 3 0 R /V 7 0 R ${field}>>`,
      sig,
    ]);
  };
  return [
    [
      "sig-byterange-garbage",
      () =>
        signed(
          "<</Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 -1 99999999999 -5] /Contents <3082000102>>>",
        ),
    ],
    [
      "sig-byterange-many",
      () => signed(`<</Type /Sig /ByteRange [${"0 1 ".repeat(20_000)}] /Contents <00>>>`),
    ],
    [
      "sig-byterange-wrong-types",
      () => signed("<</Type /Sig /ByteRange [(a) /b [1] null] /Contents (not hex)>>"),
    ],
    [
      "sig-contents-huge",
      () => signed(`<</Type /Sig /ByteRange [0 10 20 30] /Contents <${"30".repeat(600_000)}>>>`),
    ],
    [
      "sig-contents-bad-der",
      () =>
        signed(
          "<</Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 50] /Contents <3084ffffffff0201>>>",
        ),
    ],
    [
      "sig-reference-loop",
      () =>
        signed(
          "<</Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<</TransformMethod /DocMDP /TransformParams 7 0 R /Data 7 0 R>>] /Prop_Build 7 0 R>>",
        ),
    ],
    ["sig-value-not-dict", () => signed("[1 2 3]")],
    ["sig-value-is-field", () => signed("6 0 R")],
    [
      "sig-field-lock-loop",
      () => signed("<</Type /Sig /ByteRange [0 1 2 3] /Contents <00>>>", "/Lock 6 0 R /SV 6 0 R"),
    ],
    [
      "sig-perms-loop",
      () => {
        const bytes = signed("<</Type /Sig /ByteRange [0 1 2 3] /Contents <00>>>");
        const text = new TextDecoder("latin1").decode(bytes);
        return Uint8Array.from(
          text.replace("/SigFlags 3>>", "/SigFlags 3>> /Perms <</DocMDP 7 0 R /UR3 1 0 R>>"),
          (c) => c.charCodeAt(0),
        );
      },
    ],
  ];
}

function encryptionCases(): [string, () => Uint8Array][] {
  const enc = (
    dict: string,
    id = "/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]",
  ) =>
    rawPdf([...onePage("BT /F1 12 Tf 10 10 Td (secret) Tj ET"), dict], {
      trailer: `/Encrypt 6 0 R ${id}`,
    });
  const o32 = `<${"ab".repeat(32)}>`;
  return [
    [
      "encrypt-v5-garbage",
      () =>
        enc(
          `<</Filter /Standard /V 5 /R 6 /Length 256 /O <${"00".repeat(48)}> /U <${"11".repeat(48)}> /OE <00> /UE <> /Perms <ff> /P -4 /CF <</StdCF <</CFM /AESV3 /Length 32>>>> /StmF /StdCF /StrF /StdCF>>`,
        ),
    ],
    ["encrypt-unknown-filter", () => enc("<</Filter /NoSuchHandler /V 9 /R 99>>")],
    ["encrypt-not-a-dict", () => enc("(locked)")],
    [
      "encrypt-length-huge",
      () => enc(`<</Filter /Standard /V 2 /R 3 /Length 2147483647 /O ${o32} /U ${o32} /P -1>>`),
    ],
    [
      "encrypt-length-odd",
      () => enc(`<</Filter /Standard /V 2 /R 3 /Length 41 /O ${o32} /U ${o32} /P -1>>`),
    ],
    ["encrypt-short-o-u", () => enc("<</Filter /Standard /V 1 /R 2 /O <00> /U <> /P (x)>>")],
    [
      "encrypt-cf-loop",
      () =>
        enc(
          `<</Filter /Standard /V 4 /R 4 /Length 128 /O ${o32} /U ${o32} /P -1 /CF 6 0 R /StmF /StdCF /StrF /Identity>>`,
        ),
    ],
    [
      "encrypt-no-id",
      () => enc(`<</Filter /Standard /V 2 /R 3 /Length 128 /O ${o32} /U ${o32} /P -1>>`, ""),
    ],
    [
      "encrypt-id-wrong-type",
      () => enc(`<</Filter /Standard /V 2 /R 3 /Length 128 /O ${o32} /U ${o32} /P -1>>`, "/ID 5"),
    ],
    [
      "encrypt-cfm-unknown",
      () =>
        enc(
          `<</Filter /Standard /V 4 /R 4 /Length 128 /O ${o32} /U ${o32} /P -1 /CF <</StdCF <</CFM /Nope /Length -9>>>> /StmF /StdCF /StrF /StdCF>>`,
        ),
    ],
    [
      "encrypt-public-key",
      () =>
        enc("<</Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /Recipients [<3082ffff>]>>"),
    ],
  ];
}
