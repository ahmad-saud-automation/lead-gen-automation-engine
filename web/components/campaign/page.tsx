"use client";

/* One campaign (docs/UX-REDESIGN.md §4): a status card with the "Ready to go live" checklist and
 * the main buttons, then four sections in the order the work happens — Who · How many · Send to
 * · When — and everything rare under a closed Advanced. One Save for all of it. */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ExtraInfo } from "@/components/campaign/extra-info";
import { DEFAULT_SCHEDULE, WhenSection } from "@/components/campaign/when";
import { WhoSection, type SourceOption } from "@/components/campaign/who";
import { Confirm } from "@/components/modal";
import { Card, Checklist, Field, Note, PageHead, Pill, Progress, Step, Switch, SwitchRow } from "@/components/u";
import { ErrorBox, Loading } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { money, num } from "@/lib/format";
import { goWithNote, reloadWithNote } from "@/lib/nav";
import { campaignStatus, runHref } from "@/lib/status";
import type {
  CampaignCounts, CampaignDetail, CampaignRaw, CampaignsSaved, HistoryRow, ImportPreview, ImportsView,
  InstantlyOptions, LaneSchedule, LaneScheduleView, Readiness, RunStarted, SheetInfo,
} from "@/lib/types";
import { whenWords } from "@/lib/words";

/** Which section each checklist item's Fix opens. */
const FIX_TARGET: Record<string, string> = { who: "sec-who", send: "sec-send", on: "sec-status", many: "sec-many", when: "sec-when" };

function flash(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("u-flash");
  void el.offsetWidth;
  el.classList.add("u-flash");
}

const strip = (c: CampaignRaw): CampaignRaw => {
  const { schedule: _s, ...rest } = c;
  return rest as CampaignRaw;
};

