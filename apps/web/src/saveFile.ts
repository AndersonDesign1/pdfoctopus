// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write files to the user's disk:
// - Desktop (Tauri): the native "Save as" dialog, then a direct write to the chosen path.
// - Browsers with the File System Access API (Chrome, Edge): the browser's "Save as" dialog.
// - Other browsers: a normal download.
//
// Where the platform allows it, a save returns a `SaveTarget`. Passing it to the next save
// writes to the same file again without asking ("Save" after a first "Save as").
//
// Choosing where to save and writing are separate steps (`chooseDestination` then
// `writeToDestination`), because browsers only show their pickers right after a click: the
// caller asks first, then does the slow work in the worker, then writes.

import { isTauri } from "@tauri-apps/api/core";

export type SaveResult = "saved" | "downloaded" | "cancelled";

interface WritableFile {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
interface FileHandle extends WritableFile {
  readonly name: string;
}
export interface DirectoryHandle {
  /** Rejects with a "NotFoundError" DOMException when the file doesn't exist and !create. */
  getFileHandle(name: string, options: { create: boolean }): Promise<WritableFile>;
}

// Not yet in TypeScript's DOM types.
interface FileSystemAccessWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileHandle>;
  showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<DirectoryHandle>;
}

/** Where a file was saved, so it can be saved there again without asking. */
export type SaveTarget = { kind: "path"; path: string } | { kind: "handle"; handle: FileHandle };

export interface SaveOutcome {
  result: SaveResult;
  /** Set when the file was written to a place it can be written to again. */
  target?: SaveTarget;
  /** The name the user chose, when known. */
  fileName?: string;
}

const PDF_TYPE = { description: "PDF document", accept: { "application/pdf": [".pdf"] } };

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function pdfBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

async function tauriWrite(path: string, bytes: Uint8Array): Promise<void> {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, bytes);
}

async function handleWrite(handle: WritableFile, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(pdfBlob(bytes));
  await writable.close();
}

function download(bytes: Uint8Array, suggestedName: string): SaveOutcome {
  const url = URL.createObjectURL(pdfBlob(bytes));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { result: "downloaded" };
}

/** Where one file will be written, chosen before the bytes exist. */
export type Destination =
  | { kind: "target"; target: SaveTarget; fileName: string }
  | { kind: "download"; fileName: string };

/**
 * Ask where to save one PDF ("Save as"), or reuse `target` from an earlier save without
 * asking. Resolves to null if the user cancelled. Call it straight from the click handler,
 * before any slow work, so the browser still allows its picker.
 */
export async function chooseDestination(
  suggestedName: string,
  target?: SaveTarget,
): Promise<Destination | null> {
  if (target) {
    const fileName = target.kind === "path" ? baseName(target.path) : target.handle.name;
    return { kind: "target", target, fileName };
  }
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: "PDF document", extensions: ["pdf"] }],
    });
    if (!path) return null;
    return { kind: "target", target: { kind: "path", path }, fileName: baseName(path) };
  }
  const fsWindow = window as FileSystemAccessWindow;
  if (!fsWindow.showSaveFilePicker) return { kind: "download", fileName: suggestedName };
  try {
    // Called as a method: the browser rejects it when detached from `window`.
    const handle = await fsWindow.showSaveFilePicker({ suggestedName, types: [PDF_TYPE] });
    return { kind: "target", target: { kind: "handle", handle }, fileName: handle.name };
  } catch (err) {
    if (isAbort(err)) return null;
    // E.g. the browser refused the picker. Fall back to a plain download rather than failing.
    return { kind: "download", fileName: suggestedName };
  }
}

/**
 * Write a PDF to a destination from `chooseDestination`. Errors writing a chosen file (disk
 * full, no permission) are real failures and are thrown, not hidden behind a download.
 */
