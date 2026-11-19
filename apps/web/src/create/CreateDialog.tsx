// SPDX-License-Identifier: AGPL-3.0-or-later
//
// New PDF: blank pages, pictures (one per page), or text, Markdown or HTML laid out on pages.
// The new PDF opens like any other, not yet saved.

import type { CreateSpec, PaperSize, TextKind } from "@pdfoctopus/core";
import { useRef, useState } from "react";
import { pictureToImage } from "../sign/stampImage";
import { Modal } from "../ui/Dialogs";

const PAPERS: { id: PaperSize; label: string }[] = [
  { id: "a4", label: "A4" },
  { id: "letter", label: "US Letter" },
  { id: "legal", label: "US Legal" },
  { id: "a5", label: "A5" },
  { id: "a3", label: "A3" },
];

const TEXT_KINDS: { id: TextKind; label: string }[] = [
  { id: "text", label: "Plain text" },
  { id: "markdown", label: "Markdown" },
  { id: "html", label: "HTML" },
];

/** US Letter where it's usual (the US, Canada, Mexico, the Philippines…), A4 elsewhere. */
export function defaultPaper(
  locale = typeof navigator === "undefined" ? "" : navigator.language,
): PaperSize {
  return /-(US|CA|MX|PH|CL|CO|VE|GT|CR|PA|DO|PR|SV)$/i.test(locale) ? "letter" : "a4";
}

/** The kind of text a file holds, from its name. */
export function textKindOf(name: string): TextKind {
  if (/\.(md|markdown|mdown)$/i.test(name)) return "markdown";
  if (/\.(html?|xhtml)$/i.test(name)) return "html";
  return "text";
}

/** The most a text file can be, in bytes. */
const MAX_TEXT_FILE = 10 * 1024 * 1024;

type Tab = "blank" | "pictures" | "text";

