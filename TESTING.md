# Manual tests

Checks that can't run in CI and need a person. Tick a box (`- [x]`) once it passes. If one
fails, write down what happened (file, browser, what you did) under **Problems found**.

Use the live app at <https://pdfoctopus.josanderson25.workers.dev> (it updates when `main`
changes). Test files are in [`fixtures/`](./fixtures); `fixtures/generated/` has small ones
to start with.

## Phase 1: page tools and saving

These close the last Phase 1 exit criterion in [PHASES.md](./PHASES.md).

### Already checked

- [x] Open a PDF, scroll through it and save it (2026-11-10)

### Page tools (web app)

Open `fixtures/generated/contract-libreoffice.pdf` (or any PDF with a few pages), then:

- [ ] **Select:** click a thumbnail, Ctrl-click (Cmd on a Mac) another, Shift-click a range,
      Ctrl+A for all, Escape to clear
- [ ] **Rotate** left and right: the page and its thumbnail both turn
- [ ] **Delete** a page with the button, and with the Delete key in the page list
- [ ] **Drag to reorder:** drag a page (and a selection of pages) to a new place; the purple
      line shows where they'll land
- [ ] **Blank page:** inserted after the current page, the same size as its neighbour
- [ ] **Insert PDF:** add pages from another PDF after the current page
- [ ] **Merge:** add two PDFs at the end, reordering them in the dialog first. Include
      `fixtures/generated/encrypted-aes256.pdf` (password `open-sesame`): it should ask for
      the password
- [ ] **Extract:** select two pages and extract them; the new file has just those pages
- [ ] **Split:** try "Pages" (e.g. `1-2, 3`), "Every 2 pages" and "Every page"; each part
      opens and has the right pages. Run the same split twice into the same folder: the second
      run adds numbered files instead of replacing the first ones
- [ ] **Undo / redo** every tool above, with the buttons and with Ctrl+Z / Ctrl+Y

### Saving

- [ ] **Save** after editing: the first time it asks where to save; the next Save writes to
      the same file without asking (Chrome/Edge)
- [ ] **Save as** always asks
- [ ] The dot next to Save appears after an edit and goes away after saving
- [ ] Opening another PDF with unsaved edits asks first; Cancel keeps your edits
- [ ] Closing the tab with unsaved edits shows the browser's "leave site?" warning

### Open the saved files elsewhere

Take a file you edited with several tools above and saved, and open it in:

- [ ] **Adobe Acrobat Reader**: pages, order and rotation look right, no error messages
- [ ] **Chrome or Edge** PDF viewer
- [ ] **Firefox** PDF viewer
- [ ] **Signed file:** open `fixtures/generated/signed.pdf`, rotate a page, save, and open it
      in Adobe Reader's signature panel. The original signature should still be listed (the
      save only adds to the end of the file). Write down exactly what Reader says about it:
      changing a signed file can be reported as "modified after signing", and that wording
      tells us how Phase 5 should handle it

### Desktop app (Windows)

- [ ] `bun run desktop` opens the app in a native window
- [ ] "Open with" PDFoctopus on a PDF opens it
- [ ] Save writes the file; Split asks for a folder and writes the parts there

## Problems found

_None yet._

## Follow-ups (not bugs)

- **First Save writes back to the opened file.** Today the first Save asks where to save,
  because a file opened from the file picker or by drag-and-drop can't be written back to.
  Doing it needs `showOpenFilePicker` in Chrome/Edge and the file's path on desktop. Planned
  for later.
- **Page labels** (like "i, ii, 1, 2") aren't renumbered after pages are moved or deleted.
