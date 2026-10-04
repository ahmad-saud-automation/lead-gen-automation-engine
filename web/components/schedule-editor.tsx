"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Card, Checks, ErrorBox, Field, Loading, Seg, type CheckItem } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { goWithNote } from "@/lib/nav";
import type { LaneSchedule, LaneScheduleView } from "@/lib/types";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const EVERY_UNIT: Record<LaneSchedule["kind"], string> = {
  minute: "minutes",
  hourly: "hours",
  daily: "days",
  weekly: "weeks",
};

/** A captioned row of several controls — a <label> may own only one, and must not nest. */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="fgroup span-all" role="group" aria-label={label}>
      <span className="cap">{label}</span>
      {children}
      {hint ? <small className="hint">{hint}</small> : null}
    </div>
  );
}

/** When this lane runs by itself. Saved on its own (not with "Save campaign"), because saving
 *  it may also create or remove the lane's Windows task. */
export function ScheduleEditor({ id, enabled, autoPush }: { id: string; enabled: boolean; autoPush: boolean }) {
  const [view, setView] = useState<LaneScheduleView | null>(null);
  const [s, setS] = useState<LaneSchedule | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    getJson<LaneScheduleView>("/campaigns/schedule", { id })
      .then((v) => {
        if (v.error) throw new Error(v.error);
        setView(v);
        setS(v.schedule);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <ErrorBox title="The schedule could not be loaded" detail={error} />;
  if (!view || !s) {
    return (
      <Card title="Schedule">
        <Loading rows={5} />
      </Card>
    );
  }

  const set = (patch: Partial<LaneSchedule>) => setS((x) => (x ? { ...x, ...patch } : x));
  const ranged = s.kind === "minute" || s.kind === "hourly";

  const save = async () => {
    setSaving(true);
    setProblems([]);
    try {
      const r = await postJson<LaneScheduleView & { ok: boolean; problems?: string[] }>(
        "/campaigns/schedule", { id, schedule: s });
      if (!r.ok) {
        setProblems(r.problems?.length ? r.problems : ["The engine did not save it."]);
        setSaving(false);
        return;
      }
      goWithNote(`/campaigns/${encodeURIComponent(id)}?tab=schedule`, r.schedule.enabled
        ? `Schedule saved: ${r.summary}${r.schedule.via === "windows" ? ", from Windows" : ", in the app"}.`
        : "Schedule saved: switched off.");
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
      setSaving(false);
    }
  };

  const state: CheckItem[] = [];
  if (!enabled) state.push({ tone: "warn", text: "The campaign itself is switched off (Setup), so the schedule will not fire until it is on." });
  if (view.active && view.next_run) state.push({ tone: "ok", text: <>Next run <b>{view.next_run}</b> — {view.summary}.</> });
  if (view.last?.fired_at) {
    state.push({
      tone: view.last.result === "started" ? "ok" : "warn",
      text: <>Last fired {view.last.fired_at.replace("T", " ")}: {view.last.result}{view.last.run_id ? <> (<a href={`/runs?run=${view.last.run_id}`}>run {view.last.run_id}</a>)</> : null}</>,
    });
  }
  if (view.task?.exists) state.push({ tone: "ok", text: <>Windows task <code>{view.task.name}</code> — next {view.task.next_run || "?"}.</> });
  state.push(s.test_mode
    ? { tone: "ok", text: "Test mode: scheduled runs make no API calls and spend nothing." }
    : { tone: "warn", text: "Live: each scheduled run spends credits, up to the daily spend cap in Settings." });
  if (autoPush) state.push({ tone: "warn", text: "Auto push is on (Setup): each run's send-ready leads go to Instantly without asking." });

  return (
    <Card
      title="Schedule"
      label={view.active ? "On" : "Off"}
      foot={
        <>
          <b>In the app</b> runs while the engine runs — on a server that is always.{" "}
          <b>From Windows</b> runs even when the app is closed. A lane uses one of them, never both. A run
          that is missed while the engine is off is skipped, not made up later.
        </>
      }
    >
      <Checks items={state} />
      <div className="switches one">
        <label className="switch-row">
          <span className="t"><b>Run on a schedule</b><em>off = only when you press Run</em></span>
          <input type="checkbox" role="switch" className="switch" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        </label>
        <label className="switch-row">
          <span className="t"><b>Test mode</b><em>no API calls, no spend — turn off for real runs</em></span>
          <input type="checkbox" role="switch" className="switch" checked={s.test_mode} onChange={(e) => set({ test_mode: e.target.checked })} />
        </label>
      </div>

      <div className="form-grid">
        <Group label="Runs" hint={view.windows_available ? undefined : "this engine is not on Windows, so only the app can run it"}>
          <span>
            <Seg
              label="Trigger"
              value={s.via}
              onChange={(v) => set({ via: view.windows_available ? v : "app" })}
              options={[
                { value: "app", label: "In the app" },
                ...(view.windows_available ? [{ value: "windows" as const, label: "From Windows" }] : []),
              ]}
            />
          </span>
        </Group>
        <Group label="How often">
          <span>
            <Seg
              label="How often"
              value={s.kind}
              onChange={(v) => set({ kind: v })}
              options={[
                { value: "minute", label: "Minutes" },
                { value: "hourly", label: "Hours" },
                { value: "daily", label: "Days" },
                { value: "weekly", label: "Weeks" },
              ]}
            />
          </span>
        </Group>
        <Field label={`Every (${EVERY_UNIT[s.kind]})`}>
          <input type="number" min={1} value={s.every} onChange={(e) => set({ every: Number(e.target.value) || 1 })} />
        </Field>
        <Field label={ranged ? "From" : "At"}>
          <input type="time" value={s.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        {ranged ? (
          <Field label="Until" hint={s.kind === "hourly" ? "blank = until midnight" : undefined}>
            <input type="time" value={s.end} onChange={(e) => set({ end: e.target.value })} />
          </Field>
        ) : null}
        {s.kind !== "daily" ? (
          <Group label={s.kind === "weekly" ? "On" : "Only on (optional)"} hint={s.kind === "weekly" ? undefined : "none ticked = every day"}>
            <span className="day-picks">
              {DAYS.map((d) => (
                <label key={d} className="day-pick">
                  <input
                    type="checkbox"
                    checked={s.days.includes(d)}
                    onChange={(e) => set({ days: e.target.checked ? [...s.days, d] : s.days.filter((x) => x !== d) })}
                  />
                  {d.slice(0, 1) + d.slice(1).toLowerCase()}
                </label>
              ))}
            </span>
          </Group>
        ) : null}
      </div>

      {problems.length ? (
        <ErrorBox title="Not saved" detail={<ul className="issue-list">{problems.map((p, k) => <li key={k}>{p}</li>)}</ul>} />
      ) : null}
      <div className="toolbar">
        <button type="button" className="ctl solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </Card>
  );
}
