// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The confirmation before redactions are applied. It says what will be removed, that saving
// will then rewrite the whole file (the project's rule: never rewrite without the user's
// agreement) and what that means for digital signatures.

import { Modal } from "../ui/Dialogs";

export function RedactDialog({
  marks,
  onApply,
  onCancel,
}: {
  /** How many redaction marks there are. */
  marks: number;
  onApply(): void;
  onCancel(): void;
}) {
  const what =
    marks === 1 ? "the area marked for redaction" : `the ${marks} areas marked for redaction`;
  return (
    <Modal title="Apply redactions?" onClose={onCancel}>
      <p>
        The text, pictures and drawings under {what} will be removed from the document for good, and
        black boxes drawn in their place. Comments, highlights and links under the marks are deleted
        too.
      </p>
      <p>
        So that nothing removed is left in the file,{" "}
        <strong>saving will rewrite the whole file</strong> instead of adding your changes to the
        end of it. If the file is digitally signed, its signatures will no longer be valid.
      </p>
      <p className="status">
        You can undo this until you close the file. Check the result before you share it: the
        document's title, bookmarks, attachments and hidden layers aren't changed.
      </p>
      <div className="pdfo-dialog-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button danger" onClick={onApply}>
          Apply redactions
        </button>
      </div>
    </Modal>
  );
}