export function CreateDialog({
  busy,
  error,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  error?: string;
  /** Make the PDF: the spec, and a name for it. */
  onCreate(spec: CreateSpec, name: string): void;
  onCancel(): void;
}) {
  const [tab, setTab] = useState<Tab>("blank");
  const [paper, setPaper] = useState<PaperSize>(defaultPaper());
  const [landscape, setLandscape] = useState(false);
  const [pages, setPages] = useState(1);
  const [pictures, setPictures] = useState<{ id: number; file: File }[]>([]);
  const nextPictureId = useRef(1);
  const [fit, setFit] = useState<"picture" | "paper">("paper");
  const [text, setText] = useState("");
  const [textKind, setTextKind] = useState<TextKind>("text");
  const [textName, setTextName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  /** True while a text file is being read: the text can't be changed meanwhile. */
  const [reading, setReading] = useState(false);
  /** Counts file reads, so a slow one can't overwrite a later choice. */
  const readCount = useRef(0);
  const pictureInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const working = busy || preparing || reading;

  const close = () => {
    if (!working) onCancel();
  };

  const move = (from: number, to: number) => {
    setPictures((list) => {
      if (to < 0 || to >= list.length) return list;
      const next = list.slice();
      const [item] = next.splice(from, 1);
      if (item) next.splice(to, 0, item);
      return next;
    });
  };

  const loadText = async (file: File) => {
    if (file.size > MAX_TEXT_FILE) {
      setProblem("That file is too large (10 MB at most).");
      return;
    }
    const read = ++readCount.current;
    setReading(true);
    try {
      const contents = await file.text();
      if (read !== readCount.current) return;
      setText(contents);
      setTextKind(textKindOf(file.name));
      setTextName(file.name.replace(/\.[^.]+$/, ""));
      setProblem(null);
    } catch {
      if (read === readCount.current) setProblem("That file couldn't be read.");
    } finally {
      if (read === readCount.current) setReading(false);
    }
  };

  const create = async () => {
    if (working) return;
    setProblem(null);
    const format = { paper, landscape };
    if (tab === "blank") {
      if (!(pages >= 1 && pages <= 1000)) return setProblem("Choose 1 to 1000 pages.");
      onCreate({ kind: "blank", format, pages }, "Untitled");
      return;
    }
    if (tab === "text") {
      if (!text.trim()) return setProblem("Type or paste some text, or open a file.");
      onCreate({ kind: "text", source: text, textKind, format }, textName || "Untitled");
      return;
    }
    if (pictures.length === 0) return setProblem("Choose one or more pictures.");
    // Each picture is read (and turned the right way up) here; big ones are scaled down.
    setPreparing(true);
    try {
      const specs = [];
      for (const { file } of pictures) {
        try {
          const image = await pictureToImage(file);
          specs.push({ bytes: image.png, width: image.width, height: image.height });
        } catch (err) {
          setProblem(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      const name =
        pictures.length === 1
          ? (pictures[0]?.file.name.replace(/\.[^.]+$/, "") ?? "Pictures")
          : "Pictures";
      onCreate(
        {
          kind: "pictures",
          pictures: specs,
          layout: fit === "picture" ? { fit: "picture" } : { fit: "paper", paper },
        },
        name,
      );
    } finally {
      setPreparing(false);
    }
  };

  const paperChoice = (
    <div className="pdfo-create-paper">
      <label className="pdfo-field">
        Paper
        <select
          value={paper}
          disabled={working}
          onChange={(e) => setPaper(e.target.value as PaperSize)}
        >
          {PAPERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {tab !== "pictures" && (
        <label className="pdfo-choice">
          <input
            type="checkbox"
            checked={landscape}
            disabled={working}
            onChange={(e) => setLandscape(e.target.checked)}
          />
          Landscape
        </label>
      )}
    </div>
  );

  return (
    <Modal title="New PDF" onClose={close}>
      <div className="pdfo-field-form">
        <div className="pdfo-tabs" role="tablist" aria-label="Make a PDF from">
          {(
            [
              ["blank", "Blank pages"],
              ["pictures", "Pictures"],
              ["text", "Text"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="pdfo-tab"
              disabled={working}
              onClick={() => {
                setTab(id);
                setProblem(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "blank" && (
          <div role="tabpanel" className="pdfo-field-form">
            <label className="pdfo-field">
              Pages
              <input
                type="number"
                min={1}
                max={1000}
                value={pages}
                disabled={working}
                onChange={(e) => setPages(Math.floor(Number(e.target.value)))}
              />
            </label>
            {paperChoice}
          </div>
        )}

        {tab === "pictures" && (
          <div role="tabpanel" className="pdfo-field-form">
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => pictureInput.current?.click()}
              >
                Add pictures…
              </button>
              <input
                ref={pictureInput}
                className="visually-hidden"
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  setPictures((list) =>
                    [
                      ...list,
                      ...files.map((file) => ({ id: nextPictureId.current++, file })),
                    ].slice(0, 500),
                  );
                  setProblem(null);
                }}
              />
            </div>
            {pictures.length > 0 && (
              <ol className="pdfo-picture-list" aria-label="Pictures, in page order">
                {pictures.map(({ id, file }, i) => (
                  <li key={id}>
                    <span className="pdfo-picture-name">{file.name}</span>
                    <button
                      type="button"
                      className="tool icon"
                      disabled={working || i === 0}
                      aria-label={`Move ${file.name} up`}
                      onClick={() => move(i, i - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="tool icon"
                      disabled={working || i === pictures.length - 1}
                      aria-label={`Move ${file.name} down`}
                      onClick={() => move(i, i + 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="tool icon"
                      disabled={working}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setPictures((list) => list.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <fieldset className="pdfo-fieldset">
              <legend>Pages</legend>
              <label className="pdfo-choice">
                <input
                  type="radio"
                  name="pdfo-picture-fit"
                  checked={fit === "paper"}
                  disabled={working}
                  onChange={() => setFit("paper")}
                />
                On paper, with a margin (turned to suit each picture)
              </label>
              <label className="pdfo-choice">
                <input
                  type="radio"
                  name="pdfo-picture-fit"
                  checked={fit === "picture"}
                  disabled={working}
                  onChange={() => setFit("picture")}
                />
                Each page the size of its picture
              </label>
            </fieldset>
            {fit === "paper" && paperChoice}
          </div>
        )}

        {tab === "text" && (
          <div role="tabpanel" className="pdfo-field-form">
            <div className="pdfo-create-paper">
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => textInput.current?.click()}
              >
                Open a file…
              </button>
              <input
                ref={textInput}
                className="visually-hidden"
                type="file"
                accept=".txt,.text,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void loadText(file);
                }}
              />
              <label className="pdfo-field">
                It's
                <select
                  value={textKind}
                  disabled={working}
                  onChange={(e) => setTextKind(e.target.value as TextKind)}
                >
                  {TEXT_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="pdfo-field">
              Text
              <textarea
                className="pdfo-create-text"
                rows={10}
                value={text}
                disabled={working}
                placeholder="Type or paste here, or open a file"
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            {textKind === "html" && (
              <p className="status">
                Pictures and styles linked from elsewhere aren't fetched, and scripts don't run.
              </p>
            )}
            {paperChoice}
          </div>
        )}

        {(problem || error) && (
          <p className="pdfo-error" role="alert">
            {problem ?? error}
          </p>
        )}
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" disabled={working} onClick={close}>
            Cancel
          </button>
          <button type="button" className="button" disabled={working} onClick={() => void create()}>
            {working ? "Making it…" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
