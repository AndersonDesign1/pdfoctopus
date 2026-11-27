// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs a (possibly damaged) PDF through the engine the way the app does: open it (trying a
// password), read its info, render pages, search, list text lines, paragraphs, form fields
// and annotations, read signatures, export, change pages and undo, and save and reopen.
//
// The rule checked: every call either works or throws an ordinary Error whose message can be
// shown to the user. Never a WebAssembly crash, never something that isn't an Error, never
// an internal JavaScript error (a TypeError or RangeError means our code trusted the file),
// never a call that takes longer than its time budget, and afterwards the same engine must
// still handle good files. That last check is only made when MuPDF reported no trouble with
// the file: after trouble, the app starts a fresh engine before the next file (see
// onEngineTrouble in engine.ts), so what a damaged file leaves behind never reaches another.

import * as mupdf from "mupdf";
import { createBlankPdf, engineTroubles, PdfEngine } from "../engine";
import { IncrementalSaveError } from "../errors";

export type ProblemKind =
  | "crash"
  | "not-an-error"
  | "internal-error"
  | "bad-message"
  | "too-slow"
  | "too-much-memory"
  | "engine-broken"
  | "bad-result";

export interface Problem {
  kind: ProblemKind;
  /** The engine call, e.g. "renderPage(0)". */
  op: string;
  message: string;
}

export interface DriveOptions {
  /** Longest a single engine call may take, in milliseconds. */
  budgetMs?: number;
  /** The open password, for encrypted fixtures. */
  password?: string;
  /** Also edit text, compress, and export SVG (slower). */
  deep?: boolean;
  /** Called with the signatures read from the file, for checking them (packages/sign). */
  onSignatures?: (inspection: ReturnType<PdfEngine["inspectSignatures"]>) => void;
  /**
   * Good files the same engine must still handle afterwards (MuPDF's memory can be damaged
   * without an error at the time). A blank page by default.
   */
  healthCheck?: readonly Uint8Array[];
}

export interface DriveResult {
  problems: Problem[];
  /** How many engine calls were made. */
  calls: number;
  /** Whether the file opened (and was unlocked). */
  opened: boolean;
  /** Whether MuPDF reported trouble (errors or warnings) with the file. */
  troubled: boolean;
}

/** JavaScript's own error types: thrown by our code when it trusted something it shouldn't. */
const INTERNAL_ERRORS = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "InternalError",
  "AggregateError",
]);

/** Most JS heap a single call may add before it counts as runaway memory. */
const MAX_HEAP_GROWTH = 512 * 1024 * 1024;

/** What's wrong with an error thrown by an engine call, or null if it's fine to show. */
export function errorProblem(err: unknown): { kind: ProblemKind; message: string } | null {
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) {
    return { kind: "crash", message: `WebAssembly crashed: ${err.message}` };
  }
  if (!(err instanceof Error)) {
    return { kind: "not-an-error", message: `Threw ${typeof err}: ${String(err).slice(0, 200)}` };
  }
  if (INTERNAL_ERRORS.has(err.name) || INTERNAL_ERRORS.has(err.constructor.name)) {
    return { kind: "internal-error", message: `${err.name}: ${err.message}` };
  }
  const message = err.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { kind: "bad-message", message: "Error with an empty message" };
  }
  if (message.length > 1000) {
    return { kind: "bad-message", message: `Message ${message.length} characters long` };
  }
  if (/\bundefined\b|\[object |\bNaN\b|is not a function|Cannot read prop/.test(message)) {
    return { kind: "bad-message", message };
  }
  return null;
}

class Driver {
  readonly problems: Problem[] = [];
  calls = 0;
  /** Set after a WebAssembly crash: nothing more can be run in this process. */
  dead = false;

  constructor(private readonly budgetMs: number) {}

  /** Run one engine call; returns its result, or undefined if it threw (or was skipped). */
  call<T>(op: string, fn: () => T, check?: (result: T) => string | null): T | undefined {
    if (this.dead) return undefined;
    this.calls++;
    const heapBefore = heapUsed();
    const start = performance.now();
    let result: T | undefined;
    try {
      result = fn();
    } catch (err) {
      const problem = errorProblem(err);
      if (problem) {
        this.problems.push({ op, ...problem });
        if (problem.kind === "crash") this.dead = true;
      }
      result = undefined;
    }
    const ms = performance.now() - start;
    if (ms > this.budgetMs) {
      this.problems.push({
        kind: "too-slow",
        op,
        message: `took ${Math.round(ms)} ms (budget ${this.budgetMs} ms)`,
      });
    }
    let grown = heapUsed() - heapBefore;
    // Garbage not collected yet isn't held: collect it (where possible) before counting.
    if (grown > MAX_HEAP_GROWTH && collectGarbage()) grown = heapUsed() - heapBefore;
    if (grown > MAX_HEAP_GROWTH) {
      this.problems.push({
        kind: "too-much-memory",
        op,
        message: `JavaScript heap grew by ${Math.round(grown / 1048576)} MB`,
      });
    }
    if (result !== undefined && check) {
      const wrong = check(result);
      if (wrong) this.problems.push({ kind: "bad-result", op, message: wrong });
    }
    return result;
  }
}

