// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The confirmation before a form is flattened: its fields become ordinary page content, so
// what was filled in can no longer be changed (until undone).

import { Modal } from "../ui/Dialogs";

export function FlattenDialog({ onFlatten, onCancel }: { onFlatten(): void; onCancel(): void }) {
  return (
    <Modal title="Flatten the form?" onClose={onCancel}>
      <p>
        Every field becomes part of the page, showing what's filled in now. Nobody will be able to
        change the answers, or fill in the empty fields, in any app.
      </p>
      <p className="status">
        Flatten a form before you send it when the answers should be final, or before redacting a
        field. You can undo this with Ctrl+Z.
      </p>
      <div className="pdfo-dialog-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button" onClick={onFlatten}>
          Flatten form
        </button>
      </div>
    </Modal>
  );
}
