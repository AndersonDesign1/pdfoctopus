// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign with a digital ID: a certificate and private key in a .p12 / .pfx file. The file is
// read and its key unlocked here, in the browser; the password and key are never stored or
// sent anywhere, and are forgotten when the dialog closes or the signature is made.

import type { SignatureFieldInfo } from "@pdfoctopus/core";
import type { SigningIdentity, TimestampServer } from "@pdfoctopus/sign";
import { useEffect, useId, useRef, useState } from "react";
import { MAX_DIGITAL_ID_BYTES } from "./certificate";
import { SERVERS, savedServer, saveServer, timestampsAvailable } from "./timestamp";

/** What to sign with, and where. */
export interface CertificateChoice {
  identity: SigningIdentity;
  reason: string;
  location: string;
  /** An empty signature field to sign, or null for a new box placed on the page. */
  field: SignatureFieldInfo | null;
  /** The timestamp server to add a trusted timestamp from, or null for none (the default). */
  timestamp: TimestampServer | null;
}

const MAX_TEXT = 200;

function day(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function CertificatePanel({
  fields,
  onChoose,
  onCancel,
}: {
  /** The document's empty signature fields (null while they're being looked up). */
  fields: SignatureFieldInfo[] | null;
  onChoose(choice: CertificateChoice): void;
  onCancel(): void;
}) {
  const baseId = useId();
  const [file, setFile] = useState<File>();
  const [password, setPassword] = useState("");
  const [identity, setIdentity] = useState<SigningIdentity | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  /** The field to sign, by name, or "" for a new box. */
  const [where, setWhere] = useState<string | null>(null);
  const canTimestamp = timestampsAvailable();
  // Off by default; the server chosen last time is remembered.
  const [timestamped, setTimestamped] = useState(false);
  const [server, setServer] = useState<TimestampServer>(() => savedServer());

  // Mounted: results that arrive after the dialog closed are dropped.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const empty = fields ?? [];
  const chosenWhere = where ?? (empty[0]?.name || "");

  async function unlock() {
    if (!file) return;
    setError(undefined);
    setIdentity(null);
    setProblem(null);
    if (file.size > MAX_DIGITAL_ID_BYTES) {
      setError("This file is too big to be a digital ID (.p12 or .pfx).");
      return;
    }
    setWorking(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Loaded only when needed: PKI.js is large, and most people never sign this way.
      const sign = await import("@pdfoctopus/sign");
      const loaded = await sign.loadDigitalId(bytes, password);
      bytes.fill(0);
      if (!open.current) return;
      setIdentity(loaded);
      setProblem(sign.identityProblem(loaded));
      // Not needed any more: the key is unlocked.
      setPassword("");
    } catch (err) {
      if (open.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (open.current) setWorking(false);
    }
  }

  const ready = identity !== null && problem === null && fields !== null;
  const field = empty.find((f) => f.name === chosenWhere) ?? null;

  return (
    <>
      <p className="pdfo-hint pdfo-cert-intro">
        A digital signature uses a certificate from a certificate provider (a .p12 or .pfx file). It
        shows who signed and whether the file was changed afterwards. Your file, password and key
        stay on this device.
      </p>
      {!identity && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <label className="pdfo-field">
            Your digital ID (.p12 or .pfx)
            <input
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              onChange={(e) => {
                setFile(e.target.files?.[0]);
                setError(undefined);
              }}
            />
          </label>
          <label className="pdfo-field">
            Its password
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="pdfo-row">
            <button type="submit" className="button secondary" disabled={!file || working}>
              {working ? "Opening…" : "Open digital ID"}
            </button>
          </div>
        </form>
      )}

      {identity && (
        <>
          <div className="pdfo-cert-summary" aria-live="polite">
            <strong>{identity.name}</strong>
            <span className="pdfo-hint">
              Issued by {identity.issuer} · valid until {day(identity.notAfter)}
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setIdentity(null);
                setProblem(null);
                setFile(undefined);
              }}
            >
              Use another
            </button>
          </div>
          {problem && (
            <p className="pdfo-error" role="alert">
              {problem}
            </p>
          )}
          <label className="pdfo-field">
            Reason (optional)
            <input
              type="text"
              value={reason}
              maxLength={MAX_TEXT}
              placeholder="e.g. I approve this document"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="pdfo-field">
            Location (optional)
            <input
              type="text"
              value={location}
              maxLength={MAX_TEXT}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
          {empty.length > 0 && (
            <fieldset className="pdfo-fieldset">
              <legend>Where</legend>
              {empty.map((f) => (
                <label key={`${f.page}:${f.name}`} className="pdfo-choice">
                  <input
                    type="radio"
                    name={`${baseId}-where`}
                    checked={chosenWhere === f.name}
                    onChange={() => setWhere(f.name)}
                  />
                  In the field “{f.name}” (page {f.page + 1})
                </label>
              ))}
              <label className="pdfo-choice">
                <input
                  type="radio"
                  name={`${baseId}-where`}
                  checked={chosenWhere === ""}
                  onChange={() => setWhere("")}
                />
                In a new box I place on the page
              </label>
            </fieldset>
          )}
          <fieldset className="pdfo-fieldset">
            <legend>Trusted timestamp</legend>
            <label className="pdfo-choice">
              <input
                type="checkbox"
                checked={canTimestamp && timestamped}
                disabled={!canTimestamp}
                onChange={(e) => setTimestamped(e.target.checked)}
              />
              Add a trusted timestamp
            </label>
            {canTimestamp ? (
              <>
                <p className="pdfo-hint">
                  Proves when you signed, even after your certificate expires. Only a fingerprint
                  (hash) of the signature is sent to the timestamp server, never the file.
                </p>
                {timestamped && (
                  <label className="pdfo-field">
                    Timestamp server
                    <select
                      value={server}
                      onChange={(e) => {
                        const next = e.target.value as TimestampServer;
                        setServer(next);
                        saveServer(next);
                      }}
                    >
                      {SERVERS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <p className="pdfo-hint">
                Timestamps are available in the desktop app: browsers can't reach the timestamp
                servers.
              </p>
            )}
          </fieldset>
          <p className="pdfo-hint">
            Signing includes your unsaved changes. Changes made after signing are added after the
            signature, which stays valid and shows they were made later.
          </p>
        </>
      )}

      {error && (
        <p className="pdfo-error" role="alert">
          {error}
        </p>
      )}

      <div className="pdfo-dialog-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready}
          onClick={() => {
            if (identity) {
              onChoose({
                identity,
                reason,
                location,
                field,
                timestamp: canTimestamp && timestamped ? server : null,
              });
            }
          }}
        >
          {field ? "Sign" : "Place signature"}
        </button>
      </div>
    </>
  );
}
