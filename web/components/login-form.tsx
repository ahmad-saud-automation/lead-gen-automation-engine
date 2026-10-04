"use client";

import { useEffect, useState } from "react";

import { Card, ErrorBox } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { hardGo } from "@/lib/nav";

type Status = { required: boolean; password_set: boolean; signed_in: boolean };

export function LoginForm({ next }: { next: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    getJson<Status>("/auth/status")
      .then((s) => {
        // already in, or no login on this machine: nothing to do here
        if (!s.required || s.signed_in) hardGo(next);
        else setStatus(s);
      })
      .catch((e: Error) => setProblem(e.message));
  }, [next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      const r = await postJson<{ ok: boolean; error?: string }>("/auth/login", { password });
      if (!r.ok) throw new Error(r.error || "Not signed in.");
      hardGo(next);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Card title="Lead Gen Engine" label="Sign in">
      {status && !status.password_set ? (
        <ErrorBox
          soft
          title="No password is set yet"
          detail={<>On the server, in the app folder, run <code>python set_password.py</code>, then reload this page.</>}
        />
      ) : (
        <form className="form-grid" onSubmit={submit}>
          <label className="span-all">
            <span>Password</span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="span-all toolbar">
            <button type="submit" className="ctl solid" disabled={busy || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      )}
      {problem ? <ErrorBox title="Not signed in" detail={problem} /> : null}
    </Card>
  );
}
