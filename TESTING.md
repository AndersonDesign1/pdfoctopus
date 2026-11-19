# Manual tests

Checks that can't run in CI and need a person. Tick a box (`- [x]`) once it passes. If one
fails, write down what happened (file, browser, what you did) under **Problems found**.

Use the live app at <https://pdfoctopus.josanderson25.workers.dev> (it updates when `main`
changes). Test files are in [`fixtures/`](./fixtures); `fixtures/generated/` has small ones
to start with.

New features add their checks here as they're built, so this list is the whole backlog of
hand tests: work down it in any order. The ones that matter most, because nothing automated
can do them, are opening and printing saved files in **Adobe Acrobat Reader**, and anything
on the **desktop app** or a **phone**.

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
- [ ] Place, resize and apply; then select it, move it, resize it and delete it; undo and redo each
- [ ] On a rotated page the stamp reads the right way up
- [ ] **Saved file in Adobe Acrobat Reader:** the stamps look the same, are listed as stamps in
      the comments list (Approved and Draft by their names), and print. Also in
      **Chrome/Edge** and **Firefox**

## Phase 2: images

- [ ] **Image:** a JPEG photo from a phone (taken upright and sideways), a PNG logo with a
      transparent background, a screenshot, a WebP, a GIF, a BMP and an AVIF
- [ ] Drop a picture on the open document: it's placed, and the document stays open
- [ ] Place, resize (proportions kept) and apply; select, move and delete it; undo and redo
- [ ] A very large photo (over 20 megapixels) is accepted and the saved file stays small
- [ ] **Rotated page:** the picture lands where it was dragged and reads the right way up
- [ ] A file that isn't a picture (a text file renamed to .png), picked or dropped, gets a
      message and nothing else happens
- [ ] **Saved file in Adobe Acrobat Reader:** the pictures look right, can be moved there, and
      print. Also in **Chrome/Edge** and **Firefox**

## Phase 2: redaction

Redaction is for removing things for good, so check the results carefully. Use
`fixtures/generated/contract-libreoffice.pdf` (and a real document of your own if you have one).

- [ ] **Redact tool** (Annotate row): drag over a few words and over a picture. Marks show as
      red outlines and nothing is removed yet; Select can move, resize and delete a mark
- [ ] **Search, then Redact all:** every match is marked
- [ ] **Apply redactions:** read the dialog, apply; black boxes replace the marked content, and
      a comment or highlight under a mark is gone. Undo brings everything back; redo removes it.
      After saving, Undo is greyed out: the redaction is final
