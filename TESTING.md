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

## Phase 2: signatures

Open `fixtures/generated/contract-libreoffice.pdf`, then:

- [ ] **Draw:** Sign → Draw with a mouse; on a touch screen or tablet with a finger; with a
      pen (strokes get thicker when you press harder). Undo stroke and Clear work
- [ ] **Type:** your name in each of the three styles, in black and in blue
- [ ] **Upload:** a phone photo of a signature on paper. With "Remove the paper background"
      the paper disappears and the ink stays; without it, the photo is placed as it is
- [ ] **Remember on this device:** the signature is offered under "Saved" next time, also
      after reloading the page; ✕ forgets it. Initials are saved separately from signatures
- [ ] **Initials** and **Date** (today's date, written the way your system writes dates)
- [ ] **Place:** the stamp appears in the middle of what's on screen; drag it, resize it from
      the corner (it keeps its shape), click another spot or another page to move it there;
      arrow keys move it (Shift for bigger steps), + and − resize, Enter applies, Escape cancels
- [ ] **Rotated page:** rotate a page, then sign it: the signature is upright as you see it
- [ ] **Undo / redo** a signature with the buttons and Ctrl+Z / Ctrl+Y
- [ ] **Saved file in Adobe Acrobat Reader:** signature, initials and date show in the right
      places, upright on rotated pages, with see-through backgrounds, and **print**. Reader lists
      them as stamps in the comments panel; they shouldn't be movable there (they're locked)
- [ ] **Saved file in Chrome/Edge** and **Firefox** PDF viewers
- [ ] **File size:** signing adds tens of kilobytes, not megabytes
- [ ] **Signed file:** sign `fixtures/generated/signed.pdf` and check Reader's signature panel
      still lists the original certificate signature (it will say the file changed after signing)

## Phase 2: annotations

Open `fixtures/generated/contract-libreoffice.pdf`, then use each tool in the **Annotate** row:

- [ ] **Highlight, Underline, Strikethrough:** drag across a few words, and across two lines;
      the preview follows the text. On a scanned page (`fixtures/generated/scanned-invoice.pdf`)
      it says there's no text to mark
- [ ] **Pen:** draw with a mouse, a finger and a pen
- [ ] **Rectangle, Ellipse, Line, Arrow:** drag in each direction; try each colour and width
- [ ] **Note:** click, type, then Add (or Ctrl+Enter); Escape cancels. Near the page's right
      and bottom edges the editor stays on the page
- [ ] **Text box:** drag a box (or just click) and type
- [ ] **White-out:** covers what's underneath (it doesn't delete it)
- [ ] **Rotated page:** rotate a page, then use a few tools on it; everything lands where drawn
      and the text box reads the right way up
- [ ] **Undo / redo** each one. Escape closes an open note or text box editor; Escape again
      puts the tool down
- [ ] **Saved file in Adobe Acrobat Reader:** all annotations show in the comments list, the
      note opens with its text, everything prints. Also in **Chrome/Edge** and **Firefox**

### Editing and deleting annotations

Pick the **Select** tool (first in the Annotate row):

- [ ] Click each kind of annotation to select it, including thin lines and a highlight
- [ ] **Move:** drag it; also press and drag in one go on an unselected one; arrow keys move it
      by 1 point (10 with Shift) and never change the page
- [ ] **Resize:** drag the corner of a rectangle, ellipse, text box, white-out box and signature
      (a signature keeps its proportions)
- [ ] **Colour:** change a highlight's, a drawing's and a text box's colour
- [ ] **Text:** Edit text (or double-click, or Enter) on a note and a text box, then Save
- [ ] **Delete:** the Delete button, and the Delete key; a note's pop-up goes with it
- [ ] Undo and redo each change; Escape lets go of the selection, Escape again puts the tool down
- [ ] Open a file signed in an earlier session and delete or move the signature
- [ ] Open a PDF with comments made in **Adobe Acrobat** and move one: it keeps its look
- [ ] **Rotated page:** moving and resizing go the way you drag
- [ ] **Phone:** tap to select, drag the selection; the buttons stay on screen
- [ ] **Saved file in Adobe Acrobat Reader:** the edits are there and nothing else changed

## Phase 2: stamps

- [ ] **Stamp** each preset, and your own text with accents (é, ü); a symbol such as ✓ is
      refused with a message
- [ ] A second line: Today's date, and a name; each colour
- [ ] Place, resize and apply; then select it, move it, resize it and delete it; undo each
- [ ] On a rotated page the stamp reads the right way up
- [ ] **Saved file in Adobe Acrobat Reader:** the stamps look the same, are listed as stamps in
      the comments list (Approved and Draft by their names), and print. Also in
      **Chrome/Edge** and **Firefox**

## Problems found

_None yet._

## Follow-ups (not bugs)

- **First Save writes back to the opened file.** Today the first Save asks where to save,
  because a file opened from the file picker or by drag-and-drop can't be written back to.
  Doing it needs `showOpenFilePicker` in Chrome/Edge and the file's path on desktop. Planned
  for later.
- **Page labels** (like "i, ii, 1, 2") aren't renumbered after pages are moved or deleted.
