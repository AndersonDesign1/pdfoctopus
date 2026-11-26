// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dialogs for the Edit text tool: the warnings before a change is made, and what can and
// can't be edited.

import { Modal } from "../ui/Dialogs";

export function TextEditConfirm({
  warnings,
  title = "Change this line?",
  applyLabel = "Change it",
  onApply,
  onCancel,
}: {
  warnings: string[];
  title?: string;
  applyLabel?: string;
  onApply(): void;
  onCancel(): void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      {warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
      <p className="status">You can undo the change with Ctrl+Z.</p>
      <div className="pdfo-dialog-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Keep editing
        </button>
        <button type="button" className="button" onClick={onApply}>
          {applyLabel}
        </button>
      </div>
    </Modal>
  );
}

export function TextEditHelp({ onClose }: { onClose(): void }) {
  return (
    <Modal title="Editing text" onClose={onClose}>
      <p>
        Click a line of text to change it, then press <kbd>Enter</kbd> to apply or <kbd>Esc</kbd> to
        cancel. The new text starts where the line did, in the same font, size and colour.
      </p>
      <p>
        <strong>A whole paragraph:</strong> click one of its lines, then{" "}
        <strong>Edit paragraph</strong>. The text flows from line to line inside the paragraph,
        lined up as it was; <kbd>Ctrl</kbd>+<kbd>Enter</kbd> applies. If it no longer fits, you're
        asked first, as the extra lines would overlap what's below. Nothing else on the page moves.
      </p>
      <p>
        <strong>Lines with a purple box</strong> can be edited. Lines with a grey dashed box can't;
        hover over one, or click it, to see why.
      </p>
      <p>What can't be edited yet:</p>
      <ul className="pdfo-help-list">
        <li>
          A paragraph in more than one font or size (a bold word, say) as a whole: edit it a line at
          a time. Text flowing from one column to the next, and tables.
        </li>
        <li>Chinese, Japanese and Korean text, right-to-left text, and vertical text.</li>
        <li>Slanted or mirrored text, and text that's partly hidden.</li>
        <li>
          Text inside a graphic placed on the page (a form XObject), or in a drawn (Type 3) font.
        </li>
        <li>The invisible text of a scan, which only makes it searchable.</li>
        <li>Files whose permissions don't allow changes, until they're unlocked (Password).</li>
      </ul>
      <p className="status">
        If the font in the file doesn't have a character you type (fonts are often embedded with
        only the letters used), a standard font (Helvetica, Times or Courier) is used instead, and
        you're told first. Comments, form fields and stamps are edited with their own tools.
      </p>
      <div className="pdfo-dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          OK
        </button>
      </div>
    </Modal>
  );
}
