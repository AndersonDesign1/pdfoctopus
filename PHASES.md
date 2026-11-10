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
same PR that changes it. Last updated: 2026-11-10, after the page tools and saving work.

### 1. Dependabot PRs: done (2026-11-07)

- Merged: #4 (`actions/checkout` 4 → 7), #5 (`playwright` 1.64.1) and #7 (TypeScript 7.0).
  TypeScript 7 was checked locally first: `tsc --version` reports 7.0.2, typecheck, tests and
  the Vite build pass, and a deliberate type error is still caught.
- #3 (`actions/setup-python` 5 → 7) conflicted with #4, so the same one-line bump was made in
  the PR that updated this section, and #3 was closed.
- #6 (`@types/node` 22 → 26) was closed. `.github/dependabot.yml` now ignores major updates
  to `@types/node`: the types must match the Node version we run (22), so bump them together
  with Node.
- **Open question for the repo owner:** the Cloudflare **Workers Builds** check fails
  instantly on every Dependabot branch, without running the build, while it passes on our own
  branches and on `main`. It's only the preview check and isn't required, but check the
  build's log in the Cloudflare dashboard (Workers & Pages → pdfoctopus → Builds) to see why.
  It may be the setting for which branches get preview builds.

From now on, Dependabot opens a few PRs each week. Merge minor and patch updates once CI is
green. Test major updates locally first, as was done for TypeScript 7.

### 2. Finish Phase 1: the last exit check (needs a person)

Page tools, undo/redo, the UI and saving are done (2026-11-10). What's left is a manual
check that can't run in CI:

- Open a PDF in the web app, use every page tool (rotate, delete, drag to reorder, blank
  page, insert PDF, merge, extract, split, undo and redo), save it, and open the result in
  **Adobe Reader** and in a **browser's PDF viewer** (Chrome or Edge, and Firefox). Also try
  a signed fixture: the earlier signature should still show as valid in Adobe Reader.
- Once that passes, tick the last Phase 1 exit criterion and mark Phase 1 ✅ Done.

What was built, for reference:

- **Engine** (`packages/core/src/engine.ts`): `rotatePages`, `deletePages`, `movePages`,
  `insertBlankPages`, `insertPdfs` (merge = insert at the end), `extractPages` and
  `splitPages`, each one undoable step. The history keeps the removed page objects
  themselves, not copies of the document. Range helpers are in `pageRanges.ts`.
  `fixtures.test.ts` runs every tool, undo, redo and save over every fixture.
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
| 2   | [Sign, annotate & forms](#phase-2-sign-annotate--forms)           | 3–4 wks  | ⬜ Not started |
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

- [ ] Draw a signature (mouse, pen, touch) with smoothing
- [ ] Type a signature with a choice of handwriting fonts
- [ ] Upload a signature image
- [ ] Automatic background removal for photos of paper signatures
- [ ] Save signatures and initials for reuse (stored locally)
- [ ] Date stamps
- [ ] Place, resize and move signatures on the page

### Annotations

- [ ] Highlight, underline, strikethrough
- [ ] Sticky-note comments
- [ ] Freehand drawing
- [ ] Shapes (rectangle, ellipse, line, arrow)
- [ ] Add text boxes and images (overlay edits)
- [ ] White-out
- [ ] Stamps (Approved, Draft, Confidential, custom)
- [ ] Edit and delete existing annotations

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
