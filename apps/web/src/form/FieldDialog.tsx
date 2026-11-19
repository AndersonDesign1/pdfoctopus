// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The properties of a form field: asked for when one is added (after its box is drawn), and
// shown to change, or delete, one in Edit fields mode. What's asked depends on the kind of
// field: a dropdown has options, a radio button a group and a value, a text field a default.

import type { FieldChanges, FieldKind, FormField, NewFieldKind } from "@pdfoctopus/core";
import { useState } from "react";
import { Modal } from "../ui/Dialogs";

/** What PDFoctopus calls each kind of field, for people. */
export const FIELD_KIND_NAMES: Record<NewFieldKind | FieldKind, string> = {
  text: "Text field",
  checkbox: "Checkbox",
  radio: "Radio button",
  combobox: "Dropdown",
  listbox: "List",
  date: "Date",
  signature: "Signature field",
  button: "Button",
};

export interface FieldProperties {
  name: string;
  required: boolean;
  defaultValue: string;
  options: string[];
  /** A new radio button's value. */
  value: string;
  /** A new text field that takes several lines. */
  multiline: boolean;
}

type Props =
  | {
      mode: "add";
      kind: NewFieldKind;
      suggestedName: string;
      /** For a radio button: a value its group doesn't have yet. */
      suggestedValue: string;
      error?: string;
      busy: boolean;
      onSubmit(props: FieldProperties): void;
      onCancel(): void;
    }
  | {
      mode: "edit";
      field: FormField;
      error?: string;
      busy: boolean;
      onSubmit(changes: FieldChanges): void;
      onDelete(): void;
      onCancel(): void;
    };

export function FieldDialog(props: Props) {
  const kind: NewFieldKind | FieldKind = props.mode === "add" ? props.kind : props.field.kind;
  const field = props.mode === "edit" ? props.field : null;
  const [name, setName] = useState(
    field ? field.partialName || field.name : props.mode === "add" ? props.suggestedName : "",
  );
  const [required, setRequired] = useState(field?.required ?? false);
  const [defaultValue, setDefaultValue] = useState(field?.defaultValue ?? "");
  const [options, setOptions] = useState(
    field ? field.options.map((o) => o.value).join("\n") : "Option 1\nOption 2",
  );
  const [value, setValue] = useState(props.mode === "add" ? props.suggestedValue : "");
  const [multiline, setMultiline] = useState(false);

  const hasDefault =
    kind === "text" || kind === "date" || kind === "combobox" || kind === "listbox";
  const hasOptions = kind === "combobox" || kind === "listbox";
  const optionList = options
    .split("\n")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  const what = FIELD_KIND_NAMES[kind].toLowerCase();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (props.busy) return;
    if (props.mode === "add") {
      props.onSubmit({ name, required, defaultValue, options: optionList, value, multiline });
      return;
    }
    const changes: FieldChanges = { name, required };
    if (hasDefault) changes.defaultValue = defaultValue;
    // Options are only sent when they change, so a field's own option labels are left alone.
    const before = field?.options.map((o) => o.value) ?? [];
    const same = before.length === optionList.length && before.every((o, i) => o === optionList[i]);
    if (hasOptions && !same) changes.options = optionList;
    props.onSubmit(changes);
  };

  return (
    <Modal
      title={props.mode === "add" ? `Add a ${what}` : `${FIELD_KIND_NAMES[kind]} properties`}
      onClose={props.onCancel}
    >
      <form className="pdfo-field-form" onSubmit={submit}>
        <label className="pdfo-field">
          {kind === "radio" ? "Group name" : "Name"}
          <input
            value={name}
            maxLength={100}
            required
            // biome-ignore lint/a11y/noAutofocus: the first thing to fill in, in a dialog just opened
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <span className="status">
            {kind === "radio"
              ? "Radio buttons with the same group name: only one of them can be chosen."
              : "Each field needs its own name. People filling in the form see it if there's no label."}
          </span>
        </label>
        {props.mode === "add" && kind === "radio" && (
          <label className="pdfo-field">
            Value when chosen
            <input value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        {hasOptions && (
          <label className="pdfo-field">
            Options, one per line
            <textarea rows={5} value={options} onChange={(e) => setOptions(e.target.value)} />
          </label>
        )}
        {hasDefault && (
          <div className="pdfo-field">
            <label htmlFor="pdfo-field-default">Default value (optional)</label>
            {hasOptions ? (
              <select
                id="pdfo-field-default"
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
              >
                <option value="">None</option>
                {optionList.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="pdfo-field-default"
                value={defaultValue}
                placeholder={kind === "date" ? "yyyy-mm-dd" : undefined}
                onChange={(e) => setDefaultValue(e.target.value)}
              />
            )}
          </div>
        )}
        {props.mode === "add" && kind === "text" && (
          <label className="pdfo-choice">
            <input
              type="checkbox"
              checked={multiline}
              onChange={(e) => setMultiline(e.target.checked)}
            />
            Several lines
          </label>
        )}
        <label className="pdfo-choice">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          Required
        </label>
        {kind === "date" && props.mode === "add" && (
          <p className="status">
            Dates are written as yyyy-mm-dd. Apps that run form scripts (Adobe Reader) check them.
          </p>
        )}
        {kind === "signature" && props.mode === "add" && (
          <p className="status">
            A box for a digital signature, signed in an app that supports them (Adobe Reader).
          </p>
        )}
        {props.error && (
          <p className="pdfo-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="pdfo-dialog-actions">
          {props.mode === "edit" && (
            <button
              type="button"
              className="button danger pdfo-field-delete"
              disabled={props.busy}
              onClick={props.onDelete}
            >
              Delete field
            </button>
          )}
          <button type="button" className="button secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={props.busy}>
            {props.mode === "add" ? "Add field" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
