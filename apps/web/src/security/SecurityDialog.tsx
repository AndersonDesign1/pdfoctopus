// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Passwords and permissions: protect the file with a password to open it, restrict what
// people can do with it (behind a permissions password), or remove its password. Changes take
// effect when the file is saved, which then rewrites the whole file (the project's rule:
// never rewrite without the user's agreement), so the dialog says so.

import type { PasswordSpec, Permissions, SecurityInfo } from "@pdfoctopus/core";
import { useState } from "react";
import { Modal } from "../ui/Dialogs";

const PERMISSION_LABELS: { key: keyof Permissions; label: string }[] = [
  { key: "print", label: "Print" },
  { key: "copy", label: "Copy text and pictures" },
  { key: "edit", label: "Change the content" },
  { key: "annotate", label: "Add comments and drawings" },
  { key: "fillForms", label: "Fill in forms and sign" },
  { key: "assemble", label: "Add, delete, rotate or move pages" },
];

const ALL: Permissions = {
  print: true,
  copy: true,
  edit: true,
  annotate: true,
  fillForms: true,
  assemble: true,
};

export function SecurityDialog({
  security,
  error,
  busy,
  onProtect,
  onRemove,
  onUnlock,
  onCancel,
}: {
  security: SecurityInfo;
  error?: string;
  busy: boolean;
  onProtect(spec: PasswordSpec): void;
  onRemove(): void;
  onUnlock(password: string): void;
  onCancel(): void;
}) {
  const [requireOpen, setRequireOpen] = useState(true);
  const [open1, setOpen1] = useState("");
  const [open2, setOpen2] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [permissions, setPermissions] = useState<Permissions>({ ...ALL, edit: false });
  const [owner1, setOwner1] = useState("");
  const [owner2, setOwner2] = useState("");
  const [unlock, setUnlock] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => {
    if (!busy) onCancel();
  };

  if (!security.canChange) {
    return (
      <Modal title="Password and permissions" onClose={close}>
        <form
          className="pdfo-field-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && unlock) onUnlock(unlock);
          }}
        >
          <p>
            This file limits what can be done with it. To change its password or permissions, enter
            its <strong>permissions password</strong> (not the one that opens it).
          </p>
          <label className="pdfo-field">
            Permissions password
            <input
              type="password"
              value={unlock}
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: the only thing to fill in
              autoFocus
              onChange={(e) => setUnlock(e.target.value)}
            />
          </label>
          {error && (
            <p className="pdfo-error" role="alert">
              {error}
            </p>
          )}
          <div className="pdfo-dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={busy || !unlock}>
              Unlock
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  const hasPassword =
    security.pending === "protect" || (security.encrypted && security.pending !== "remove");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!requireOpen && !restrict) {
      setProblem(
        "Tick at least one: a password to open the file, or limits on what people can do.",
      );
      return;
    }
    if (requireOpen && !open1) return setProblem("Type the password to open the file.");
    if (requireOpen && open1 !== open2) return setProblem("The two open passwords don't match.");
    if (restrict && !owner1) return setProblem("Type a permissions password.");
    if (restrict && owner1 !== owner2) {
      return setProblem("The two permissions passwords don't match.");
    }
    setProblem(null);
    onProtect({
      openPassword: requireOpen ? open1 : "",
      permissionsPassword: restrict ? owner1 : "",
      permissions: restrict ? permissions : ALL,
    });
  };

  return (
    <Modal title="Password and permissions" onClose={close}>
      <form className="pdfo-field-form" onSubmit={submit}>
        <p className="status">{describe(security)}</p>
        <label className="pdfo-choice">
          <input
            type="checkbox"
            checked={requireOpen}
            onChange={(e) => setRequireOpen(e.target.checked)}
          />
          Require a password to open the file
        </label>
        {requireOpen && (
          <div className="pdfo-password-pair">
            <label className="pdfo-field">
              Password
              <input
                type="password"
                value={open1}
                autoComplete="new-password"
                onChange={(e) => setOpen1(e.target.value)}
              />
            </label>
            <label className="pdfo-field">
              Type it again
              <input
                type="password"
                value={open2}
                autoComplete="new-password"
                onChange={(e) => setOpen2(e.target.value)}
              />
            </label>
          </div>
        )}
        <label className="pdfo-choice">
          <input
            type="checkbox"
            checked={restrict}
            onChange={(e) => setRestrict(e.target.checked)}
          />
          Limit what people can do with it
        </label>
        {restrict && (
          <>
            <fieldset className="pdfo-fieldset pdfo-permissions">
              <legend>People who open it can</legend>
              {PERMISSION_LABELS.map(({ key, label }) => (
                <label key={key} className="pdfo-choice">
                  <input
                    type="checkbox"
                    checked={permissions[key]}
                    onChange={(e) => setPermissions((p) => ({ ...p, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="pdfo-password-pair">
              <label className="pdfo-field">
                Permissions password
                <input
                  type="password"
                  value={owner1}
                  autoComplete="new-password"
                  onChange={(e) => setOwner1(e.target.value)}
                />
              </label>
              <label className="pdfo-field">
                Type it again
                <input
                  type="password"
                  value={owner2}
                  autoComplete="new-password"
                  onChange={(e) => setOwner2(e.target.value)}
                />
              </label>
            </div>
            <p className="status">
              Needed to change these limits later; it must differ from the open password. Most apps
              respect the limits, but they can't stop someone determined.
            </p>
          </>
        )}
        <p className="status">
          The file is encrypted with AES-256 when you save it, and{" "}
          <strong>saving will rewrite the whole file</strong>. If it's digitally signed, its
          signatures will no longer be valid. A forgotten password can't be recovered.
        </p>
        {(problem || error) && (
          <p className="pdfo-error" role="alert">
            {problem ?? error}
          </p>
        )}
        <div className="pdfo-dialog-actions">
          {hasPassword && (
            <button
              type="button"
              className="button danger pdfo-field-delete"
              disabled={busy}
              onClick={onRemove}
            >
              Remove password
            </button>
          )}
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy}>
            Protect
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One line on what the file has now, and what saving will do. */
function describe(s: SecurityInfo): string {
  if (s.pending === "remove") return "Saving will remove this file's password.";
  if (s.pending === "protect") {
    return s.pendingOpenPassword
      ? "Saving will add a password to open the file."
      : "Saving will limit what people can do with the file.";
  }
  if (s.encrypted) {
    return "This file has a password. Set a new one below, or remove it.";
  }
  return "This file has no password.";
}