export function CampaignPage({ id }: { id: string }) {
  const [meta, setMeta] = useState<CampaignDetail | null>(null);
  const [c, setC] = useState<CampaignRaw | null>(null);
  const [sched, setSched] = useState<LaneSchedule>(DEFAULT_SCHEDULE);
  const saved = useRef<{ c: string; s: string }>({ c: "", s: "" });
  const [error, setError] = useState("");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [src, setSrc] = useState<ImportPreview | null>(null);
  const [counts, setCounts] = useState<CampaignCounts | null>(null);
  const [counting, setCounting] = useState(false);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [inst, setInst] = useState<InstantlyOptions | null>(null);
  const [pasteId, setPasteId] = useState(false);
  const [lastRun, setLastRun] = useState<HistoryRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"" | "live" | "delete" | "autopush">("");
  const [busy, setBusy] = useState("");

  /* ── load ── */
  const loadInstantly = useCallback(() => {
    setInst(null);
    getJson<InstantlyOptions>("/instantly/options").then(setInst).catch((e: Error) => setInst({ ok: false, detail: e.message, campaigns: [], lists: [] }));
  }, []);

  useEffect(() => {
    getJson<CampaignDetail>("/campaigns/detail", { id })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setMeta(d);
        const raw = strip(structuredClone(d.campaign));
        setC(raw);
        saved.current.c = JSON.stringify(raw);
      })
      .catch((e: Error) => setError(e.message));
    getJson<LaneScheduleView>("/campaigns/schedule", { id })
      .then((v) => {
        if (v.error) return;
        setSched(v.schedule);
        saved.current.s = JSON.stringify(v.schedule);
      })
      .catch(() => {});
    Promise.all([getJson<SheetInfo>("/sheets/info").catch(() => null), getJson<ImportsView>("/imports").catch(() => null)])
      .then(([sh, im]) => setSources([
        ...(sh?.tabs ?? []).map((t) => ({ tab: t, label: `Google Sheet → ${t.trim()}` })),
        ...(im?.imports ?? []).map((i) => ({ tab: i.tab, label: `Uploaded → ${i.name} (${num(i.rows)} rows)` })),
      ]));
    getJson<{ runs: HistoryRow[] }>("/history")
      .then((h) => setLastRun((h.runs ?? []).find((r) => r.campaign === id && (r.kind ?? "run") === "run") ?? null))
      .catch(() => {});
    getJson<Readiness>("/campaigns/readiness", { id }).then(setReady).catch(() => {});
    loadInstantly();
  }, [id, loadInstantly]);

  // the source's columns, matching and first row — again whenever the source changes
  const tab = c?.tab ?? "";
  useEffect(() => {
    if (!tab) return;
    setSrc(null);
    getJson<ImportPreview>("/imports/preview", { tab }).then((p) => setSrc(p.error ? null : p)).catch(() => setSrc(null));
  }, [tab]);

  // live counts for what is on screen, saved or not
  const countKey = c ? JSON.stringify({ tab: c.tab, rules: c.rules, order: c.order, limits: c.limits, fieldmap: c.fieldmap }) : "";
  useEffect(() => {
    if (!c) return;
    setCounting(true);
    const t = setTimeout(() => {
      postJson<CampaignCounts>("/campaigns/preview", c).then(setCounts).catch(() => setCounts(null)).finally(() => setCounting(false));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countKey]);

  const dirty = useMemo(() => !!c && (JSON.stringify(c) !== saved.current.c || JSON.stringify(sched) !== saved.current.s), [c, sched]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (error || !c || !meta) {
    return (
      <div className="u-page">
        <PageHead title="Campaign" back={{ href: "/campaigns", label: "Campaigns" }} />
        {error ? <ErrorBox title="This campaign could not be loaded" detail={error} /> : <div className="u-card"><Loading rows={8} /></div>}
      </div>
    );
  }

  const set = (patch: Partial<CampaignRaw>) => setC((x) => (x ? { ...x, ...patch } : x));
  const setIn = <K extends "limits" | "writeback" | "instantly">(key: K, patch: NonNullable<CampaignRaw[K]>) =>
    setC((x) => (x ? { ...x, [key]: { ...(x[key] ?? {}), ...patch } } : x));

  /* ── save ── */
  const save = async () => {
    setSaving(true);
    setProblems([]);
    try {
      if (JSON.stringify(c) !== saved.current.c) {
        const r = await postJson<CampaignsSaved>("/campaigns/save", c);
        if (!r.ok) throw new Error((r.issues ?? []).map((i) => i.issue).join(" · ") || "The engine did not save it.");
      }
      if (JSON.stringify(sched) !== saved.current.s) {
        const r = await postJson<{ ok: boolean; problems?: string[] }>("/campaigns/schedule", { id, schedule: sched });
        if (!r.ok) throw new Error(`The rest was saved, but not the schedule: ${(r.problems ?? []).join(" · ")}`);
      }
      reloadWithNote(`${c.name || c.id} saved.`);
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
      setSaving(false);
    }
  };
  const discard = () => {
    setC(JSON.parse(saved.current.c));
    if (saved.current.s) setSched(JSON.parse(saved.current.s));
    setProblems([]);
  };

  /* ── actions ── */
  const run = async (test: boolean) => {
    setConfirm("");
    setBusy(test ? "test" : "live");
    try {
      const r = await postJson<RunStarted>("/campaign/run", { campaign: id, test_mode: test });
      if (r.error || !r.run_id) throw new Error(r.error || "The run did not start.");
      goWithNote(runHref(r.run_id), test ? "Free test started — nothing is spent or sent." : "Live run started.");
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
      setBusy("");
    }
  };
  const duplicate = async () => {
    setBusy("dup");
    try {
      const r = await postJson<CampaignsSaved>("/campaigns/create", { name: `${c.name || c.id} (copy)`, copy_from: id, tab: c.tab, fieldmap: c.fieldmap });
      if (!r.ok || !r.campaign) throw new Error((r.issues ?? []).map((i) => i.issue).join(" · ") || "Not copied.");
      goWithNote(`/campaigns/${encodeURIComponent(r.campaign)}`, "Copy created. It is off — choose its Instantly campaign, then switch it on.");
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
      setBusy("");
    }
  };
  const remove = async () => {
    setConfirm("");
    try {
      const r = await postJson<CampaignsSaved>("/campaigns/delete", { id });
      if (!r.ok) throw new Error((r.issues ?? []).map((i) => i.issue).join(" · ") || "Not deleted.");
      goWithNote("/campaigns", `${c.name || c.id} deleted. Its past runs and lead history are kept.`);
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
    }
  };

  const fix = (what: string) => {
    if (what === "test") return run(true);
    if (what === "settings") return (window.location.href = "/settings");
    if (what === "columns") return (window.location.href = `/leads/${encodeURIComponent(c.tab ?? "")}`);
    flash(FIX_TARGET[what] ?? "sec-who");
    if (what === "send") setTimeout(() => document.getElementById("inst-pick")?.focus({ preventScroll: true }), 400);
  };

  /* ── derived ── */
  const status = campaignStatus({
    enabled: !!c.enabled, instantly_campaign_id: c.instantly?.campaign_id ?? "",
    schedule: { via: sched.via, test_mode: sched.test_mode, active: sched.enabled && !!c.enabled, summary: "", next_run: "", problems: [] },
  });
  const instId = c.instantly?.campaign_id ?? "";
  const instKnown = inst?.campaigns.some((x) => x.id === instId);
  const companyHeader = src?.check?.resolved?.company_name ?? "";
  const sample = src?.sample?.[0];
  const perRun = Number(c.limits?.per_run ?? 50);
  const rate = counts && counts.per_run ? counts.est_cost_per_run : 0;
  const busyRun = !!busy || dirty;

  return (
    <div className="u-page">
      <PageHead
        back={{ href: "/campaigns", label: "Campaigns" }}
        title={<span className="u-row" style={{ gap: 12 }}>{c.name || c.id}<Pill tone={status.tone}>{status.label}</Pill></span>}
        sub={<>Reads <b className="u-ink">{(c.tab ?? "").replace(/^import:/, "uploaded file ")}</b>{status.why ? ` · ${status.why}` : ""}</>}
      />

      {problems.length ? <div style={{ marginBottom: 14 }}><ErrorBox title="That did not work" detail={problems.join(" · ")} /></div> : null}

      {/* status card */}
      <div className="u-card u-status" id="sec-status">
        <div>
          {ready ? (
            <>
              <b className="u-ink">{ready.done === ready.total ? "Ready to go live" : `Ready to go live: ${ready.done} of ${ready.total}`}</b>
              <div style={{ maxWidth: 380 }}><Progress done={ready.done} total={ready.total} /></div>
              <Checklist items={ready.items.map((it) => ({
                ok: it.ok,
                text: it.text,
                action: !it.ok && it.fix ? (
                  <button type="button" className="u-btn sm" onClick={() => fix(it.fix)} disabled={it.fix === "test" && busyRun}>
                    {it.fix === "test" ? "Run a free test" : "Fix"}
                  </button>
                ) : undefined,
              }))} />
              {dirty ? <p className="u-small u-muted" style={{ marginTop: 8 }}>This checklist is for the saved version — save to update it.</p> : null}
            </>
          ) : (
            <Loading rows={4} />
          )}
        </div>
        <div className="u-actions">
          <label className="u-row" style={{ justifyContent: "space-between", fontWeight: 600, color: "var(--ink)" }}>
            Campaign is {c.enabled ? "on" : "off"}
            <Switch label="Campaign is on" checked={!!c.enabled} onChange={(v) => set({ enabled: v })} />
          </label>
          <button type="button" className="u-btn primary" disabled={busyRun} onClick={() => run(true)}>
            {busy === "test" ? "Starting…" : "Run a free test"}
          </button>
          <button type="button" className="u-btn" disabled={busyRun || !c.enabled} onClick={() => setConfirm("live")}
            title={!c.enabled ? "Switch the campaign on first" : undefined}>
            Run live…
          </button>
          {lastRun && lastRun.found ? (
            <Link className="u-btn" href={runHref(lastRun.run_id, "send")}>Send found leads to Instantly</Link>
          ) : null}
          <span className="u-small u-muted">
            {dirty ? "Save your changes before running." : counts && !counts.error
              ? <>A live run takes {num(Math.min(perRun, counts.not_contacted))} leads and costs about <b>{money(rate)}</b>.</>
              : null}
            {lastRun ? <><br />Last run: {whenWords(lastRun.when)} — {num(lastRun.found)} of {num(lastRun.leads)} found{lastRun.test_mode ? " (test)" : ""}</> : null}
          </span>
        </div>
      </div>

      <div className="u-stack" style={{ marginTop: 14 }}>
        <WhoSection c={c} set={set} sources={sources} headers={src?.headers ?? []} resolved={src?.check?.resolved ?? {}}
          counts={counts} counting={counting} />

        <Step n={2} id="sec-many" title="How many" question="How fast should it work?">
          <div className="u-fgrid">
            <Field label="Leads per run" hint="How many leads one run works on.">
              <input className="u-input" type="number" min={1} aria-label="Leads per run" value={c.limits?.per_run ?? 50}
                onChange={(e) => setIn("limits", { per_run: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Leads per day" hint="Stops after this many in a day. 0 = no limit.">
              <input className="u-input" type="number" min={0} aria-label="Leads per day" value={c.limits?.per_day ?? 100}
                onChange={(e) => setIn("limits", { per_day: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Most it may spend per run ($)" hint="The run stops before it costs more.">
              <input className="u-input" type="number" min={0} step={0.5} aria-label="Most it may spend per run" value={c.limits?.max_spend_usd ?? 2}
                onChange={(e) => setIn("limits", { max_spend_usd: Number(e.target.value) || 0 })} />
            </Field>
          </div>
          {counts && !counts.error ? (
            <div style={{ marginTop: 14 }}>
              <Note>
                At {num(counts.per_run)} per run, a live run costs about <b>{money(counts.est_cost_per_run)}</b> (email checks)
                {c.limits?.per_day ? <>, and a full day about <b>{money(counts.est_cost_per_day)}</b></> : null}.
              </Note>
            </div>
          ) : null}
        </Step>

        <Step n={3} id="sec-send" title="Send to" question="Where do the found leads go?">
          <div className="u-fgrid two">
            <Field label="Instantly campaign" bad={!!inst && !inst.ok} hint={inst && !inst.ok
              ? <>{inst.detail}. <Link className="u-link" href="/settings">Settings</Link> · <button type="button" className="u-link" onClick={() => setPasteId(true)}>paste an ID instead</button></>
              : <>The list comes from your Instantly account. <button type="button" className="u-link" onClick={loadInstantly}>Refresh</button> · <button type="button" className="u-link" onClick={() => setPasteId(!pasteId)}>{pasteId ? "pick from the list" : "paste an ID instead"}</button></>}>
              {pasteId || (inst && !inst.ok) ? (
                <input id="inst-pick" className="u-input u-mono" aria-label="Instantly campaign ID" placeholder="00000000-0000-0000-0000-000000000000"
                  value={instId} onChange={(e) => setIn("instantly", { campaign_id: e.target.value.trim() })} />
              ) : (
                <select id="inst-pick" className="u-input" aria-label="Instantly campaign" value={instId} disabled={!inst}
                  onChange={(e) => setIn("instantly", { campaign_id: e.target.value })}>
                  <option value="">{inst ? "— choose one —" : "Loading your Instantly campaigns…"}</option>
                  {instId && inst && !instKnown ? <option value={instId}>{instId} (not found in your Instantly)</option> : null}
                  {(inst?.campaigns ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} — {x.status}</option>)}
                </select>
              )}
            </Field>
          </div>
          <div style={{ marginTop: 10 }}>
            <SwitchRow title="Send to Instantly automatically"
              desc="Off = you review each batch first, on the run's page. Turn on only when you trust this campaign."
              checked={!!c.auto_push} onChange={(v) => (v ? setConfirm("autopush") : set({ auto_push: false }))} />
            <SwitchRow title="Update my Google Sheet with the results"
              desc={(c.tab ?? "").startsWith("import:")
                ? "This campaign reads an uploaded file, so there is no sheet to update."
                : "Writes the email found, its check result and “sent” onto each row, so nobody is contacted twice."}
              checked={c.writeback?.enabled !== false} disabled={(c.tab ?? "").startsWith("import:")}
              onChange={(v) => setIn("writeback", { enabled: v })} />
          </div>
        </Step>

        <WhenSection s={sched} set={(p) => setSched((x) => ({ ...x, ...p }))} />

        <details className="u-adv">
          <summary>Advanced settings <span className="u-small u-muted" style={{ fontWeight: 400 }}>— extra info for Instantly, Instantly safety, names, copy or delete</span></summary>
          <div className="u-stack">
            <ExtraInfo labels={c.labels ?? []} onChange={(labels) => set({ labels })} headers={src?.headers ?? []}
              derived={meta.derived} sample={sample} sampleName={sample && companyHeader ? sample[companyHeader] : ""} issues={meta.label_issues} />

            <Card title="Instantly safety">
              <div className="u-fgrid">
                <Field label="Do-not-contact list in Instantly (ID)" hint="Instantly refuses any lead on this list. Blank = none.">
                  <input className="u-input u-mono" aria-label="Blocklist ID" value={c.instantly?.blocklist_id ?? ""}
                    onChange={(e) => setIn("instantly", { blocklist_id: e.target.value.trim() })} />
                </Field>
                <Field label="Also add leads to a list" hint="Optional.">
                  <select className="u-input" aria-label="Lead list" value={c.instantly?.list_id ?? ""} onChange={(e) => setIn("instantly", { list_id: e.target.value })}>
                    <option value="">— none —</option>
                    {c.instantly?.list_id && !inst?.lists.some((x) => x.id === c.instantly?.list_id) ? <option value={c.instantly.list_id}>{c.instantly.list_id}</option> : null}
                    {(inst?.lists ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ marginTop: 12 }}>
                <b className="u-ink">Don’t add a lead that is already…</b>
                <div className="u-row" style={{ marginTop: 6, gap: 18 }}>
                  {([["skip_if_in_workspace", "anywhere in my Instantly"], ["skip_if_in_campaign", "in this campaign"], ["skip_if_in_list", "in that list"]] as const).map(([k, label]) => (
                    <label key={k} className="u-check">
                      <input type="checkbox" checked={!!c.instantly?.[k]} onChange={(e) => setIn("instantly", { [k]: e.target.checked })} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </Card>

            <Card title="Names">
              <div className="u-fgrid">
                <Field label="Campaign name">
                  <input className="u-input" aria-label="Campaign name" value={c.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <Field label="Name written in the sheet’s “Campaign Type” column" hint="Shows which campaign handled a row.">
                  <input className="u-input" aria-label="Campaign Type" value={c.writeback?.campaign_type ?? ""} onChange={(e) => setIn("writeback", { campaign_type: e.target.value })} />
                </Field>
                <Field label="Internal ID" hint="Fixed. History and the sheet record it.">
                  <div className="u-mono" style={{ paddingTop: 8 }}>{c.id}</div>
                </Field>
                <Field label="Column matching file" hint={<>Edit the matching on the <Link className="u-link" href={`/leads/${encodeURIComponent(c.tab ?? "")}`}>Leads page</Link>.</>}>
                  <input className="u-input u-mono" aria-label="Column matching file" value={c.fieldmap ?? ""} onChange={(e) => set({ fieldmap: e.target.value.trim() })} />
                </Field>
              </div>
              <div className="u-row" style={{ marginTop: 16 }}>
                <button type="button" className="u-btn" onClick={duplicate} disabled={!!busy || dirty} title={dirty ? "Save first — the saved version is copied" : undefined}>
                  {busy === "dup" ? "Copying…" : "Copy this campaign"}
                </button>
                <button type="button" className="u-btn danger" onClick={() => setConfirm("delete")}>Delete campaign…</button>
              </div>
            </Card>
          </div>
        </details>
      </div>

      <div className={dirty ? "u-savebar show" : "u-savebar"} role="status" aria-hidden={!dirty}>
        <span>You have unsaved changes</span>
        <button type="button" className="u-btn sm" onClick={discard} disabled={saving}>Discard</button>
        <button type="button" className="u-btn sm primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save campaign"}</button>
      </div>

      {confirm === "live" ? (
        <Confirm title="Run live now?" confirmLabel="Run live" onConfirm={() => run(false)} onClose={() => setConfirm("")}
          body={<>
            <p>This run works on up to <b>{num(perRun)}</b> leads and costs about <b>{money(rate)}</b> in email checks.</p>
            <p className="muted">It finds and checks emails. Nothing is sent to Instantly unless “Send to Instantly automatically” is on.</p>
          </>} />
      ) : null}
      {confirm === "autopush" ? (
        <Confirm title="Send to Instantly without asking?" confirmLabel="Yes, send automatically" onConfirm={() => { set({ auto_push: true }); setConfirm(""); }} onClose={() => setConfirm("")}
          body={<p>After each run, every checked lead with an ice breaker goes straight into the Instantly campaign — you will not review it first. Save to make it take effect.</p>} />
      ) : null}
      {confirm === "delete" ? (
        <Confirm title={`Delete “${c.name || c.id}”?`} danger confirmLabel="Delete it" onConfirm={remove} onClose={() => setConfirm("")}
          body={<>
            <p>The campaign and its settings are removed. It stops running, and its Windows task (if any) is removed too.</p>
            <p className="muted">Nothing already sent is affected, and the lead history still remembers every lead it handled.</p>
          </>} />
      ) : null}
    </div>
  );
}