export async function writeToDestination(
  destination: Destination,
  bytes: Uint8Array,
): Promise<SaveOutcome> {
  if (destination.kind === "download") return download(bytes, destination.fileName);
  const { target } = destination;
  if (target.kind === "path") await tauriWrite(target.path, bytes);
  else await handleWrite(target.handle, bytes);
  return { result: "saved", target, fileName: destination.fileName };
}

/** Choose a destination and write to it in one go, for bytes that are already at hand. */
export async function saveFile(
  bytes: Uint8Array,
  suggestedName: string,
  target?: SaveTarget,
): Promise<SaveOutcome> {
  const destination = await chooseDestination(suggestedName, target);
  if (!destination) return { result: "cancelled" };
  return writeToDestination(destination, bytes);
}

export interface NamedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * A name not yet taken in a folder: "report (page-1).pdf", else "report (page-1) 2.pdf", and
 * so on. `taken` also covers names chosen earlier in the same batch.
 */
export async function unusedName(
  name: string,
  exists: (candidate: string) => Promise<boolean>,
  taken: ReadonlySet<string> = new Set(),
): Promise<string> {
  const stem = name.replace(/\.pdf$/i, "");
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} ${n}.pdf`;
    if (!taken.has(candidate.toLowerCase()) && !(await exists(candidate))) return candidate;
  }
}

/** A folder to write several files into, or downloads when there's no folder picker. */
export type Folder =
  | { kind: "path"; path: string }
  | { kind: "handle"; handle: DirectoryHandle }
  | { kind: "download" };

/**
 * Ask for a folder to save several PDFs into (e.g. the parts of a split). Resolves to null
 * if the user cancelled. Call it straight from the click handler, like `chooseDestination`.
 */
export async function chooseFolder(): Promise<Folder | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, title: "Choose a folder for the new files" });
    return typeof path === "string" ? { kind: "path", path } : null;
  }
  const fsWindow = window as FileSystemAccessWindow;
  if (!fsWindow.showDirectoryPicker) return { kind: "download" };
  try {
    return { kind: "handle", handle: await fsWindow.showDirectoryPicker({ mode: "readwrite" }) };
  } catch (err) {
    if (isAbort(err)) return null;
    // Refused for another reason: fall back to downloads.
    return { kind: "download" };
  }
}

/**
 * Write several PDFs into a folder from `chooseFolder`. Existing files are never replaced: a
 * name already in use gets a number added. Downloads let the browser pick unused names.
 */
export async function writeFiles(
  folder: Folder,
  files: readonly NamedFile[],
): Promise<"saved" | "downloaded"> {
  if (folder.kind === "download") {
    for (const file of files) {
      download(file.bytes, file.name);
      // Browsers may drop downloads started in the same instant.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return "downloaded";
  }

  let exists: (name: string) => Promise<boolean>;
  let write: (name: string, bytes: Uint8Array) => Promise<void>;
  if (folder.kind === "path") {
    const fs = await import("@tauri-apps/plugin-fs");
    const separator = folder.path.includes("\\") ? "\\" : "/";
    const pathOf = (name: string) => `${folder.path.replace(/[\\/]$/, "")}${separator}${name}`;
    exists = (name) => fs.exists(pathOf(name));
    write = (name, bytes) => tauriWrite(pathOf(name), bytes);
  } else {
    const dir = folder.handle;
    exists = async (name) => {
      try {
        await dir.getFileHandle(name, { create: false });
        return true;
      } catch (err) {
        if (err instanceof DOMException && err.name === "NotFoundError") return false;
        throw err;
      }
    };
    write = async (name, bytes) =>
      handleWrite(await dir.getFileHandle(name, { create: true }), bytes);
  }

  const taken = new Set<string>();
  for (const file of files) {
    const name = await unusedName(file.name, exists, taken);
    taken.add(name.toLowerCase());
    await write(name, file.bytes);
  }
  return "saved";
}

/** "report.pdf" + "pages-1-3" → "report (pages-1-3).pdf". */
export function derivedName(fileName: string, suffix: string): string {
  const stem = fileName.replace(/\.pdf$/i, "");
  return `${stem} (${suffix}).pdf`;
}