- [ ] **Save**, then open the saved file in **Adobe Acrobat Reader**, **Chrome/Edge** and
      **Firefox**: search for a redacted word (not found), select and copy the text around a
      black box and paste it somewhere (the redacted words aren't in it), and check that pictures
      under a mark are blacked out, not just covered
- [ ] A mark that only touches the edge of a word: the whole word (or letter) is removed, not
      half of it
- [ ] A mark across a table or a drawn line: the whole line goes (on purpose, so nothing partly
      covered is left), and the rest of the table stays
- [ ] A PDF with comments that have replies (made in Acrobat): redact a comment; its text is
      gone from the saved file, and the reply stays
- [ ] A form PDF with a mark over a form field: Apply refuses with a message about form fields
- [ ] A digitally signed PDF: the dialog warns that signatures will no longer be valid, and
      after saving Acrobat says so
- [ ] Rotated page: the marked area is what gets removed

## Phase 2: filling in forms

Use `fixtures/third-party/py-pdf/012-libreoffice-form_libreoffice-form.pdf` and
`fixtures/public-domain/irs-form-w9.pdf`, and a real form of your own if you have one (a tax
form, a job application).

- [ ] Opening a form PDF says "This PDF has a form" in the status line; fields have a light
      purple tint
- [ ] **Text field:** click, type, press Tab: the text stays and the next field has the focus.
      Enter also does in a one-line field; Escape puts back what was there. A long text in a
      small box shrinks or is cut off the way the PDF draws it
- [ ] Type in a field without leaving it, then drop another PDF on the window or close the
      tab: you're warned about unsaved changes
- [ ] **Checkbox** ticks and unticks; **radio buttons:** choosing one turns the others in its
      group off; **dropdown:** pick an option
- [ ] Type in a text field and press **Ctrl+S** without leaving it: the saved file has the text.
      Type, then **Escape**: the old text comes back and nothing is saved. Type, scroll several
      pages away and back: the text is still there
- [ ] A dropdown that also takes typed answers (Acrobat's "Allow user to enter custom text"):
      you can type an answer or pick one of the options
- [ ] **Undo/redo** (Ctrl+Z, Ctrl+Y) step through each field change
- [ ] **Save**, then open the saved file in **Adobe Acrobat Reader**, **Chrome/Edge** and
      **Firefox**: every value is there and can still be changed
- [ ] **IRS W-9:** fill in the name; the status line says the XFA copy was removed. Open the
      saved file in **Adobe Acrobat Reader**: it shows your values (not an empty form) and no
      warning about the form being changed
- [ ] **Flatten form:** read the dialog, flatten; the values stay, the fields can't be clicked
      any more, and the saved file shows them in Acrobat as plain page content (no form). Undo
      brings the fields back
- [ ] A form field under a redaction mark: Apply asks you to flatten the form first; after
      flattening, Apply removes the field's text
- [ ] **Keyboard only:** Tab moves through the fields; Space ticks a checkbox
- [ ] **Phone or tablet:** tapping a field opens the keyboard, and the page still scrolls when
      dragged between fields
- [ ] A PDF whose form is only XFA (some older government forms, which show "Please wait…" in
      other viewers): opening it shows a warning that it can't be filled in
- [ ] Zoomed in and out, and on a rotated page: the inputs sit over the boxes on the page

## Phase 2: building forms

Use `fixtures/generated/contract-libreoffice.pdf` (no form) and
`fixtures/third-party/py-pdf/012-libreoffice-form_libreoffice-form.pdf` (has one).

- [ ] **Form row:** pick **Text field** and drag a box; the dialog suggests a name. Add it. Do
      the same with a click instead of a drag (a box of the usual size)
- [ ] Add a **Checkbox**, two **Radio buttons** in one group (the second one offers the same
      group name), a **Dropdown** with three options and a default, a **Date** and a
      **Signature field**
- [ ] A name that's already used: the dialog says so and stays open
- [ ] **Edit fields:** every field is outlined; click one, rename it, tick Required, Save. Change
      a dropdown's options. Delete a field. Undo and redo each change
- [ ] Press Escape (or pick the tool again) to put a form tool down; the new fields (all but the
      signature field, which is signed in an app that supports digital signatures) can then be
      filled in as usual
- [ ] **Save**, then open the file in **Adobe Acrobat Reader**, **Chrome/Edge** and **Firefox**:
      every field is there and can be filled in, radio buttons in a group turn each other off,
      the dropdown offers its options, required fields are marked (Acrobat outlines them in
      red), and the date field in Acrobat takes a date like 2026-11-19
- [ ] **Signature field** in Acrobat: it offers to sign there
- [ ] Add a field to the form that already has fields; open the saved file in Acrobat: the old
      fields still work
- [ ] On a rotated page, the field goes where it was drawn
- [ ] **Phone or tablet:** drawing a field's box with a finger works, and the Form row shows all
      six field tools and **Edit fields**; the field dialog fits the screen

## Phase 3: passwords and permissions

Use any PDF, e.g. `fixtures/generated/contract-libreoffice.pdf`.

- [ ] **Password** (page tools row): tick "Require a password to open", type it twice,
      Protect, Save. The button shows a lock
- [ ] Open the saved file in **Adobe Acrobat Reader**, **Chrome/Edge** and **Firefox**: each
      asks for the password, refuses a wrong one, and opens with the right one. In Acrobat,
      File → Properties → Security says AES 256-bit
- [ ] Protect with only "Limit what people can do": untick Copy and Change the content, set a
      permissions password, Save. In Acrobat the file opens without a password, copying is
      blocked, and Security shows the limits
- [ ] Both: an open password and limits. In Acrobat the open password opens it with the
      limits; the permissions password opens it with none
- [ ] Reopen the limited file in PDFoctopus: Password asks for the permissions password
      first; a wrong one is refused. With the right one, **Remove password**, Save: the file
      opens anywhere without a password
- [ ] A password with accents or another alphabet (e.g. "Pässwörd") works in Acrobat
- [ ] Undo (Ctrl+Z) after setting a password and before saving: the file saves without one
- [ ] Edit a protected file (rotate a page) and save: it still asks for the password
- [ ] A digitally signed PDF: the dialog warns signatures stop being valid; Acrobat agrees after
      saving

## Phase 3: compress

Use a PDF with photos (a scanned document, a brochure, a phone photo turned into a PDF) and a
text-only one (`fixtures/generated/contract-libreoffice.pdf`).

- [ ] **Compress** (page tools row): try each preset. The dialog shows the size now and the
      compressed size; a text-only file may say it can't be made smaller
- [ ] **Save compressed copy**: it's saved as "name (compressed).pdf"; the open file isn't
      changed (its title bar and Save behave as before)
- [ ] Open the compressed copies in **Adobe Acrobat Reader**, **Chrome/Edge** and **Firefox**:
      every page looks right; photos are a little softer with Smallest, and text, links and
      form fields still work
- [ ] Print a page from the Balanced copy: photos look fine on paper
- [ ] A big scan (100+ pages): compressing finishes (it may take a while) and the app stays
      responsive enough to show it's working
- [ ] A file with a password: Compress says to remove the password or set a new one first;
      after setting a new password, the compressed copy asks for it

## Problems found

_None yet._

## Follow-ups (not bugs)

- **First Save writes back to the opened file.** Today the first Save asks where to save,
  because a file opened from the file picker or by drag-and-drop can't be written back to.
  Doing it needs `showOpenFilePicker` in Chrome/Edge and the file's path on desktop. Planned
  for later.
- **Page labels** (like "i, ii, 1, 2") aren't renumbered after pages are moved or deleted.
