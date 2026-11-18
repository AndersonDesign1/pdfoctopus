// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signatures and initials kept for reuse. They stay on this device only, in the browser's
// local storage (or the desktop app's, which is the same thing). Storage can be missing or
// full (private windows, blocked site data), so every read and write is allowed to fail:
// signing still works, the signature just isn't remembered.

export type SavedKind = "signature" | "initials";

export interface SavedSignature {
  id: string;
  kind: SavedKind;
  /** The PNG, as a data: URL. */
  dataUrl: string;
  /** Size of the PNG in pixels, for its proportions. */
  width: number;
  height: number;
  /** When it was saved (ms since 1970), newest first in the list. */
  savedAt: number;
}

/** The part of the Storage API used here, so tests can pass a fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY = "pdfoctopus.savedSignatures.v1";
/** At most this many of each kind are kept; the oldest go first. */
export const MAX_PER_KIND = 6;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // Accessing localStorage itself throws when site data is blocked.
  }
}

const PNG_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True for a data: URL whose payload decodes and starts like a PNG file. */
function isPngDataUrl(url: string): boolean {
  if (!url.startsWith(PNG_PREFIX)) return false;
  try {
    // Decoding all of it also catches a payload that was cut off or damaged.
    const binary = atob(url.slice(PNG_PREFIX.length));
    return PNG_SIGNATURE.every((byte, i) => binary.charCodeAt(i) === byte);
  } catch {
    return false;
  }
}

function isSaved(value: unknown): value is SavedSignature {
  const v = value as Partial<SavedSignature> | null;
  return (
    !!v &&
    typeof v.id === "string" &&
    (v.kind === "signature" || v.kind === "initials") &&
    typeof v.dataUrl === "string" &&
    isPngDataUrl(v.dataUrl) &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.savedAt === "number"
  );
}

/** Every saved signature and set of initials, newest first. Empty if storage can't be read. */
export function loadSaved(store = defaultStore()): SavedSignature[] {
  try {
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSaved).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Write the list. Returns false if it couldn't be stored (no storage, or it's full). */
function write(list: SavedSignature[], store: KeyValueStore | null): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remember a signature or initials. The oldest of that kind are dropped beyond
 * MAX_PER_KIND, and the oldest of any kind if storage is full. Returns the new list, or
 * null if even the new one alone couldn't be stored.
 */
export function addSaved(
  item: Omit<SavedSignature, "id" | "savedAt">,
  store = defaultStore(),
  now = Date.now(),
): SavedSignature[] | null {
  const entry: SavedSignature = { ...item, id: `${now.toString(36)}-${randomId()}`, savedAt: now };
  const list = [entry, ...loadSaved(store)];
  const kept: SavedSignature[] = [];
  const counts: Record<SavedKind, number> = { signature: 0, initials: 0 };
  for (const s of list) {
    if (counts[s.kind] < MAX_PER_KIND) {
      kept.push(s);
      counts[s.kind]++;
    }
  }
  // If storage is full, forget the oldest ones until the new one fits.
  while (kept.length > 0) {
    if (write(kept, store)) return kept;
    if (kept.length === 1) break;
    kept.pop();
  }
  return null;
}

/** Forget one. Returns the new list (unchanged if storage couldn't be written). */
export function removeSaved(id: string, store = defaultStore()): SavedSignature[] {
  const list = loadSaved(store);
  const next = list.filter((s) => s.id !== id);
  return write(next, store) ? next : list;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
