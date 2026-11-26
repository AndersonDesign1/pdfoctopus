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
same PR that changes it. Last updated: 2026-11-26, after single-line text edits.

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
- **Page labels** ("i, ii, 1, 2") follow their pages when pages are deleted, moved or
  inserted (fixed 2026-11-19, `pageLabels.ts`): each page keeps its section and sections are
  numbered again in order; undo puts the labels back as they were. A document without labels
  stays without them (MuPDF used to add a tree numbering moved pages "1, 1, 2").
- **Known gaps:** the desktop folder picker for split (`dialog:allow-open`) hasn't been tried
  on Windows yet.

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
  orientation is applied, pictures are scaled down to 2,400 pixels on their longer side, pictures over
  100 megapixels are refused before they're decoded (the size is read from the file's header),
  photos become JPEG, pictures with transparency stay PNG, and PNG or GIF files normally stay PNG
  (a large opaque one is re-encoded as JPEG if its PNG would be over the engine's 10 MB limit).
  Anything still over the limit is made smaller. Nothing leaves the device.
- **Engine:** the existing `addImageStamp` with kind `image`. Unlike signatures, pictures
  aren't marked "locked", so other apps let them be moved too. New tests: a JPEG photo is
  drawn where it was placed and saved compressed, and pictures aren't locked.
- **Size:** a new picture fits a 220-point square (a portrait photo isn't page-high).
- **Checked:** in Chromium end to end: a sideways camera photo comes in upright, a transparent
  PNG dropped on the page keeps its transparency, a file that isn't a picture gets a message;
  the saved file in pdf.js.
- **Not yet checked:** real phone photos, and the saved files in Adobe Reader (see the images
  list in TESTING.md).

### 9. Phase 2: redaction (2026-11-19)

The **Redact** tool in the Annotate row marks an area; **Redact all** next to the search box
marks every match. Marks are red outlines and remove nothing. **Apply redactions** (shown
while there are marks) asks for confirmation, then removes the text, pictures and drawings
under every mark for good and draws black boxes in their place. Annotations under a mark
(comments, highlights, links) are deleted too. Applying is one undoable step until the file is
saved; saving a redacted file clears the undo history, so the removal is final from then on.

- **Saving after a redaction rewrites the whole file.** An incremental save keeps the original
  bytes, and with them the removed text (checked: the original section of an incremental save
  still read "Secret agent Bond here"). The engine forces a full save once redactions are
  applied (`DocumentInfo.redacted`), whatever it's asked for, and the confirmation says so,
  including that digital signatures stop being valid. That's the user's agreement the
  "incremental unless agreed" rule asks for.
- **Engine:** `addAnnotation({ kind: "redact" })`, `markForRedaction` and `applyRedactions` in
  `packages/core/src/engine.ts`, using MuPDF's redaction (text removed, image pixels blacked
  out, and any drawing a mark touches removed entirely, so nothing partly covered is left to
  recover; a table border crossing a mark goes with it). MuPDF writes the pages' new content as new objects, so
  undo puts the old `/Contents`, `/Resources` and `/Annots` back. MuPDF leaves other
  annotations alone, so the engine deletes those under a mark itself, and empties each deleted
  one: a reply (/IRT) or a tagged PDF's structure tree can still point at it, and a full save
  keeps whatever is pointed at. Its entries are kept in memory for undo.
- **Form fields are refused:** a field's value lives in the form, not only on the page, so
  deleting its box would leave the value in the file. Apply says which page, asks for the form
  to be flattened first, and does nothing.
- **Tests:** `redaction.test.ts` covers marking areas and search results (text inside form
  XObjects too), the black box, annotations and pop-ups under a mark, undo/redo, rotated pages,
  the form-field refusal, bad input, and that the saved file isn't incremental and doesn't
  contain the word even fully decompressed. The fixture sweep redacts the middle of the first
  page of every editable fixture, saves, and checks it reopens without repair; where the mark
  covers a form field, it checks the refusal left the mark and the page as they were.
- **Checked:** in Chromium end to end (Redact all on a name, a box mark, apply, search finds
  nothing, save), and the saved file in MuPDF (no trace of the name) and pdf.js.
- **Redact all** refuses when the search stopped at its 5,000-match limit, rather than mark
  only some matches.
- **Not covered yet:** the document's title and other metadata, bookmarks, attachments and
  hidden layers aren't changed (the dialog says so); a later version could offer to clear them.
- **Not yet checked:** the saved file in Adobe Reader (search for and copy around a redacted
  word), and real documents; see the redaction list in TESTING.md.
  A mark removes every letter it touches, even partly.

### 10. Phase 2: filling in forms (2026-11-19)

Opening a PDF with a form says so in the status line. With no tool picked, every field that can
be filled in (not read-only, signature or button fields) has a real input over it: click a text
field and type (Tab goes to the next field; leaving the field, or Enter in a one-line field,
puts the text in; Escape puts back what was there), click a checkbox or radio button, or pick
from a dropdown (or type, if it takes typed answers). Each change is one undoable step, and
saving appends the changes to the file (an incremental save). **Flatten form**
(shown when the file has fields) asks first, then turns every field into ordinary page content.

- **Engine:** `listFields`, `setFieldValue` and `flattenForm` in `packages/core/src/engine.ts`,
  helpers in `forms.ts`. Values are checked per kind (a dropdown only takes one of its options,
  a radio button can only be chosen, read-only fields are refused). Undo puts back the field's
  `/V`, `/AS` and `/AP` on the field and all its boxes; MuPDF draws a new appearance stream for
  each change, so the old one is still there to go back to.
- **A field is found by its name (`/T`)**, walking up `/Parent`, not by `/FT`: some files
  repeat `/FT` on every box, and then a radio group's boxes looked like separate fields.
- **XFA:** a "hybrid" form (AcroForm plus an XFA copy, like the IRS W-9) is filled in through
  its AcroForm, and the XFA copy is removed in the same step (undo puts it back), because Adobe
  Reader shows the XFA copy and would show the old values. A form that's only XFA can't be
  filled in; opening one says so.
- **Flattening** uses MuPDF's bake, and removes the AcroForm. If the form asks apps to draw
  its fields (`NeedAppearances`), the text and dropdown boxes are drawn first, because some
  files (the LibreOffice fixture) leave values with empty appearances and flattening keeps only
  appearances. Undo restores every page's `/Contents`, `/Resources` and `/Annots`, the
  AcroForm and those appearances.
- **Redaction** of a field is still refused, but now says to flatten the form first; after
  flattening, the field's value is ordinary page content and is redacted like any text.
- **Date fields** are text fields with a format script; they're filled in as text. Scripts
  (formatting, calculations, validation) don't run.
- **Tests:** `forms.test.ts` (every kind of field, undo/redo, incremental save, flattening,
  NeedAppearances, hybrid and XFA-only forms, refusals, redaction after flattening), plus a
  fixture sweep that fills the first text field and checkbox of every fixture with a form,
  saves, and checks the file reopens without repair and keeps the value.
- **Checked:** in Chromium on the LibreOffice form (text, Tab to the next field, checkbox,
  dropdown, save, flatten, undo) and the IRS W-9.
- **Not yet checked:** the saved files in Adobe Reader and other viewers; see the forms list in
  TESTING.md.

### 11. Phase 2: building forms (2026-11-19, issue #21)

A **Form** row of tools: **Text field**, **Checkbox**, **Radio button**, **Dropdown**,
**Date** and **Signature field**. Pick one and drag a box on a page (a click gives a box of the
usual size); a dialog asks for the name (one is suggested), whether it's required, a default
value, a dropdown's options, or a radio button's group and value. **Edit fields** outlines every
field; click one to rename it, change whether it's required, its default or options, or delete
it. Each change is one undoable step, and saving stays incremental.

- **Engine:** `addField`, `updateField` and `deleteField` in `packages/core/src/engine.ts`,
  helpers in `formBuild.ts`. MuPDF's JavaScript API can't create widgets, so the field and
  widget dictionaries are built by hand (and the AcroForm, with Helvetica as `/Helv`, if the
  file has none); calling `setRect` before `update()` makes MuPDF draw the new field.
- **Radio buttons** with the same name join one group; each has its own value (its "on" state),
  and two in a group can't share one. Deleting a group's last button removes the group.
- **Dates** are text fields with Acrobat's `AFDate_FormatEx`/`AFDate_KeystrokeEx("yyyy-mm-dd")`
  scripts, for apps that run them. **Signature fields** are empty `/Sig` boxes, to sign in an
  app that supports digital signatures (signing in PDFoctopus is Phase 5).
- **Names** must be unique (a radio group's buttons share theirs) and can't contain a dot,
  which separates the parts of a full name. A new default value is shown in a field that's
  empty or still shows the old default; changing a dropdown's options clears an answer that's
  no longer offered.
- **Hybrid forms** (the IRS W-9): adding, changing or deleting a field removes the XFA copy in
  the same step (undo puts it back), as filling in does, so Adobe Reader shows the change.
- **Options** are only rewritten when they change, and an option kept from before keeps its own
  label (`["CA", "California"]`); a dropdown that takes typed answers keeps one.
- **Undo** snapshots the entries a change touches (the page's `/Annots`, the form's `/Fields`
  and resources, a group's `/Kids`, or the field's `/T`, `/Ff`, `/DV`, `/Opt` and value) and
  puts them back.
- **Tests:** `formBuild.test.ts`: each kind on a blank PDF, adding a text field to (and
  deleting one from) a file with a form, saving
  (incremental, reopens without repair, the new fields can be filled in), radio groups,
  defaults, date scripts, a rotated page, renaming and other changes, deleting (one radio
  button, a whole group, a file's own field), undo/redo, and refusals.
- **Checked:** in Chromium end to end: each kind added to the generated contract, a duplicate
  name refused in the dialog, a field renamed and made required, one deleted, the renamed field
  filled in and saved; the saved file checked in MuPDF.
- **Not covered yet:** moving and resizing fields, tab order, fonts and text alignment,
  maximum length, calculations and validation scripts.
- **Not yet checked:** the saved files in Adobe Reader and other viewers; see the list in
  TESTING.md.

### 12. Phase 3: passwords and permissions (2026-11-19)

**Password** (page tools row) opens a dialog: require a password to open the file, limit what
people can do with it (print, copy, change the content, comment, fill in forms, organise
pages) behind a permissions password, or both; or remove the file's password. It takes effect
when the file is saved, which then rewrites the whole file (the dialog says so, and that
digital signatures stop being valid), and it's one undoable step until then.

- **Engine:** `setPassword`, `removePassword` and `unlockPermissions` in
  `packages/core/src/engine.ts`, helpers in `security.ts`. MuPDF writes AES-256 (Standard
  security handler V5 R6) when saving with `encrypt=aes-256` and the passwords and `/P`;
  `encrypt=none` removes it. Reading for accessibility is always allowed; "print" allows
  high-quality printing too.
- **Permissions are read from `/Encrypt /P`**, not MuPDF's `hasPermission`, which reports
  editing as allowed when it isn't.
- **A file that restricts anything** can only have its password or permissions changed once
  unlocked with its permissions (owner) password: when opening, or in the dialog afterwards.
  Otherwise anyone with the open password could remove the limits.
- **Saving a protected file without changing its password** keeps its encryption, whether
  the save appends (as usual) or rewrites.
- **Passwords can't contain a comma** (MuPDF's writer options are comma-separated) and are at
  most 127 bytes; any language works.
- **Tests:** `security.test.ts`: `/P` bits, open password, permissions only, both passwords,
  undo before saving, unlocking, removing, refusals, a non-English password, and saving a
  protected file by appending and rewriting.
- **Checked:** in Chromium end to end (protect with both passwords and limits, save, reopen
  with the open password, unlock with the permissions password, remove, save), and the saved
  files with qpdf (R6, AES-256 for streams, strings and files; refused without the password;
  the permissions as set; the unprotected copy opens without one).
- **Not yet checked:** Adobe Acrobat and Reader (see TESTING.md). PDFoctopus doesn't yet
  enforce a file's own limits on what can be done in it, besides changing its password.

### 13. Phase 3: compress (2026-11-19)

**Compress** (page tools row) opens a dialog with three presets: **High quality** (the file is
rebuilt: unused objects dropped, streams and fonts compressed, objects packed into object
streams; pictures untouched), **Balanced** (also pictures scaled to at most 200 dpi
over the largest page, JPEG quality 80) and **Smallest** (120 dpi, quality 60, and photos stored
losslessly become JPEG). It shows the size now and the copy's size, and saves the copy as a new
file ("name (compressed).pdf"). The open document isn't changed, so the rule about rewriting
files doesn't come into it.

- **Engine:** `compressedCopy(preset)` in `packages/core/src/engine.ts`, helpers in
  `compress.ts`. MuPDF's image rewriting isn't in its JavaScript build, so each picture is
  decoded, scaled with `Pixmap.warp`, encoded as JPEG and written back into the same object,
  and only kept if it's at least 10% smaller.
- **No duplicate merging** (`garbage=deduplicate`): it took 84 seconds on the 44,000-object
  SF86 form and saved under 1%; without it that form compresses in about a second.
- **Left alone:** masks and pictures used as masks, 1-bit pictures (scans, JBIG2, CCITT),
  pictures with decode arrays or colour key masks, DeviceN and Lab pictures, and pictures over
  100 megapixels.
- **Passwords:** a password set (or removed) in the Password dialog applies to the copy. A file
  with a password that isn't being changed is refused, as its passwords aren't known to protect
  the copy the same way.
- **MuPDF's memory moves when it grows,** so bytes it returns (`asUint8Array`, `asJPEG`) are
  copied before anything else runs; two bugs of that kind were found by the browser test on a
  21 MB file and fixed before committing.
- **Tests:** `compress.test.ts`: big pictures scaled down for Smallest (and less for
  Balanced), High leaves them alone, masks and 1-bit pictures untouched, unsaved changes
  included, the open document unchanged, and passwords carried over or refused.
- **Checked:** in Chromium (a 21 MB photo PDF to 95 KB with Smallest; High says it can't be
  made smaller; the copy saved), and on the larger fixtures.
- **Not covered yet:** a picture shown small on its page is only scaled down to the page's
  size, not to the size it's shown at; fonts aren't subset.

### 14. Phase 3: create (2026-11-19)

**New** (top bar, and "Make a new PDF" on the start screen) opens a dialog with three tabs:
**Blank pages** (how many, paper size, landscape), **Pictures** (add several, put them in
order, then either on paper with a margin, turned to suit each picture, or each page the size
of its picture at 96 dpi) and **Text** (type, paste or open a .txt, .md or .html file, and say
which it is). Paper defaults to US Letter in the Americas' Letter countries and A4 elsewhere.
The new PDF opens as an unsaved document: closing warns, and the first Save asks where to put
it.

- **Engine:** `createPdf(spec)` in `packages/core/src/create.ts`, run in the worker (loaded
  lazily, after the engine, like everything that uses MuPDF: a static import loaded MuPDF
  before the engine and left "Loading the PDF engine…" showing for good).
- **Text and Markdown** become HTML with a simple style sheet (sans-serif 11 pt, ¾-inch
  margins); **HTML** is used as it is, with only the margin added. MuPDF lays it out and
  `DocumentWriter` writes the pages; then fonts are subset (an HTML page with a few Chinese
  characters went from 3.8 MB to 55 KB). Pictures, style sheets and fonts linked from elsewhere
  aren't fetched, and scripts don't run.
- **Markdown** (`markdown.ts`): headings, paragraphs, emphasis (not inside snake_case words),
  code spans and fenced blocks, block quotes, nested lists, links (http, https, mailto and #
  only; one level of brackets in a URL), horizontal rules and pipe tables. Raw HTML is shown
  as text, and pictures become their description.
- **Pictures** are read in the browser with the Image tool's `pictureToImage` (100-megapixel
  limit, the camera's orientation applied, larger ones scaled to 2400 pixels), then placed by
  the engine.
- **Tests:** `create.test.ts` (each paper size and orientation, page limits, pictures at their
  own size and on paper in order, text across several pages with non-Latin text, Markdown, HTML
  with remote links and scripts, small output) and `markdown.test.ts`.
- **Checked:** in Chromium: three blank pages, a Markdown shopping list with a table, and two
  pictures reordered (portrait page first, then landscape), saved as "Pictures.pdf".
- **Not covered yet:** HTML layout is MuPDF's (no flexbox or grid; nested lists are indented
  oddly), there's no page numbering or headers, and pictures can't be cropped or rotated in the
  dialog.

### 15. Phase 4: export, PDF to pictures and text (2026-11-19)

**Export** (top bar, next to Save as) saves pages as **PNG** or **JPEG** pictures (72, 150,
300 or 600 dpi; JPEG at high, medium or low quality), **SVG** drawings, **plain text** or a
**web page (HTML)**. Choose all pages, this page, the selected pages, or a range such as
"1-3, 5". Pictures and SVG are one file per page, in a ZIP when there are several
("report-page-03.png", numbered to sort); text is one .txt (a form feed after each page, as
pdftotext does) and HTML one .html with each page as a sheet. Everything happens on the
device, and the open file isn't changed.

- **Engine:** `exportPage(page, options)` exports one page at a time (`convert.ts`), so a long
  document shows progress ("Exporting page 31 of 500…"), can be stopped, and only one page's
  pixels are in memory at once (about 15 pages a second at 150 dpi in Chromium). Unsaved
  changes, annotations and form fields are included. Pictures over 60 megapixels are made
  smaller, and record their resolution so they print at the page's size.
- **Files** (`exportFiles.ts`, no MuPDF, so the UI uses it directly): names, the HTML wrapper
  and a small ZIP writer (`zip.ts`: stored, UTF-8 names, checked with Python's `zipfile` and
  `unzip -t`). The HTML page has a Content-Security-Policy that blocks scripts and anything
  from elsewhere. An export over 1.5 GB is refused before it's saved.
- **Permissions:** a file that doesn't allow copying its content can't be exported until its
  permissions are unlocked with the permissions password.
- **Saving** asks for a file of the right kind (`chooseDestination` takes a file kind now).
- **Toolbar:** the search box now takes the room the top bar has left, and keeps none for the
  match count before a search, so Export fits on one line at 1280 pixels.
- **Tests:** `export.test.ts` (sizes at each resolution, JPEG quality, unsaved rotation, text,
  SVG and escaped HTML, bad pages and options, the pixel limit, the copy permission, file
  names, ZIP contents read back with CRCs) and `ExportDialog.test.ts` (which pages).
- **Checked:** in Chromium: each format from a two-page contract (the HTML opened and looks
  like the pages), a bad range explained, a 500-page export stopped at page 30 with nothing
  saved, and a file that forbids copying refused.
- **Not covered yet:** text from scanned pages (no OCR), HTML keeps positions but not links,
  and SVG text is drawn as shapes (it can't be selected or searched).

### 16. Phase 5: certificate signing (2026-11-19)

**Sign** (page tools row) has a new **Digital ID** tab: open a `.p12` or `.pfx` file with its
password, add a reason and place if wanted, then either place a new box on the page (dragged
into place like a signature) or sign an empty signature field the document already has. The
box says "Digitally signed by", the name from the certificate, the date and time, and the reason
and place. The signature is PAdES baseline B-B and covers the file with any unsaved changes;
**Save** writes it. The file, password and key never leave the browser: the key is imported
into WebCrypto as non-extractable, for signing only, and is dropped once the signature is made
(or the dialog is closed). Nothing is stored.

- **Engine:** `prepareSignature` and `finishSignature` in `packages/core/src/engine.ts`, with
  `signatureField.ts` (the field, its appearance and the signature dictionary) and
  `signature.ts` (finding and filling in the placeholders in the saved bytes). MuPDF can't sign
  from JavaScript, so the dictionary is written by hand (`/Filter /Adobe.PPKLite`,
  `/SubFilter /ETSI.CAdES.detached`, `/M`, a wide `/ByteRange` and `/Contents` as zeros, 16 KB
  or more depending on the certificates). The work is done on a copy opened from the file as it
  would be saved now, saved incrementally, then `/ByteRange` is filled in without changing the
  file's length, and the signature is written over the zeros.
- **The signed file becomes the open document,** so later changes are appended after the
  signature and leave it valid (it then shows they were made later). Signing can't be undone
  (the history starts again); closing without saving drops it. Saving without changes gives
  back the signed file byte for byte.
- **Refused** (with a message saying what to do) when the next save would rewrite the file:
  after redacting, with a password change waiting, a file that has a password (not supported
  yet), or a damaged file that was repaired.
- **Signature** (`packages/sign`, PKI.js 4.0.1 and asn1js 4.0.0, loaded only when the Digital ID
  tab is used): a detached CMS SignedData with contentType, messageDigest (SHA-256) and
  signingCertificateV2 signed attributes, no signingTime (PAdES puts the time in `/M`), and the
  signer's certificate plus the others in the `.p12` (its chain). RSA (PKCS #1 v1.5) and ECDSA
  (P-256, P-384, P-521) keys, with SHA-256. Expired and not-yet-valid certificates, and ones
  whose key usage doesn't allow signing, are refused.
- **`.p12` files** must use AES (PBES2) encryption, which OpenSSL 3, current Windows ("AES256-SHA256"
  when exporting) and most providers use. (Older files with 3DES or RC2 work since item 18.)
- **Tests:** `packages/sign/src/sign.test.ts` (loading RSA and EC IDs, a wrong password, old
  encryption, not a `.p12`, expired certificates; signing a new box and an existing field, two
  signatures with the first still valid, changes before and after signing, the refusals, and a
  signature too big for its space; each signature checked with PKI.js against the test CA) and
  `packages/core/src/signature.test.ts` (placeholders, rotated pages, the open document left
  alone). Test IDs are in `fixtures/test-ids` (test keys only, see fixtures/README.md).
- **Checked independently with pyhanko:** `fixtures/generated/signed-by-pdfoctopus.pdf` and
  `-twice.pdf` are validated by `check-signatures.py` (intact, trusted with the test CA, PAdES
  B-B, and the first signature still valid after the second), and the CI `signatures` job signs
  fresh copies with each pull request's code and checks those too.
- **Checked:** in Chromium end to end: a wrong password and an old 3DES file refused with
  clear messages; the invoice signed in a new box, saved, reopened and signed again with the EC
  ID, saved; the contract signed in its empty "Approver" field. pyhanko reports every signature
  intact and trusted, and the first one still valid after the second.
- **Not covered yet:** timestamps (B-T), the Windows certificate store and smart cards (later
  Phase 5 work). Names in the box that aren't in Latin-1 show as "?" (the certificate still has
  the right name). Not yet checked in Adobe Acrobat Reader; see TESTING.md. (The signature panel
  is item 17.)

### 17. Phase 5: signature panel (2026-11-20)

When a signed file is opened, a banner under the toolbar says who signed and whether the
signatures are intact, intact with changes allowed after signing (comments, form filling, more
signatures), changed after signing, or broken. **Signatures** in the banner lists each one:
signer, time, reason, place, page, which version of the file it covers, the certificate and its
chain, the hash, and what was changed after it. Who signed is shown as the certificate says; it
isn't checked against a trust list (the browser has none), and the panel says so. After signing
with the Digital ID tab the new signature shows as intact straight away.

- **Engine:** `inspectSignatures` in `packages/core/src/engine.ts`, with
  `signatureCheck.ts`. For each signed field it reads the signature dictionary, checks the
  `/ByteRange` (starts at 0, leaves out exactly the `/Contents` hex string, which must be the
  field's own, and ends where a saved version ends: `startxref`, a number and `%%EOF`) and
  reads the signature from the file's bytes. If the file was added to after a signature, the signed version (the bytes up to
  the end of its byte range) is opened on its own and compared with the whole file object by
  object: annotations added or changed, form fields filled in, more signatures (with their fields
  and appearances), the form's field list and the pages' `/Annots` lists are the allowed kinds;
  anything else (a page's content, page tree, catalogue, or any other existing object) is
  "other". It's checked against the file as opened, not unsaved changes. The opened file's bytes
  are kept only if it has signatures.
- **Limits** (hostile files): 50 signatures, 1 MB per signature, 300,000 objects and 256 MB of
  streams compared per signature; past those, or when the signed version can't be read cleanly,
  the change is "unknown" and shown as "changed after signing", never as harmless.
- **Crypto** (`packages/sign/src/verify.ts`, PKI.js and WebCrypto, loaded only for signed files):
  hashes the signed bytes (SHA-256/384/512; SHA-1 works but is flagged as weak) and compares
  them with the messageDigest attribute, then checks the signer's signature over the signed
  attributes (RSA PKCS #1 v1.5, RSA-PSS, ECDSA P-256/384/521). Also `adbe.pkcs7.sha1`. The chain
  the signature carries is built and each link's signature checked; a certificate that was
  expired or not yet valid at the signing time (`/M`, or the signingTime attribute) is flagged.
  Timestamps are checked since item 18.
- **Tests:** `packages/sign/src/verify.test.ts` runs our validator over every signed fixture and
  checks the same intact and changed-after-signing results as pyhanko's expectations in
  `check-signatures.py` (trust aside). The one difference is deliberate: for
  `signed-then-annotated.pdf` pyhanko's strict policy says "OTHER", we say "comments added".
  Tampered files: a byte flipped inside the signed range or in the signature (broken), page
  content replaced, an existing content stream rewritten or a page added in a later update
  ("other"), a note added by our editor (comments), a re-save with no changes, a byte range
  that doesn't start at 0, a content stream replaced by one marked `/Type /XRef` ("other"), a
  stream's bytes changed in place, a broken certificate chain (a warning), and "%%EOF" inside
  a stream (not a version end). Also our own signing then checking (RSA then EC, the first
  "changed: more signatures"). `signatureCheck.test.ts` covers the byte-level checks, and
  `fixtures.test.ts` reads the signatures of every fixture.
- **Checked:** in Chromium at 1280 × 900: each signed fixture shows the banner and panel as
  above; the invoice shows no banner; signing it with the RSA test ID shows the new signature as
  intact, and so does the saved file when reopened.
- **Not covered yet:** a trust list (marking certificates as trusted), revocation (OCSP, CRLs),
  DocMDP (certifying signatures' permissions), and highlighting what changed
  on the page. Not yet compared with Acrobat's panel; see TESTING.md.

### 18. Phase 5: timestamps and older digital IDs (2026-11-20)

**Trusted timestamps (PAdES B-T).** The Digital ID tab has "Add a trusted timestamp", off by
default, with DigiCert (the default) or Sectigo as the timestamp server; the choice is
remembered in the browser. Once the signature is made, the SHA-256 hash of its signature value
(never the file) goes to the server in an RFC 3161 request with a nonce. The answer is checked
(granted, the hash we sent, our nonce, the token's own signature, a timestamping certificate
whose extended key usage is critical and timeStamping only, and that this certificate chains to
that server's own root, bundled in `packages/sign/src/tsaRoots.ts`) and added as the signatureTimeStampToken unsigned attribute. Room for it is set
aside (12 KB more); if the token is bigger than that, the file is prepared again with more room
and signed again. If the server can't be reached or its answer doesn't check out, signing stops
with the reason and asks whether to sign without a timestamp: the timestamp asked for is never
dropped silently.

- **Desktop only.** Neither server sends CORS headers (checked 2026-11-20: DigiCert answers the
  preflight with 501, Sectigo with no Access-Control headers, and neither sends them on the
  POST), and DigiCert's is plain http, which an https page can't call. So the web app shows the
  option switched off with "Timestamps are available in the desktop app", and the desktop app
  sends the request from Rust (`timestamp_request` in `apps/desktop/src-tauri/src/lib.rs`, ureq
  with rustls): it takes a server name, not an address, so only those two servers can be
  reached, with a request of at most 1 KB, an answer of at most 256 KB, no redirects and a 30 s
  limit. The app's own commands now need a permission in `capabilities/default.json` too
  (`build.rs` lists them).
- **Trusted roots:** DigiCert Trusted Root G4 and DigiCert Assured ID Root CA for DigiCert,
  Sectigo Public Time Stamping Root R46 and USERTrust RSA for Sectigo (with their SHA-256
  fingerprints in `tsaRoots.ts`; checked against real tokens). DigiCert's server only answers
  over plain http (https connections are reset), which is why the root check matters.
- **Checking:** `verifySignature` checks a timestamp token's signature, that its hash is of the
  signature value, the timestamp server's certificate (timestamping only, valid at that time)
  and whether it chains to one of the bundled roots. Only then does the panel say "Timestamped
  by … at …" and use its time (not the claimed `/M`) for "was the certificate valid when it was
  signed". A timestamp from any other server shows as present but not verified against a trust
  list (a warning), and `/M` is used. A timestamp that doesn't check out is a warning; neither
  breaks the signature.
- **Code:** `packages/sign/src/timestamp.ts` (request, checks, token), `cmsCheck.ts` (shared
  signer checks), `cms.ts` and `signWithRoom` in `index.ts`; `apps/web/src/sign/timestamp.ts`.
- **Tests:** `timestamp.test.ts` with an in-process test timestamp server (`testTsa.ts`, key in
  `fixtures/test-ids/test-tsa.p12`): the request (and a fixed DER example), a good answer
  embedded byte for byte, fetch with the right method and type, more room when needed, the
  timestamp's time used for validity, a home-made server refused (and its timestamp not
  trusted in a file), certificates with a non-critical or wider extended key usage refused, and
  refusals for a rejected request, a wrong hash, a wrong
  or missing nonce, a bad signature, no certificate, garbage, HTTP errors and no network.
  `signed-by-pdfoctopus-timestamped.pdf` is checked by pyhanko in CI as B-T (timestamp intact,
  trusted with `trust/pdfoctopus-test-tsa-ca.pem`, for this signature). By hand: files
  timestamped by the real DigiCert and Sectigo servers (from Node and from the Rust command)
  passed our check and pyhanko's, trusted against the system roots.

**Older `.p12` files** with 3DES or RC2 encryption (older Windows and macOS exports) now open:
the PKCS #12 key derivation (RFC 7292 appendix B), pbeWithSHAAnd3-KeyTripleDES-CBC,
2-KeyTripleDES, 128BitRC2 and 40BitRC2, and the integrity check (HMAC with SHA-1 or SHA-2, keyed
by the same derivation) are ours, in plain TypeScript (`pkcs12Pbe.ts`, `legacyCiphers.ts`; no
new dependency). AES files still go through PKI.js. The password and decrypted key bytes are
wiped after use. RC4 and anything else still gets "isn't supported", with how to export again.

- **Tests:** known answers for DES (Grabbe's worked example, FIPS 81), triple DES (NIST SP
  800-67), RC2 (RFC 2268), the key derivation and 3DES PBE (Go's x/crypto/pkcs12 vectors) and
  more derivations and CBC ciphertexts from OpenSSL 3.0.13, committed as hex. `test-signer-3des.p12`
  and the new `test-signer-rc2.p12` open, sign and verify; wrong passwords and RC4 are refused.
- **Not covered yet:** timestamps in the web app (see TESTING.md, "Needs you"), long-term
  validation (B-LT: revocation data), and checking Acrobat's view of a timestamped signature.

### 19. Phase 6: single-line text edits (2026-11-26)

**Edit text** (start of the Annotate row) outlines every line of text on the page: purple if it
can be edited, grey and dashed if not (hover or click for the reason). Click a line, type, and
press Enter to apply or Escape to cancel. The new text starts where the line did, in the same
font, size, colour and spacing, and nothing else on the page moves. **?** next to the tool says
what can and can't be edited. It's one undoable step, and saving stays incremental.

- **Engine:** `listTextLines`, `checkTextEdit` and `editTextLine` in
  `packages/core/src/engine.ts`, with `textEdit.ts` (finding and rewriting lines),
  `contentStream.ts` (a bounded content stream tokenizer and parser that keeps each operator's
  byte range), `textFonts.ts` and `fontEncoding.ts` (widths, encodings, ToUnicode CMaps,
  standard fonts).
- **How:** MuPDF's structured text (of the page's own content, not annotations) gives the lines.
  The content streams are followed operator by operator (text state, CTM, clipping, marked
  content) to work out where every glyph lands, and glyphs are matched to MuPDF's characters by
  position. Parts of a line MuPDF splits at a wide gap but one operator draws are joined.
  Only the operators that draw the line change: the first draws the new text, as a TJ array in
  the line's own font; the line's part of each other operator becomes a move of the same
  length (`[n] TJ`), so text after it in the same text object stays put. Glyphs before and
  after the line in the same operator (a table drawn by one TJ) are kept. Every other byte is
  unchanged, and the new stream replaces only the one it came from; undo puts the page's
  original streams back, byte for byte. "Actual text" marks around the old words are dropped.
- **Fonts:** a character is written in the line's own font only when the font is known to have
  its glyph (its ToUnicode map, a `/Differences` name, or the embedded program). Otherwise a
  standard font (Helvetica, Times or Courier, bold and italic matched, the family chosen by
  style and widths) is added to the page and used, for the whole line if it has every
  character, else only for the missing ones; the user is told which characters and font first.
  Characters neither has (Cyrillic, say) are refused.
- **Checked after every edit:** the page is read again and every other line must still be where
  it was, and the new text there; if not, the edit is undone and refused.
- **Warnings** (before applying): a stand-in font, text longer than the room before the next
  thing on the line or the page edge (allowed), a line that had several fonts, and a signed
  file (once per file). Text that would run past a clipping edge (a table cell) is refused, and
  under a clipping shape that isn't an upright rectangle (a curve, a slant) the new text can't
  be longer than the old. A stand-in font keeps the line's word spacing.
- **Refused, with the reason:** Chinese, Japanese and Korean text, right-to-left and vertical
  text, slanted or mirrored text, partly hidden (clipped) text, invisible text (scans' OCR
  layers), clipping text, Type 3 fonts, text in form XObjects, fonts with other encodings, text
  mixed in with other lines in one operator, and pages whose content can't be read (or past the
  limits: 32 MB of content, a million operators). Files whose permissions don't allow changes
  are refused until unlocked.
- **The page doesn't load MuPDF:** limits the app uses are in `textLimits.ts`, and
  `index.test.ts` checks nothing the package index reaches at run time imports MuPDF. Text
  being typed is kept by the app with its page held loaded, so scrolling away doesn't lose it.
- **Also fixed:** a second save of a file that uses cross-reference streams pointed its /Prev
  at a section that isn't there, so it needed repair or didn't open (`fixUpdatePrev`).
- **Tests:** `contentStream.test.ts` (strings, escapes, hex, nested brackets, TJ arrays,
  comments, inline images, broken input, limits) and `textEdit.test.ts`: the invoice edited
  (new text there, old gone, every other line where it was, pixels changed only around the
  line, incremental save that reopens unrepaired, undo restoring the exact streams), a body
  line on both contracts and two TeX files, the fallback font and its warning, refused
  characters, too wide, stale lists, each refusal on made-up pages, `'` and `"`, one cell of a
  one-TJ table, actual text, several content streams, rotated pages; a sweep listing the lines
  of the first two pages of every fixture (under a minute); and on eight fixtures, up to 25
  lines each edited and undone with a render compared before and after.
- **Checked:** in Chromium at 1280 × 900: the invoice edited, a line with "Ü" and "ö" (warning,
  then Helvetica), Escape, the help, saved, reopened with the new text; the CJK file refused.
- **Not covered yet:** paragraphs (text doesn't flow to the next line), multi-column, RTL and
  CJK (steps 2 and 3), text in form XObjects, and adding glyphs to subset fonts (a standard
  font is used instead). Not yet checked in Acrobat; see TESTING.md.

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
| 3   | [Security, compress & create](#phase-3-security-compress--create) | 2–3 wks  | 🟨 In progress |
| 4   | [Conversion](#phase-4-conversion)                                 | 2–3 wks  | 🟨 In progress |
| 5   | [Certificate signatures](#phase-5-certificate-signatures-pades)   | 2–3 wks  | 🟨 In progress |
| 6   | [True text editing](#phase-6-true-text-editing)                   | 4–8+ wks | 🟨 In progress |
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

- [x] Mark areas or search results for redaction
- [x] Apply redactions (true removal of text and images underneath, not black boxes)
- [ ] Test: redacted text can't be found or copied afterwards (automated tests pass; the
      search-and-copy check in Adobe Reader, in TESTING.md, is still to do)

### Forms

- [x] Fill AcroForm fields (text, checkbox, radio, dropdown, date) (date fields are filled in
      as text; form scripts don't run)
- [x] Create new fields: text, checkbox, radio, dropdown, signature, date
- [x] Edit field properties (name, required, default value) (moving and resizing fields come
      later)
- [x] Flatten forms
- [x] Detect XFA forms and show a clear warning (hybrid forms are filled in and their XFA copy
      removed; XFA-only forms get a warning when opened)

### Exit criteria

- [ ] Signed, annotated and filled PDFs display correctly in Adobe Reader
- [ ] Redaction verified as true removal on all relevant fixtures

---

## Phase 3: Security, compress & create

**Goal:** passwords, smaller files and making new PDFs.

### Password & permissions

- [x] Add an open password (AES-256)
- [x] Remove a password (when the user knows it; with the permissions password if the file
      restricts anything)
- [x] Set permissions: print, copy, edit, annotate, fill forms, assemble
- [x] Verify output with qpdf (opens with password, refuses without, reports AES-256) (checked
      by hand with libqpdf 11 through pikepdf; not in CI yet)
- [ ] Verify output in Adobe Acrobat and Adobe Reader

### Compress

- [x] Presets: High quality, Balanced, Smallest
- [x] Image downsampling for the "Smallest" preset (and "Balanced", at a higher resolution)
- [x] Show file size before and after
- [x] Optional "optimise and rebuild" save (High quality: rebuilt, pictures untouched)

### Create

- [x] Blank PDF (choose page size and count)
- [x] Images → PDF (JPG, PNG, multiple images, page order)
- [x] HTML → PDF (laid out by MuPDF's HTML engine: basic CSS, nothing fetched)
- [x] Plain text → PDF
- [x] Markdown → PDF

### Exit criteria

- [ ] Encrypted files open in Acrobat with the password and are refused without it
- [x] Compression never makes a file larger (fall back to the original if it would): a copy
      that isn't at least 1% smaller isn't offered for saving

---

## Phase 4: Conversion

**Goal:** get content out of PDFs and Office files into PDFs.

### PDF → other formats (in the browser)

- [x] PDF → PNG / JPG (choose resolution, pages)
- [x] PDF → HTML
- [x] PDF → plain text
- [x] PDF → SVG
- [x] Download multiple outputs as a ZIP

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

- [x] Create a signature field and reserve space for the signature with MuPDF
- [x] Build the CMS / PKCS#7 signature with PKI.js
- [x] Follow the PAdES baseline (B-B) profile
- [x] Optional: trusted timestamp (B-T) via a public timestamp server
- [x] Always save incrementally so earlier signatures stay valid
- [x] Link the visible signature appearance to the cryptographic signature

### Certificate sources

- [x] Web: load a `.p12` / `.pfx` file and sign in the browser (WebCrypto + PKI.js)
- [ ] Desktop: Windows certificate store (Rust)
- [ ] Desktop: USB smart cards / tokens (Rust)

### Validation

- [x] Signature panel listing signatures in a document and whether each is valid
- [x] Detect if a document was changed after signing

### Exit criteria

- [ ] Adobe Reader's signature panel shows "valid" for our signatures
- [ ] A second signature added later leaves the first one valid

---

## Phase 6: True text editing

**Goal:** edit existing text in place without breaking the layout. This is our differentiator.

### Step 1: single-line edits

- [x] Find text runs with structured-text extraction
- [x] Click-to-edit a line of text
- [x] Check the embedded font has the glyphs needed
- [x] Replace the run in the page content using the same embedded font
- [x] Fall back to the closest system font by metrics when glyphs are missing, and warn the user

### Step 2: paragraph reflow

- [ ] Detect paragraphs and their bounding boxes
- [ ] Reflow text inside the paragraph's box without shifting anything else on the page
- [ ] Warn when edited text no longer fits

### Step 3: complex layouts

- [ ] Multi-column text
- [ ] Right-to-left and CJK text

### Quality

- [ ] Regression tests against every fixture (render before/after and compare) (started: eight
      fixtures in `textEdit.test.ts`, and every fixture's lines listed)
- [x] Clear in-app explanation of what can and can't be edited

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
