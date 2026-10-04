"use client";

import { useEffect, useState } from "react";

import { Card, Chip, ErrorBox, Field } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { reloadWithNote } from "@/lib/nav";

type Status = { required: boolean; password_set: boolean; set_at: string; server_requires: boolean };

/** Settings → Login. Saved on its own, never with "Save settings": the password lives in
 *  data/auth.json, which the browser is never sent. */
export function LoginCard() {
  const [s, setS] = useState<Status | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    getJson<Status>("/auth/status").then(setS).catch((e: Error) => setProblem(e.message));
  }, []);

  if (!s) return null;

  const call = async (path: string, body: object, note: string) => {
    setBusy(true);
    setProblem("");
    try {
      const r = await postJson<{ ok: boolean; error?: string }>(path, body);
      if (!r.ok) throw new Error(r.error || "Not saved.");
      reloadWithNote(note);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const mismatch = Boolean(again) && again !== next;

  return (
    <Card
      title="Login"
      label={s.password_set ? <Chip tone="up">password set</Chip> : "off"}
      foot={
        s.server_requires
          ? "This server requires a login, so the password can be changed but not removed."
          : "On your own PC a password is optional. On a server, always set one: anyone who reaches the address could otherwise spend credits and send email."
      }
    >
      <p className="muted">
        {s.password_set
          ? `Every page and every engine request needs this password. Set ${s.set_at}. Changing it signs every other browser out.`
          : "No password: anyone who can open this address can use the app."}
      </p>
      <div className="form-grid">
        {s.password_set ? (
          <Field label="Current password">
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
        ) : null}
        <Field label={s.password_set ? "New password" : "Password"} hint="at least 10 characters">
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Same again" hint={mismatch ? "does not match" : undefined}>
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
      </div>
      {problem ? <ErrorBox title="Not saved" detail={problem} /> : null}
      <div className="toolbar">
        <button
          type="button"
          className="ctl solid"
          disabled={busy || !next || next !== again || (s.password_set && !current)}
          onClick={() => call("/auth/password", { current, new: next }, s.password_set ? "Password changed." : "Password set. The app now asks for it.")}
        >
          {s.password_set ? "Change password" : "Set password"}
        </button>
        {s.password_set && !s.server_requires ? (
          <button
            type="button"
            className="ctl"
            disabled={busy || !current}
            onClick={() => call("/auth/clear", { current }, "Password removed. The app is open again.")}
          >
            Remove password
          </button>
        ) : null}
      </div>
    </Card>
  );
}
