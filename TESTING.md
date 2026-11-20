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

## Needs you

Things only the project owner can do or decide. The code uses the default named in each until
then.

- (2026-11-19) **Check our certificate signatures in Adobe Acrobat Reader** (the Phase 5 exit
  criteria): see [Phase 5: certificate signing](#phase-5-certificate-signing). Until a real
  certificate is used, Acrobat shows the signature as made by an unknown identity; trusting
  `fixtures/trust/pdfoctopus-test-signing-ca.pem` in Acrobat (Preferences → Signatures →
  Identities & Trusted Certificates → Import) should make it "valid".
- (2026-11-19) **A real digital ID for a final check** (optional): a `.p12` / `.pfx` from a
  certificate provider on Adobe's trust list (AATL), or a free personal one, to check a
  signature shows as valid in Acrobat without trusting anything by hand. Never commit it.

Decided (no action needed):

- (2026-11-20) **Timestamps in the web app**: DigiCert's and Sectigo's timestamp servers don't
  let websites call them (no CORS headers, and DigiCert's is plain http), so the web app shows
  the timestamp option switched off with a note, and timestamps work in the desktop app only.
  Running our own relay for the web app would mean sending the hash through our server; not
  done unless you ask for it.
- (2026-11-20) **Trusting signers**: the browser has no list of trusted certificates, so the
  Signatures panel shows who signed as their certificate says and that the identity isn't
  verified. A later PR can let people mark certificates as trusted (kept on their device).

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

## Phase 3: create

- [ ] **New** (top bar) → Blank pages: 3 A4 pages, then 1 landscape Letter page. The page
      sizes are right (Properties, or Acrobat's Document Properties)
- [ ] **Pictures:** add three photos from your phone (one portrait, one landscape), reorder them
      with the arrows, Create. Each photo is the right way up and on its own page, in order.
      Try "Each page the size of its picture" too
- [ ] **Text:** paste a few paragraphs with accents and another alphabet (Greek, Chinese,
      Arabic); open a .txt file. Long text flows onto more pages
- [ ] **Markdown:** open a README.md (e.g. this project's): headings, lists, code and tables
      look right; links work in the saved PDF
- [ ] **HTML:** open a saved web page (.html): text and simple styling come through; pictures
      from the web don't (that's on purpose)
- [ ] The new PDF isn't saved: closing the tab warns; Save asks where to put it. Making another
      new PDF with unsaved changes asks first
- [ ] Open the saved new PDFs in **Adobe Acrobat Reader**, **Chrome/Edge** and **Firefox**
- [ ] **Phone:** New works, and the dialog fits the screen

## Phase 4: export (PDF to pictures and text)

- [ ] **Export** (top bar) → PNG, all pages of a few-page PDF: a ZIP with one picture per page,
      in order; the pictures open in your photo viewer and look like the pages
- [ ] JPEG at 300 dpi, one page: a single .jpg; it's sharp when zoomed in. Low quality makes a
      smaller file
- [ ] **Plain text** from a contract or letter: the text reads in the right order. From a
      scanned PDF: little or nothing (expected, there's no OCR)
- [ ] **Web page (HTML):** open the .html in your browser: each page is a white sheet with the
      text in place; pictures are there
- [ ] **SVG:** opens in the browser and in Inkscape or Illustrator, and stays sharp when
      zoomed
- [ ] Pages "2-3, 5" exports just those; select pages in the sidebar first and "The selected
      pages" is offered
- [ ] Unsaved changes (rotate a page, add a highlight) are in the export
- [ ] A long PDF (e.g. 300 pages at 300 dpi): the progress counts up, **Stop** stops it, and
      nothing is saved
- [ ] A PDF that doesn't allow copying (Password → untick "Copy text and pictures", save,
      reopen): Export says to unlock the permissions first
- [ ] In Chrome/Edge the save dialog offers the right kind of file (.zip, .png, .txt…); in
      Firefox and Safari it downloads
- [ ] **Desktop app:** the save dialog lets you choose where the file goes
- [ ] The top bar is still one line at your usual window size, before and after a search

## Page labels

- [ ] Open a PDF whose pages are numbered "i, ii, iii, 1, 2, 3…" (many books and reports;
      the page box in the top bar shows the label). Delete page "ii": the pages now read
      "i, ii, 1, 2…". Undo brings back "i, ii, iii"
- [ ] Move the last page to the front: it keeps its style (a number among the numbers), and
      both sections count up in order
- [ ] Insert a blank page in the middle of the numbered pages: it gets the next number
- [ ] Save, and open the file in Acrobat Reader: its page box shows the same labels
- [ ] A PDF without labels: move and insert pages, and the page box shows plain numbers
      (1, 2, 3), never "1, 1, 2"

## Phase 5: certificate signing

Use the test IDs in [`fixtures/test-ids`](./fixtures/test-ids) (password `test-only`; test keys
only) or your own `.p12` / `.pfx`, and any PDF, e.g. `fixtures/generated/invoice.pdf`. To make
Acrobat trust the test IDs, import `fixtures/trust/pdfoctopus-test-signing-ca.pem` in Acrobat
(Preferences → Signatures → Identities & Trusted Certificates → Import) and tick "Use this
certificate as a trusted root"; remove it again afterwards.

- [ ] **Sign** (page tools row) → **Digital ID**: choose `test-signer-rsa.p12`, type the
      password, **Open digital ID**. The dialog shows "Test Signer RSA" and who issued it
- [ ] A wrong password says "The password is wrong."
- [ ] Add a reason, **Place signature**, drag the box into place, **Apply**, **Save**. The box
      shows the name, date and reason
- [ ] Open the saved file in **Adobe Acrobat Reader**: the signature panel shows the signature
      as **valid** ("Signed and all signatures are valid"), the document not changed since it
      was signed, and the certificate details (Test Signer RSA, issued by PDFoctopus Test
      Signing CA)
- [ ] Without trusting the test CA, Acrobat says the signer's identity is unknown but the
      document hasn't been changed (that's expected for an untrusted certificate)
- [ ] **Sign twice:** reopen the signed file in PDFoctopus, sign again with
      `test-signer-ec.p12` in another place, save. In Acrobat, **both** signatures are valid,
      and the first says the document was changed after it (by the second signature), which is
      allowed
- [ ] Signing an empty signature field: add one with **Signature field** (Form row), save,
      reopen, then **Sign** → **Digital ID** offers "In the field …". Sign it: the field shows the
      signature, and Acrobat shows it as valid
- [ ] Add a note after signing and save: Acrobat still shows the signature as valid, with a
      change made after signing
- [ ] Edits made before signing are in the signed version (Acrobat's "View signed version")
- [ ] Undo doesn't remove the signature; closing without saving does (the app asks first)
- [ ] After redacting, or with a password change waiting, signing is refused with a message
      saying what to do
- [ ] A real digital ID from a certificate provider (if you have one): Acrobat shows the
      signature as valid without trusting anything by hand
- [ ] Open the signed files in **Chrome/Edge** and **Firefox**: they open and show the box
- [ ] **Phone:** the Digital ID tab fits the screen; signing works

## Phase 5: signature panel

Open the signed files in `fixtures/generated/` and `fixtures/public-domain/`. A banner under the
toolbar says who signed and whether the signatures are intact; **Signatures** in the banner
lists each one.

- [ ] `signed.pdf`: green banner, "Signed by Test Signer One. Signature intact." The panel
      shows the reason, place, time, "The whole file, 1 page" and the certificate chain
- [ ] `signed-twice.pdf` and `signed-by-pdfoctopus-twice.pdf`: both signatures intact; the
      first says "More signatures were added after it" and covers version 2 of 3
- [ ] `signed-then-annotated.pdf`: amber banner, "comments or mark-up were added or changed
      after it was signed"
- [ ] `signed-tampered.pdf`: red banner, "signature is broken", and the panel says the signed
      part of the file was altered
- [ ] `gpo-public-law-118-1-signed.pdf`: intact, signed by the U.S. Government Publishing
      Office, chain up to DigiCert Assured ID Root CA
- [ ] An unsigned file (`invoice.pdf`) shows no banner
- [ ] Sign `invoice.pdf` with a test ID (Digital ID tab): the banner appears straight away and
      the panel lists the new signature as intact. Save, reopen: still intact
- [ ] After signing, add a note and save, then reopen: amber banner (comments added later)
- [ ] The panel always says the signer's identity isn't verified (no trust list yet)
- [ ] Compare with **Adobe Acrobat Reader**'s signature panel for the same files: the same
      signatures are intact or broken, and the same ones were changed after signing
- [ ] **Phone:** the banner and the panel fit the screen

## Phase 5: timestamps and older digital IDs

Test IDs as above (password `test-only`).

- [x] Web app (Chromium): `test-signer-3des.p12` and `test-signer-rc2.p12` open and show "Test
      Signer RSA"; signing with the RC2 one gives an intact signature (2026-11-20)
- [x] Web app: "Add a trusted timestamp" is switched off, with the note that timestamps are in
      the desktop app (2026-11-20)
- [ ] An old `.p12` exported from **Windows** (Certificate Manager → Export, "TripleDES-SHA1")
      or **macOS** Keychain Access opens, signs, and Acrobat shows the signature as valid
- [ ] **Desktop app:** tick "Add a trusted timestamp" (DigiCert), sign, save. The status line
      says "timestamped by DigiCert's timestamp server"; the Signatures panel shows
      "Timestamped by DigiCert … at …"
- [ ] Desktop app: choose Sectigo, close and reopen the dialog: Sectigo is still chosen; sign
      and check the panel the same way
- [ ] Desktop app, offline (Wi-Fi off): signing with a timestamp says the server couldn't be
      reached and asks whether to sign without one; Cancel leaves the file unsigned, OK signs
      without a timestamp
- [ ] Open the timestamped file in **Adobe Acrobat Reader**: the signature panel says it
      includes an embedded timestamp from DigiCert (or Sectigo), and the signing time is from
      the timestamp

## Problems found

_None yet._

## Follow-ups (not bugs)

- **First Save writes back to the opened file.** Today the first Save asks where to save,
  because a file opened from the file picker or by drag-and-drop can't be written back to.
  Doing it needs `showOpenFilePicker` in Chrome/Edge and the file's path on desktop. Planned
  for later.