/** Run the garbage collector now, if the runtime allows it (Bun, or Node with --expose-gc). */
function collectGarbage(): boolean {
  const g = globalThis as { Bun?: { gc(force: boolean): void }; gc?: () => void };
  if (g.Bun) g.Bun.gc(true);
  else if (g.gc) g.gc();
  else return false;
  return true;
}

/**
 * Memory held by JavaScript (objects, strings and array buffers), leaving out MuPDF's own
 * WebAssembly memory, which only ever grows and is capped at 2 GB by MuPDF itself (past that,
 * its allocations fail with an ordinary error). Only Node reports this reliably (it keeps
 * WebAssembly memory out of heapUsed and arrayBuffers), so under Bun memory isn't checked:
 * the check runs in `bun run test`, which is Vitest on Node.
 */
function heapUsed(): number {
  if (typeof process === "undefined" || "Bun" in globalThis) return 0;
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

/** Up to three pages worth looking at: the first, the second and the last. */
function samplePages(count: number): number[] {
  return [...new Set([0, 1, count - 1])].filter((p) => p >= 0 && p < count);
}

/**
 * Run every engine path the app uses on `bytes`, with `engine` (which is left closed and
 * reusable). Returns what went wrong, if anything.
 */
export function driveDocument(
  engine: PdfEngine,
  bytes: Uint8Array,
  options: DriveOptions = {},
): DriveResult {
  const d = new Driver(options.budgetMs ?? 10_000);
  const troublesBefore = engineTroubles();
  const opened = drive(d, engine, bytes, options);
  d.call("close()", () => engine.close());
  const troubled = engineTroubles() > troublesBefore;
  if (!d.dead && !troubled) checkHealth(d, engine, options.healthCheck ?? [HEALTH_CHECK]);
  return { problems: d.problems, calls: d.calls, opened, troubled };
}

function drive(d: Driver, engine: PdfEngine, bytes: Uint8Array, options: DriveOptions): boolean {
  const first = d.call("open()", () => engine.open(bytes.slice()));
  if (!first) return false;
  if (first.needsPassword) {
    d.call("info() while locked", () => engine.info());
    d.call("authenticate(wrong)", () => engine.authenticate("not the password"));
    const unlocked = d.call("authenticate()", () => engine.authenticate(options.password ?? ""));
    if (!unlocked) return false;
  }
  const info = d.call(
    "info()",
    () => engine.info(),
    (i) => {
      if (!Number.isInteger(i.pageCount) || i.pageCount < 0) return `pageCount ${i.pageCount}`;
      if (i.pages.length !== i.pageCount) return "pages doesn't match pageCount";
      if (i.labels.length !== i.pageCount) return "labels don't match pageCount";
      const labelChars = i.labels.reduce((n, l) => n + (l?.length ?? 0), 0);
      if (labelChars > 10_000_000) return `${labelChars} characters of page labels`;
      return null;
    },
  );
  if (!info) return true;
  const pages = samplePages(info.pageCount);

  for (const p of pages) {
    d.call(
      `renderPage(${p})`,
      () => engine.renderPage(p, 0.1),
      (r) => (r.pixels.length === r.width * r.height * 4 ? null : "pixels don't match the size"),
    );
  }
  d.call("search()", () => engine.search("the"));
  d.call("search(rare)", () => engine.search("été 1"));

  for (const p of pages.slice(0, 2)) {
    const text = d.call(`listTextLines(${p})`, () => engine.listTextLines(p));
    if (text) {
      for (const line of text.lines.filter((l) => l.editable).slice(0, 2)) {
        d.call(`checkTextEdit(${p}, ${line.id})`, () =>
          engine.checkTextEdit(p, line.id, line.text, `${line.text} x`),
        );
      }
      for (const para of text.paragraphs.filter((x) => x.editable).slice(0, 1)) {
        d.call(`checkParagraphEdit(${p}, ${para.id})`, () =>
          engine.checkParagraphEdit(p, para.id, para.text, `${para.text} more words here`),
        );
      }
      if (options.deep) {
        const line = text.lines.find((l) => l.editable);
        if (line) {
          const done = d.call(`editTextLine(${p}, ${line.id})`, () =>
            engine.editTextLine(p, line.id, line.text, "Edited"),
          );
          if (done) d.call("undo() text edit", () => engine.undo());
        }
      }
    }
    d.call(`listFields(${p})`, () => engine.listFields(p));
    d.call(`listAnnotations(${p})`, () => engine.listAnnotations(p));
  }
  d.call("listFieldNames()", () => engine.listFieldNames());
  d.call("signatureFields()", () => engine.signatureFields());
  const signatures = d.call("inspectSignatures()", () => engine.inspectSignatures());
  if (signatures && options.onSignatures) {
    d.call("check signatures", () => options.onSignatures?.(signatures));
  }
  d.call("outline (MuPDF)", () => readOutline(bytes, options.password));

  if (pages.length > 0) {
    d.call("exportPage(png)", () => engine.exportPage(0, { format: "png", dpi: 36 }));
    d.call("exportPage(text)", () => engine.exportPage(0, { format: "text" }));
    d.call("exportPage(html)", () => engine.exportPage(0, { format: "html" }));
    if (options.deep) d.call("exportPage(svg)", () => engine.exportPage(0, { format: "svg" }));
  }

  // Page tools, an annotation, then undo them all and redo one.
  const count = info.pageCount;
  let steps = 0;
  const step = (op: string, fn: () => unknown) => {
    if (d.call(op, fn) !== undefined) steps++;
  };
  if (count > 0) {
    step("rotatePages()", () => engine.rotatePages([0], 90));
    step("insertBlankPages()", () => engine.insertBlankPages(1, 1));
    const now = d.call("pageCount", () => engine.pageCount) ?? count;
    if (now > 1) {
      step("movePages()", () => engine.movePages([now - 1], 0));
      step("deletePages()", () => engine.deletePages([0]));
    }
    step("addAnnotation()", () =>
      engine.addAnnotation({
        kind: "rectangle",
        page: 0,
        rect: [1, 1, 5, 5],
        color: [1, 0, 0],
        width: 1,
      }),
    );
  }
  const saved = save(d, engine, "after edits");
  for (let i = 0; i < steps; i++) d.call(`undo() ${i + 1}`, () => engine.undo());
  if (steps > 0) d.call("redo()", () => engine.redo());
  save(d, engine, "after undo");
  if (options.deep && count > 0) {
    d.call("compressedCopy()", () => engine.compressedCopy("balanced"));
  }
  if (saved) reopen(d, saved, options.password);
  return true;
}

/** Save incrementally, or rewrite when the file can't be saved that way (as the app asks). */
function save(d: Driver, engine: PdfEngine, when: string): Uint8Array | undefined {
  let needsRewrite = false;
  const incremental = d.call(`save(incremental) ${when}`, () => {
    try {
      return engine.save({ incremental: true });
    } catch (err) {
      if (err instanceof IncrementalSaveError) {
        needsRewrite = true;
        return undefined;
      }
      throw err;
    }
  });
  const full = d.call(`save(full) ${when}`, () => engine.save({ incremental: false }));
  return needsRewrite ? full : (incremental ?? full);
}

/** A saved file must open again (in a fresh engine) and render. */
function reopen(d: Driver, bytes: Uint8Array, password?: string) {
  const again = new PdfEngine();
  try {
    const opened = d.call("reopen saved", () => again.open(bytes));
    if (!opened) return;
    if (opened.needsPassword) {
      if (!d.call("reopen authenticate", () => again.authenticate(password ?? ""))) return;
    }
    const count = d.call("reopen pageCount", () => again.pageCount) ?? 0;
    if (count > 0) d.call("reopen renderPage(0)", () => again.renderPage(0, 0.1));
  } finally {
    again.close();
  }
}

type Outline = NonNullable<ReturnType<mupdf.Document["loadOutline"]>>;

/** The bookmarks, as MuPDF reads them (the app doesn't show them yet), bounded. */
function readOutline(bytes: Uint8Array, password?: string): number {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (doc.needsPassword() && doc.authenticatePassword(password ?? "") === 0) return 0;
    let seen = 0;
    const walk = (items: Outline | null | undefined, depth: number) => {
      for (const item of items ?? []) {
        if (++seen > 100_000 || depth > 100) return;
        walk(item.down, depth + 1);
      }
    };
    walk(doc.loadOutline(), 0);
    return seen;
  } finally {
    doc.destroy();
  }
}

const HEALTH_CHECK = createBlankPdf(1, 200, 100);

/**
 * The engine must still handle good files after a bad one: open, render, search, read text
 * and fields, and save each. Any error here means the bad file broke the engine.
 */
function checkHealth(d: Driver, engine: PdfEngine, files: readonly Uint8Array[]) {
  try {
    for (const file of files) {
      const opened = engine.open(file.slice());
      if (opened.needsPassword || opened.pageCount < 1) throw new Error("wrong document");
      const page = engine.renderPage(0, 0.3);
      if (page.pixels.length !== page.width * page.height * 4) throw new Error("wrong size");
      engine.search("a");
      engine.listTextLines(0);
      engine.listFields(0);
      engine.rotatePages([0], 90);
      engine.save({ incremental: true });
      engine.close();
    }
  } catch (err) {
    try {
      engine.close();
    } catch {
      // Broken already; reported below.
    }
    d.problems.push({
      kind: "engine-broken",
      op: "open a good file afterwards",
      message: err instanceof Error ? err.message : String(err),
    });
    d.dead = true;
  }
}
