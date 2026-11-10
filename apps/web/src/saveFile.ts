// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write files to the user's disk:
// - Desktop (Tauri): the native "Save as" dialog, then a direct write to the chosen path.
// - Browsers with the File System Access API (Chrome, Edge): the browser's "Save as" dialog.
// - Other browsers: a normal download.
//
// Where the platform allows it, a save returns a `SaveTarget`. Passing it to the next save
// writes to the same file again without asking ("Save" after a first "Save as").

import { isTauri } from "@tauri-apps/api/core";

export type SaveResult = "saved" | "downloaded" | "cancelled";

interface WritableFile {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
interface FileHandle extends WritableFile {
  readonly name: string;
}
interface DirectoryHandle {
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

async function saveWithTauri(bytes: Uint8Array, suggestedName: string): Promise<SaveOutcome> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (!path) return { result: "cancelled" };
  await tauriWrite(path, bytes);
  return { result: "saved", target: { kind: "path", path }, fileName: baseName(path) };
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

/**
 * Save one PDF. With a `target` from an earlier save, write there directly; otherwise ask
 * where to save it ("Save as").
 */
export async function saveFile(
  bytes: Uint8Array,
  suggestedName: string,
  target?: SaveTarget,
): Promise<SaveOutcome> {
  if (target?.kind === "path") {
    await tauriWrite(target.path, bytes);
    return { result: "saved", target, fileName: baseName(target.path) };
  }
  if (target?.kind === "handle") {
    await handleWrite(target.handle, bytes);
    return { result: "saved", target, fileName: target.handle.name };
  }

  if (isTauri()) return saveWithTauri(bytes, suggestedName);

  const fsWindow = window as FileSystemAccessWindow;
  if (!fsWindow.showSaveFilePicker) return download(bytes, suggestedName);

  let handle: FileHandle;
  try {
    // Called as a method: the browser rejects it when detached from `window`.
    handle = await fsWindow.showSaveFilePicker({ suggestedName, types: [PDF_TYPE] });
  } catch (err) {
    if (isAbort(err)) return { result: "cancelled" };
    // E.g. the browser refused because too much time passed since the click.
    // Fall back to a plain download rather than failing.
    return download(bytes, suggestedName);
  }
  // Errors writing the chosen file (disk full, no permission) are real failures and are
  // reported to the user, not hidden behind a second download.
  await handleWrite(handle, bytes);
  return { result: "saved", target: { kind: "handle", handle }, fileName: handle.name };
}

export interface NamedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Save several PDFs (e.g. the parts of a split) into one folder the user picks. Browsers
 * without a folder picker download them one by one instead.
 */
export async function saveFiles(files: readonly NamedFile[]): Promise<SaveResult> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const folder = await open({ directory: true, title: "Choose a folder for the new files" });
    if (typeof folder !== "string") return "cancelled";
    const separator = folder.includes("\\") ? "\\" : "/";
    for (const file of files) {
      await tauriWrite(`${folder.replace(/[\\/]$/, "")}${separator}${file.name}`, file.bytes);
    }
    return "saved";
  }

  const fsWindow = window as FileSystemAccessWindow;
  if (fsWindow.showDirectoryPicker) {
    let folder: DirectoryHandle | undefined;
    try {
      folder = await fsWindow.showDirectoryPicker({ mode: "readwrite" });
    } catch (err) {
      if (isAbort(err)) return "cancelled";
      // Refused for another reason: fall back to downloads below.
    }
    if (folder) {
      for (const file of files) {
        await handleWrite(await folder.getFileHandle(file.name, { create: true }), file.bytes);
      }
      return "saved";
    }
  }

  for (const file of files) {
    download(file.bytes, file.name);
    // Browsers may drop downloads started in the same instant.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "downloaded";
}

/** "report.pdf" + "pages-1-3" → "report (pages-1-3).pdf". */
export function derivedName(fileName: string, suffix: string): string {
  const stem = fileName.replace(/\.pdf$/i, "");
  return `${stem} (${suffix}).pdf`;
}
