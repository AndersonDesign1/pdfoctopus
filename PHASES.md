# PDFoctopus: Phase Tracker

This file tracks every phase from an empty repo to public launch. Each phase lists the exact
tasks needed to finish it and the **exit criteria** that must be true before we move on.

**How to use it**

- Tick a box (`- [x]`) in the same PR that finishes the task.
- Update the phase's status in the overview table when it starts or finishes.
- A phase is ✅ Done only when every task **and** every exit criterion is ticked.

**Status key:** ⬜ Not started · 🟨 In progress · ✅ Done · ⏸️ Blocked

---

## Next up

Start here if you're picking the project up. Do these in order, and update this list in the
same PR that changes it. Last updated: 2026-11-18, after images.

### 0. Keep `main` green (2026-11-18)

A docs commit pushed straight to `main` on 2026-11-10 failed the formatting check, so `main`
and every PR based on it (including Dependabot #11) were red for a week. Fixed, and to stop it
happening again: `CLAUDE.md` and CONTRIBUTING.md now say every change goes through a PR and
is merged only with green CI, and `bun install` sets up a pre-push hook that refuses pushes
to `main` and runs lint and typecheck. The hook is only a local guardrail (`--no-verify`
skips it). The real enforcement is branch protection, so, **for the repo owner:** in the
`main` branch protection settings, turn on "Do not allow bypassing the above settings" and
require the `web`, `desktop` and `signatures` checks, so admins can't skip them either.

### 1. Dependabot PRs: done (2026-11-07)

- Merged: #4 (`actions/checkout` 4 → 7), #5 (`playwright` 1.64.1) and #7 (TypeScript 7.0).
  TypeScript 7 was checked locally first: `tsc --version` reports 7.0.2, typecheck, tests and
  the Vite build pass, and a deliberate type error is still caught.
- #3 (`actions/setup-python` 5 → 7) conflicted with #4, so the same one-line bump was made in
  the PR that updated this section, and #3 was closed.
- #6 (`@types/node` 22 → 26) was closed. `.github/dependabot.yml` now ignores major updates
  to `@types/node`: the types must match the Node version we run (22), so bump them together
  with Node.
- **Cloudflare preview builds fail on every branch (cause found 2026-11-18).** The build log
  shows the dashboard's _build command_ is `npx wrangler deploy`, so nothing is built and
  wrangler stops because `apps/web/dist` doesn't exist. **For the repo owner**, in Workers &
  Pages → pdfoctopus → Settings → Build: set the build command to `bun run build`, keep the
  deploy command `npx wrangler deploy`, and leave the Preview command at its default,
  `npx wrangler preview`, so branches get previews and can never deploy to the live site.

From now on, Dependabot opens a few PRs each week. Merge minor and patch updates once CI is
green. Test major updates locally first, as was done for TypeScript 7.

### 2. Finish Phase 1: the last exit check (needs a person)

Page tools, undo/redo, the UI and saving are done (2026-11-10). What's left is a manual
check that can't run in CI:

- Work through the checklist in [TESTING.md](./TESTING.md): every page tool, saving, and
  opening the saved files in **Adobe Reader** and the **Chrome/Edge and Firefox** viewers.
  Opening, scrolling and saving a file on the live site was checked on 2026-11-10.
- Once that passes, tick the last Phase 1 exit criterion and mark Phase 1 ✅ Done.
- Follow-up for later (not part of Phase 1): make the first Save write back to the opened
  file. See "Follow-ups" in TESTING.md.

What was built, for reference:

- **Engine** (`packages/core/src/engine.ts`): `rotatePages`, `deletePages`, `movePages`,
  `insertBlankPages` and `insertPdfs` (merge = insert at the end) are each one undoable
  step; `extractPages` and `splitPages` make new PDFs and leave the document unchanged.
  The history keeps the removed page objects themselves, not copies of the document.
  Range helpers are in `pageRanges.ts`. `fixtures.test.ts` runs every tool, undo, redo and
  save over every fixture that opens as a PDF, and checks that the one that isn't really a
  PDF (an HTML file) is refused cleanly.
- **UI:** select pages in the thumbnails (click, Ctrl/Cmd-click, Shift-click, Ctrl+A,
  Escape) and drag them to reorder (`viewer/Thumbnails.tsx`, `viewer/selection.ts`). Page
  tools and undo/redo are in the second toolbar row; tools act on the selection, or the
  current page when nothing is selected. Split and merge/insert dialogs are in
  `ui/Dialogs.tsx`. After each edit the renderer is replaced so no stale bitmaps show.
- **Saving:** "Save" writes back to the file chosen at the first save (desktop, and
  Chrome/Edge); "Save as" always asks. Split writes all parts into a chosen folder, or
  downloads them in other browsers. The app warns before closing with unsaved changes.
- **Known gaps:** page labels aren't renumbered after moving or deleting pages; the
  desktop folder picker for split (`dialog:allow-open`) hasn't been tried on Windows yet.

### 3. Admin tasks still open from Phase 0

The domain, SignPath, Oracle Cloud and the trademark check (see
[Phase 0](#phase-0-foundations)). Also confirm the exit criteria on a real Windows machine:
`bun run desktop`, and "Open with" for PDFs, which has only been compiled so far.

### 4. Phase 2: simple signatures done (2026-11-18)

Sign, Initials and Date are on the page tools toolbar. Signatures can be drawn (smoothed,
with pen pressure), typed in one of three handwriting fonts, or uploaded as a photo or scan
with the paper removed. They can be remembered on the device. Each one is placed as a box you
drag and resize (or move with the arrow keys), then applied as one undoable step.

- **Engine:** `addImageStamp` in `packages/core/src/engine.ts` adds a stamp annotation with
  the image, so the page's own content isn't touched and saving only appends. On rotated
  pages the appearance is turned back so it's upright as shown. Undo takes the annotation off
  the page and redo puts the same object back. Saves now use MuPDF's `compress` option,
  because MuPDF stores stamp images as raw pixels (a signature added ~1.7 MB before).
  Tests: `stamps.test.ts`, and the fixture sweep stamps every editable fixture.
- **UI:** `apps/web/src/sign/` (dialog, drawing pad, placement box, and the pure helpers in
  `ink.ts`, which are unit-tested). Fonts come from `@fontsource` (SIL OFL), Latin subsets only.
- **Checked:** in Chromium end to end (draw, type, upload, place, apply, undo, save), and the
  saved files render correctly in pdf.js (Firefox's viewer), on a rotated page too.
- **Still to check by hand:** see the Phase 2 list in [TESTING.md](./TESTING.md), mainly how
  the signed files look and print in Adobe Reader.

### Saving more than once was broken (fixed 2026-11-18)

Found while checking Dependabot #11: after the first save in a session, MuPDF wrote later
updates as if the first had been appended to the original file, so their trailer (`/Prev`)
pointed at a section that wasn't there. A second save after an edit needed repair to open (and
would break existing signatures); a second save with no edit didn't open at all. Every save is
now the original bytes plus one update holding every change, pointing back at the original's
cross-reference section (`fixUpdatePrev` in `engine.ts`). `save.test.ts` covers it, and the
fixture sweep now saves every file twice and checks MuPDF doesn't have to repair it.

**MuPDF stays on 1.28.1 for now.** 1.28.6 (in Dependabot #11) fails those tests and destroys an
undone annotation when saving; `.github/dependabot.yml` skips that version. The rest of #11's
updates (Biome, Playwright, Turbo, Wrangler, Vite, the React plugin) are in PR #14, with the
Markdown reformat Biome 2.6.6+ needs. #11 can be closed.

### 5. Phase 2: annotation tools (2026-11-18)

An **Annotate** toolbar row has Highlight, Underline, Strikethrough, Pen, Rectangle, Ellipse,
Line, Arrow, Note, Text box and White-out, with a colour and a line width. Pick a tool, then
drag (or click, for notes and text boxes) on the page; Escape puts the tool down. Each
annotation is one undoable step.

- **Engine:** `addAnnotation` and `selectText` in `packages/core/src/engine.ts`. Text markup
  uses MuPDF's text layout, so a drag selects text the way a cursor would; it's cached per page
  and dropped on every edit. Bad input is checked before anything is created. A sticky note's
  pop-up annotation comes and goes with it on undo/redo. Tests: `annotations.test.ts`, and the
  fixture sweep adds a rectangle and a note to every editable fixture.
- **UI:** `apps/web/src/annotate/` (`tools.ts` with the unit-tested geometry, and
  `AnnotateLayer.tsx`, drawn over each page while a tool is picked, with live previews).
- **Checked:** every tool end to end in Chromium, and the saved file in pdf.js.
- **White-out only covers.** The text underneath is still in the file. True removal is
  redaction, further down Phase 2.

### 6. Phase 2: editing and deleting annotations (2026-11-18)

The **Select** tool, first in the Annotate row, selects markup annotations (highlights,
drawings, shapes, notes, text boxes, stamps and the like), including ones made in other apps
and signatures saved in an earlier session. Links, form fields, hidden annotations and note
pop-ups aren't listed. Drag it to move it, drag
its corner to resize it, pick a colour, edit a note's or text box's text, or delete it (the
Delete button or key). Arrow keys move it by a point, or ten with Shift. Each change is one
undoable step.

- **Engine:** `listAnnotations`, `editAnnotation` and `deleteAnnotation` in
  `packages/core/src/engine.ts`, helpers in `annotationObjects.ts`. Moving shifts the
  annotation's geometry (/Rect, /QuadPoints, /InkList, /L, /Vertices, /CL, and a note pop-up's
  /Rect) and keeps its appearance, so it looks the same afterwards, even when MuPDF couldn't
  draw it. Resizing scales a stamp's appearance and has MuPDF
  redraw shapes and text boxes. Recolouring and text-box edits delete the appearance first,
  so MuPDF draws a new stream instead of overwriting the old one in place (which it does, and
  which would break undo). Undo restores a copy of the changed dictionary entries. Deleting a
  note takes its pop-up too, and undo puts them back in the same place in the stacking order.
  Tests: `annotationEdit.test.ts`, and the fixture sweep moves, recolours, edits and deletes on
  every editable fixture.
- **UI:** `apps/web/src/annotate/SelectLayer.tsx`, with the geometry in `edit.ts`
  (unit-tested).
- **Checked:** in Chromium end to end (select, move, resize, recolour, nudge, delete, undo,
  edit text, save), and the saved file in pdf.js.
- **Not yet:** resizing drawings, lines and highlights (they can be moved, recoloured and
  deleted), changing line width, and selecting several annotations at once. Signatures and
  other stamps PDFoctopus adds are marked "locked" for other apps, but PDFoctopus itself can
  still move and delete them.

### 7. Phase 2: stamps (2026-11-18)

**Stamp**, next to Sign, Initials and Date, opens a dialog. Pick a stamp (Approved, Not
approved, Draft, Confidential, Final, Reviewed, Paid, Received) or type your own words, pick a
colour, and optionally add a second line: a date (one click for today's) or a name. Then
place it like a signature: drag it, resize it, Apply. It can be selected, moved, resized and
deleted afterwards like any annotation.

- **Engine:** `addTextStamp` in `packages/core/src/engine.ts`, drawing in `textStamp.ts`, and
  the limits, names and layout in `stampRules.ts` (no MuPDF there, so the app shares the
  layout for its preview). A stamp is a Stamp annotation with its own appearance: a rounded
  border, the main line in Helvetica Bold and the optional second line in Helvetica, drawn as
  vector graphics, scaled to fit its box without
  stretching, and turned upright on a rotated page. Stamps that say a standard name get it as
  /Name (/Approved, /Draft, …) so other apps know what they are. MuPDF's `update()` resizes a
  stamp's box to fit its stock "Draft" look, so the box is put back afterwards. Tests:
  `textStamp.test.ts` (including that a stamp on a rotated page looks the same as on an
  unrotated one), and the fixture sweep stamps every editable fixture.
- **UI:** `apps/web/src/sign/StampDialog.tsx`, the preview in `textStampPreview.ts`.
- **Checked:** in Chromium end to end, on a rotated page too, and the saved file in pdf.js.
- **Limits:** the standard fonts cover printable Latin-1 only (Latin letters with their accents,
  digits and common punctuation), so text in other scripts (or symbols such as ✓) is refused
  with a message, and "Today's date" falls back to English in locales that write dates in other
  scripts; embedding a font would lift that. Custom stamps aren't
  remembered between sessions yet.

### 8. Phase 2: images (2026-11-18)

**Image**, next to Stamp, puts a picture on the page: a logo, a photo, a screenshot. Choose a
PNG, JPEG, WebP, GIF, BMP or AVIF file, or drop one onto the open document (a dropped PDF
still opens instead). Then place it like a signature: drag, resize, Apply. Afterwards it can be
selected, moved, resized (keeping its proportions) and deleted.

- **In the browser** (`pictureToImage` in `apps/web/src/sign/stampImage.ts`): the camera's
  orientation is applied, pictures are scaled down to 2,400 pixels on their longer side, photos
  become JPEG and pictures with transparency (and PNG or GIF files) stay PNG. Anything still
  over the engine's 10 MB limit is made smaller. Nothing leaves the device.
- **Engine:** the existing `addImageStamp` with kind `image`. Unlike signatures, pictures
  aren't marked "locked", so other apps let them be moved too. New tests: a JPEG photo is
  drawn where it was placed and saved compressed, and pictures aren't locked.
- **Size:** a new picture fits a 220-point square (a portrait photo isn't page-high).
- **Checked:** in Chromium end to end: a sideways camera photo comes in upright, a transparent
  PNG dropped on the page keeps its transparency, a file that isn't a picture gets a message;
  the saved file in pdf.js.
- **Next in Phase 2:** redaction, then forms.

### Where things are

- **Engine:** `packages/core` (MuPDF in a Web Worker, plus a promise-based client). Tests:
  `bun run test` (Vitest, Node).
- **Viewer:** `apps/web/src/viewer`. Layout maths is in `layout.ts` (unit-tested), render
  scheduling in `renderQueue.ts`, and the bitmap cache in `renderer.ts`.
- **App shell, toolbar and shortcuts:** `apps/web/src/App.tsx`. Dialogs:
  `apps/web/src/ui/Dialogs.tsx`.
- **Desktop:** `apps/desktop/src-tauri` (Tauri v2; the Rust commands are in `src/lib.rs`).
- **Before every PR:** run `bun run check` and sign off every commit with `git commit -s`.
  CI, DCO, Socket and the cubic review all run on each PR, and Cloudflare deploys a preview.

---

## Overview

| #   | Phase                                                             | Estimate | Status         |
| --- | ----------------------------------------------------------------- | -------- | -------------- |
| 0   | [Foundations](#phase-0-foundations)                               | 1–2 wks  | 🟨 In progress |
| 1   | [Core viewer + page tools](#phase-1-core-viewer--page-tools)      | 2–3 wks  | 🟨 In progress |
| 2   | [Sign, annotate & forms](#phase-2-sign-annotate--forms)           | 3–4 wks  | 🟨 In progress |
| 3   | [Security, compress & create](#phase-3-security-compress--create) | 2–3 wks  | ⬜ Not started |
| 4   | [Conversion](#phase-4-conversion)                                 | 2–3 wks  | ⬜ Not started |
| 5   | [Certificate signatures](#phase-5-certificate-signatures-pades)   | 2–3 wks  | ⬜ Not started |
| 6   | [True text editing](#phase-6-true-text-editing)                   | 4–8+ wks | ⬜ Not started |
| 7   | [Polish & launch](#phase-7-polish--launch)                        | 2–3 wks  | ⬜ Not started |
| —   | [Later (post-launch)](#later-post-launch)                         | —        | ⬜ Not started |

---

## Phase 0: Foundations

**Goal:** a working monorepo where the web and desktop apps both open, render and save a PDF.

### Accounts & admin

- [ ] Choose and register the domain (`pdfoctopus.com` or `pdfoctopus.fyi`) on Cloudflare.
      Until then, the web app will be served from `pdfoctopus.josanderson25.workers.dev` (Cloudflare Workers)
- [ ] Apply to SignPath's free code-signing program for open source
- [ ] Create an Oracle Cloud account and try to claim an Always Free ARM VM
- [ ] Quick trademark check on the name before any commercial use

### Repository

- [x] GitHub repo created
- [x] `LICENSE` file (AGPL-3.0-or-later)
- [x] `README.md` describing the project
- [x] `CONTRIBUTING.md` with DCO sign-off instructions
- [x] `PHASES.md` (this file)
- [x] Enable a DCO check on pull requests (e.g. the DCO GitHub App)
- [x] Branch protection on `main` (require CI + review)
- [x] Issue and PR templates

### Monorepo & tooling

- [x] Bun + Turbo monorepo with workspaces
- [x] `apps/web`: Vite + React + TypeScript
- [x] `apps/desktop`: Tauri v2 shell pointing at `apps/web`
- [x] `packages/core`, `packages/sign`, `packages/ui` scaffolded
- [x] `services/convert` placeholder (Docker Compose)
- [x] `fixtures/` folder
- [x] Shared TypeScript config
- [x] Linting + formatting (Biome)
- [x] Test runner (Vitest)
- [x] CI on GitHub Actions: lint, typecheck, test, build
- [x] `SPDX-License-Identifier: AGPL-3.0-or-later` header in every source file
- [x] "Source code" link in the app footer (AGPL network clause)

### PDF engine

- [x] `mupdf` (WebAssembly) installed in `packages/core`
- [x] MuPDF runs inside a Web Worker
- [x] Open a PDF and render page 1 in the web app
- [x] Save a PDF back to disk (download in web, native save in desktop)
- [x] Lazy-load the WebAssembly with a loading/progress indicator
- [x] Cache the WebAssembly with a service worker
- [x] Recover gracefully if the worker crashes on a bad file

### Test files

- [x] Collect 30+ real-world PDFs in `fixtures/` (invoices, contracts, forms, scans, CJK,
      encrypted, signed, very large, malformed)
- [x] Document the source and licence of each fixture

### Exit criteria

- [ ] `bun install && bun run dev` opens the web app and renders a PDF
- [ ] `bun run desktop` opens the same app in a native Windows window
- [ ] CI is green on `main`

---

## Phase 1: Core viewer + page tools

**Goal:** a fast, pleasant viewer and every page-level operation.

### Viewer

- [x] Open files by drag-and-drop, file picker and (desktop) "Open with"
- [x] Render all pages with virtual scrolling (only visible pages rendered)
- [x] Zoom (fit width, fit page, custom %) and pinch-to-zoom
- [x] Thumbnail sidebar
- [x] Text search with highlighted results and next/previous
- [x] Page navigation (go to page, keyboard shortcuts)
- [x] Dark mode
- [x] Show document properties (title, author, page count, size)

### Page tools

- [x] Merge multiple PDFs
- [x] Split by range, every N pages, or into single pages
- [x] Reorder pages by drag-and-drop in the thumbnail view
- [x] Rotate pages
- [x] Delete pages
- [x] Insert pages (blank or from another PDF)
- [x] Extract pages into a new PDF
- [x] Undo / redo for all page operations

### Saving

- [x] Incremental save by default (edits appended, original bytes untouched)
- [x] When a file can't be saved incrementally, ask the user before rewriting it
- [x] Automated test: the original bytes stay identical after an incremental save
- [x] "Save as" a new file

### Exit criteria

- [x] Every page tool works on all `fixtures/` without crashing
- [x] A 500-page PDF scrolls smoothly
- [ ] Saved files open correctly in Adobe Reader and a browser PDF viewer

---

## Phase 2: Sign, annotate & forms

**Goal:** everyday signing, markup and form filling.

### Simple signatures

- [x] Draw a signature (mouse, pen, touch) with smoothing
- [x] Type a signature with a choice of handwriting fonts
- [x] Upload a signature image
- [x] Automatic background removal for photos of paper signatures
- [x] Save signatures and initials for reuse (stored locally)
- [x] Date stamps
- [x] Place, resize and move signatures on the page

### Annotations

- [x] Highlight, underline, strikethrough
- [x] Sticky-note comments
- [x] Freehand drawing
- [x] Shapes (rectangle, ellipse, line, arrow)
- [x] Add text boxes and images (overlay edits)
- [x] White-out
- [x] Stamps (Approved, Draft, Confidential, custom)
- [x] Edit and delete existing annotations

### Redaction

- [ ] Mark areas or search results for redaction
- [ ] Apply redactions (true removal of text and images underneath, not black boxes)
- [ ] Test: redacted text can't be found or copied afterwards

### Forms

- [ ] Fill AcroForm fields (text, checkbox, radio, dropdown, date)
- [ ] Create new fields: text, checkbox, radio, dropdown, signature, date
- [ ] Edit field properties (name, required, default value)
- [ ] Flatten forms
- [ ] Detect XFA forms and show a clear warning

### Exit criteria

- [ ] Signed, annotated and filled PDFs display correctly in Adobe Reader
- [ ] Redaction verified as true removal on all relevant fixtures

---

## Phase 3: Security, compress & create

**Goal:** passwords, smaller files and making new PDFs.

### Password & permissions

- [ ] Add an open password (AES-256)
- [ ] Remove a password (when the user knows it)
- [ ] Set permissions: print, copy, edit, annotate, fill forms, assemble
- [ ] Verify output with qpdf (opens with password, refuses without, reports AES-256)
- [ ] Verify output in Adobe Acrobat and Adobe Reader

### Compress

- [ ] Presets: High quality, Balanced, Smallest
- [ ] Image downsampling for the "Smallest" preset
- [ ] Show file size before and after
- [ ] Optional "optimise and rebuild" save

### Create

- [ ] Blank PDF (choose page size and count)
- [ ] Images → PDF (JPG, PNG, multiple images, page order)
- [ ] HTML → PDF
- [ ] Plain text → PDF
- [ ] Markdown → PDF

### Exit criteria

- [ ] Encrypted files open in Acrobat with the password and are refused without it
- [ ] Compression never makes a file larger (fall back to the original if it would)

---

## Phase 4: Conversion

**Goal:** get content out of PDFs and Office files into PDFs.

### PDF → other formats (in the browser)

- [ ] PDF → PNG / JPG (choose resolution, pages)
- [ ] PDF → HTML
- [ ] PDF → plain text
- [ ] PDF → SVG
- [ ] Download multiple outputs as a ZIP

### PDF → Word (DOCX / ODT), labelled "beta"

- [ ] Desktop: native MuPDF via the Rust layer
- [ ] Web: send to the conversion server with explicit opt-in consent
- [ ] Clear note that tables may come through as plain text

### Office → PDF (Word, Excel, PowerPoint)

- [ ] Desktop: use the installed Microsoft Office (COM automation)
- [ ] Desktop fallback when Office isn't installed: conversion server
- [ ] Web: conversion server (Gotenberg) with explicit opt-in consent

### Conversion server

- [ ] Oracle Cloud ARM VM provisioned
- [ ] Docker Compose stack: Gotenberg + small native MuPDF DOCX service
- [ ] Cloudflare Tunnel in front of the server
- [ ] Cloudflare Access in front of the tunnel. The Access service token never ships in the
      browser or desktop app: both call a small PDFoctopus Worker (on Cloudflare Workers),
      which holds the token and forwards the request to the tunnel
- [ ] Disable Gotenberg routes the app doesn't use (e.g. Chromium URL fetching)
- [ ] Files deleted immediately after conversion; no request logging of file contents
- [ ] Size limits, timeouts and rate limiting
- [ ] Rebuild-from-scratch instructions (server is stateless)
- [ ] Health check / uptime monitoring

### Exit criteria

- [ ] Every conversion works on representative fixtures
- [ ] The web app never uploads a file without the user's explicit consent
- [ ] The desktop app converts fully offline when Office is installed

---

## Phase 5: Certificate signatures (PAdES)

**Goal:** legally meaningful digital signatures that validate in Adobe Reader.

### Signing engine (`packages/sign`)

- [ ] Create a signature field and reserve space for the signature with MuPDF
- [ ] Build the CMS / PKCS#7 signature with PKI.js
- [ ] Follow the PAdES baseline (B-B) profile
- [ ] Optional: trusted timestamp (B-T) via a public timestamp server
- [ ] Always save incrementally so earlier signatures stay valid
- [ ] Link the visible signature appearance to the cryptographic signature

### Certificate sources

- [ ] Web: load a `.p12` / `.pfx` file and sign in the browser (WebCrypto + PKI.js)
- [ ] Desktop: Windows certificate store (Rust)
- [ ] Desktop: USB smart cards / tokens (Rust)

### Validation

- [ ] Signature panel listing signatures in a document and whether each is valid
- [ ] Detect if a document was changed after signing

### Exit criteria

- [ ] Adobe Reader's signature panel shows "valid" for our signatures
- [ ] A second signature added later leaves the first one valid

---

## Phase 6: True text editing

**Goal:** edit existing text in place without breaking the layout. This is our differentiator.

### Step 1: single-line edits

- [ ] Find text runs with structured-text extraction
- [ ] Click-to-edit a line of text
- [ ] Check the embedded font has the glyphs needed
- [ ] Replace the run in the page content using the same embedded font
- [ ] Fall back to the closest system font by metrics when glyphs are missing, and warn the user

### Step 2: paragraph reflow

- [ ] Detect paragraphs and their bounding boxes
- [ ] Reflow text inside the paragraph's box without shifting anything else on the page
- [ ] Warn when edited text no longer fits

### Step 3: complex layouts

- [ ] Multi-column text
- [ ] Right-to-left and CJK text

### Quality

- [ ] Regression tests against every fixture (render before/after and compare)
- [ ] Clear in-app explanation of what can and can't be edited

### Exit criteria

- [ ] Single-line and paragraph edits work on invoices and contracts in `fixtures/`
- [ ] No edit ever changes content outside the edited paragraph

---

## Phase 7: Polish & launch

**Goal:** a trustworthy v1 that people can install and use.

### Quality

- [ ] Fuzz the engine with malformed PDFs; no crashes reach the user
- [ ] Accessibility pass (keyboard navigation, screen readers, contrast)
- [ ] Performance pass (startup time, large files, memory use)
- [ ] Final check of every feature in Adobe Reader / Acrobat

### Desktop release

- [ ] Windows installer (MSI / NSIS)
- [ ] Code signing (SignPath or paid certificate)
- [ ] Auto-update
- [ ] Release pipeline on GitHub Actions publishing to GitHub Releases

### Web release

- [x] GitHub repo connected to Cloudflare Workers Builds (auto-deploys `main`)
- [x] First successful deploy of the web app from `main`
- [x] Live at `pdfoctopus.josanderson25.workers.dev` (temporary address)
- [ ] Point the chosen domain at it once registered
- [ ] Offline support (service worker)

### Docs & site

- [ ] Landing page on the chosen domain
- [ ] User guide / FAQ
- [ ] Privacy statement (what stays local, what is uploaded and when)
- [ ] Screenshots and a short demo video

### Launch

- [ ] Decide on telemetry (none, or opt-in crash reports only)
- [ ] Set up GitHub Sponsors / donations (optional)
- [ ] Post on GitHub, Product Hunt, Hacker News ("Show HN"), Reddit (r/opensource, r/sysadmin)

### Exit criteria

- [ ] Signed Windows installer installs without a SmartScreen warning
- [ ] Web app live on the chosen domain
- [ ] v1.0.0 tagged and released

---

## Later (post-launch)

- [ ] OCR for scanned PDFs (Tesseract)
- [ ] PDF → Excel tables
- [ ] PDF/A (archival) output
- [ ] Batch processing
- [ ] Command-line tool
- [ ] macOS and Linux desktop builds
- [ ] Our own WebAssembly build with DOCX output (removes the server for web DOCX)
- [ ] Translations / non-English UI

## Open questions

- [ ] Monetisation later? (donations, GitHub Sponsors, paid support for businesses)
- [ ] macOS/Linux desktop builds in v1 or later?
- [ ] Translations in v1?
- [ ] Telemetry: none, or opt-in anonymous crash reports only?
