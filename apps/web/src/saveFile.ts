// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write a file to the user's disk:
// - Desktop (Tauri): the native "Save as" dialog, then a direct write to the chosen path.
// - Browsers with the File System Access API (Chrome, Edge): the browser's "Save as" dialog.
// - Other browsers: a normal download.

import { isTauri } from "@tauri-apps/api/core";

export type SaveResult = "saved" | "downloaded" | "cancelled";

// Not yet in TypeScript's DOM types.
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

const PDF_TYPE = { description: "PDF document", accept: { "application/pdf": [".pdf"] } };

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function saveWithTauri(bytes: Uint8Array, suggestedName: string): Promise<SaveResult> {
  const [{ save }, { writeFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (!path) return "cancelled";
  await writeFile(path, bytes);
  return "saved";
}

function download(blob: Blob, suggestedName: string): SaveResult {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

export async function saveFile(bytes: Uint8Array, suggestedName: string): Promise<SaveResult> {
  if (isTauri()) return saveWithTauri(bytes, suggestedName);

  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const pickerWindow = window as SaveFilePickerWindow;
  if (!pickerWindow.showSaveFilePicker) return download(blob, suggestedName);

  let handle: Awaited<ReturnType<NonNullable<SaveFilePickerWindow["showSaveFilePicker"]>>>;
  try {
    // Called as a method: the browser rejects it when detached from `window`.
    handle = await pickerWindow.showSaveFilePicker({ suggestedName, types: [PDF_TYPE] });
  } catch (err) {
    if (isAbort(err)) return "cancelled";
    // E.g. the browser refused because too much time passed since the click.
    // Fall back to a plain download rather than failing.
    return download(blob, suggestedName);
  }
  // Errors writing the chosen file (disk full, no permission) are real failures and are
  // reported to the user, not hidden behind a second download.
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return "saved";
}
