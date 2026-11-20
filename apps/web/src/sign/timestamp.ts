// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trusted timestamps for digital signatures (PAdES B-T): which timestamp server the user
// chose (remembered in this browser), and how the request reaches it. Only a hash of the
// signature is sent, never the file, and only when the user ticks the box. Browsers can't call
// the public timestamp servers themselves (they don't allow it), so the desktop app sends the
// request from its native side, to those two servers only.

import type { TimestampServer, TimestampTransport } from "@pdfoctopus/sign";
import { invoke, isTauri } from "@tauri-apps/api/core";

const KEY = "pdfoctopus.timestampServer";

export const SERVERS: { id: TimestampServer; name: string }[] = [
  { id: "digicert", name: "DigiCert" },
  { id: "sectigo", name: "Sectigo" },
];

export const DEFAULT_SERVER: TimestampServer = "digicert";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // Accessing localStorage itself throws when site data is blocked.
  }
}

/** The timestamp server chosen last time in this browser, or DigiCert. */
export function savedServer(store: Storage | null = storage()): TimestampServer {
  try {
    const value = store?.getItem(KEY);
    return SERVERS.some((s) => s.id === value) ? (value as TimestampServer) : DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

export function saveServer(server: TimestampServer, store: Storage | null = storage()): void {
  try {
    store?.setItem(KEY, server);
  } catch {
    // Not remembered; it's only a convenience.
  }
}

/** Whether timestamps can be added here: only in the desktop app (see the top of this file). */
export function timestampsAvailable(): boolean {
  return isTauri();
}

/** The server's name in messages, e.g. "DigiCert's timestamp server". */
export function serverName(server: TimestampServer): string {
  return `${SERVERS.find((s) => s.id === server)?.name ?? "The"}'s timestamp server`;
}

/** Sends the timestamp request through the desktop app's native side. */
export function desktopTransport(server: TimestampServer): TimestampTransport {
  return async (request) => {
    const answer = await invoke<ArrayBuffer>("timestamp_request", {
      server,
      request: Array.from(request),
    });
    return new Uint8Array(answer);
  };
}
