"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Confirm, Modal } from "@/components/modal";
import { Card, Checks, Chip, ErrorBox, Loading, Seg, Tile } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { money, num } from "@/lib/format";
import { flashNote, goWithNote } from "@/lib/nav";
import type { PushPreview, RunEvent, RunSnapshot, RunStarted } from "@/lib/types";

type Filter = "all" | "success" | "fail" | "held" | "skip" | "retry";

const FILTERS: Filter[] = ["all", "success", "fail", "held", "skip", "retry"];

/** Only an outcome is coloured: found green, failed red, held back amber. */
const TONE: Record<string, "up" | "down" | "warn" | undefined> = {
  success: "up",
  fail: "down",
  held: "warn",
  retry: "warn",
};

const STAGE: Record<string, string> = {
  organize: "Organising leads",
  gateway: "Checking mail gateways",
  endole: "Trying the existing address",
  pattern: "Guessing address patterns",
  verify: "Verifying addresses",
  icypeas: "Searching Icypeas",
  anymail: "Searching Anymailfinder",
  icebreaker: "Writing ice breakers",
  push: "Pushing to Instantly",
  sheet: "Writing back to the sheet",
  result: "Recording the result",
  done: "Finished",
};

/** The feed keeps this many events at most; older ones are still in the log download. */
const FEED_CAP = 3000;

export function RunMonitor({ runId }: { runId?: string }) {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [confirmPush, setConfirmPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const since = useRef(0);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Poll while the run is live. The engine hands back only events newer than `since`, so a
  // 20,000-event run never re-sends its whole history.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    since.current = 0;
    setEvents([]);

    const tick = async () => {
      try {
        const r = await getJson<RunSnapshot>("/run/status", { run_id: runId ?? "", since: String(since.current) });
        if (!alive) return;
        setRun(r);
        setError("");
        const fresh = r.events ?? [];
        if (fresh.length) {
          since.current = Math.max(since.current, ...fresh.map((e) => e.seq)) + 1;
          setEvents((x) => [...x, ...fresh].slice(-FEED_CAP));
        }
        if (r.status === "running") timer = setTimeout(tick, 900);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        // The engine may just be restarting: keep trying, more slowly.
        timer = setTimeout(tick, 4000);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId]);

  // Follow the feed, unless someone has scrolled up to read something.
  useEffect(() => {
    const el = feed.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, filter]);

  if (!run) {
    return error ? <ErrorBox title="The run could not be loaded" detail={error} /> : <Card><Loading rows={6} /></Card>;
  }

  if (!run.run_id) {
    return (
      <Card title="No run yet">
        <p className="muted">
          Start one from <Link href="/campaigns">Campaigns</Link>. A test-mode run costs nothing and
          proves the rules, the field map and the payload.
        </p>
      </Card>
    );
  }

  const id = run.run_id;
  const c = run.counters ?? {};
  const live = run.status === "running";
  const isPush = run.kind === "push";
  const pct = run.total ? Math.round(((run.processed ?? 0) / run.total) * 100) : 0;
  const shown = events.filter((e) => filter === "all" || e.status === filter);
  const byStatus = events.reduce<Record<string, number>>((m, e) => {
    if (e.status) m[e.status] = (m[e.status] ?? 0) + 1;
    return m;
  }, {});

  const stop = async () => {
    setBusy(true);
    try {
      // V2 posted no run_id here, so the engine never found the run and Stop did nothing.
      const r = await postJson<{ ok: boolean }>("/run/cancel", { run_id: id });
      flashNote(r.ok
        ? "Stopping after the current lead…"
        : { text: "The engine no longer holds this run in memory — it has probably just finished.", tone: "warn" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const openPreview = async () => {
    setPreviewError("");
    try {
      setPreview(await getJson<PushPreview>("/push/preview", { run_id: id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doPush = async (testMode: boolean) => {
    setConfirmPush(false);
    setBusy(true);
    try {
      const r = await postJson<RunStarted>("/push/start", { run_id: id, test_mode: testMode, confirm: true });
      if (r.error || !r.run_id) throw new Error(r.error || "The engine did not start the push.");
      goWithNote(`/runs?run=${r.run_id}`, testMode ? "Dry run started — nothing is being sent." : "Push started.");
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const title = live
    ? STAGE[run.stage ?? ""] ?? "Working"
    : run.status === "finished"
      ? isPush ? "Push finished" : "Run finished"
      : `Run ${run.status}`;

  return (
    <div className="stack">
      {error ? <ErrorBox soft title="Lost touch with the engine — retrying" detail={error} /> : null}

      <Card>
        <div className="activity">
          <div className="activity-main">
            <span className="lbl">
              {isPush ? "Push to Instantly" : "Current activity"}
              {live ? <span className="live-dot"> running</span> : null}
            </span>
            <h2>{title}</h2>
            <div className="chip-wrap">
              {run.campaign_name ? <Chip>{run.campaign_name}</Chip> : null}
              {run.test_mode
                ? <Chip tone="warn">{isPush ? "dry run — nothing sent" : "test mode — no API calls, no spend"}</Chip>
                : <Chip tone="down">live</Chip>}
              <span className="mono faint">{id}</span>
              <span className="faint">started {run.started}</span>
              {isPush && run.source_run ? (
                <a className="btn-link" href={`/runs?run=${run.source_run}`}>from run {run.source_run}</a>
              ) : null}
            </div>
          </div>
          <div className="row-btns">
            {live ? (
              <button type="button" className="ctl danger" onClick={stop} disabled={busy}>
                Stop
              </button>
            ) : (
              <>
                <a className="ctl sm" href={`/api/results/download?run_id=${id}`}>Results CSV</a>
                <a className="ctl sm" href={`/api/log/download?run_id=${id}`}>Event log CSV</a>
                {!isPush ? (
                  <button type="button" className="ctl solid" onClick={openPreview} disabled={busy}>
                    Review push
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="progress" aria-label={`${pct}% done`}>
          <span className={live ? "progress-fill" : "progress-fill done"} style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-foot">
          <span>{num(run.processed)} of {num(run.total)} leads</span>
          <span className="num">{pct}%</span>
        </div>

        {run.selection ? (
          <p className="muted">
            Selected from <b>{num(run.selection.matched)}</b> matching rows —{" "}
            {num(run.selection.blocked_by_ledger)} already handled, {num(run.selection.available)} available,{" "}
            <b>{num(run.selection.selected)}</b> taken this run
            {run.selection.day_remaining < 1e6 ? <> ({num(run.selection.day_remaining)} left in today&apos;s limit)</> : null}.
          </p>
        ) : null}

        {run.status === "finished" && !isPush && !c.pushed ? (
          <Checks items={[{ tone: "ok", text: <>Enrichment finished. Nothing has been sent — use <b>Review push</b> when you are ready.</> }]} />
        ) : null}
      </Card>

      {isPush ? (
        <div className="band cols-4 stats">
          <Tile
            label="Pushed"
            title={run.test_mode ? "Would be added (nothing sent)" : "Added to Instantly"}
            value={num(c.pushed)}
          />
          <Tile label="Skipped" title="Already in Instantly" value={num(c.push_skipped)} />
          <Tile label="Failed" title="Refused or errored" value={num(c.push_failed)} chips={c.push_failed ? <Chip tone="down">see the feed</Chip> : undefined} />
          <Tile label="Mode" title="What this push did" value={run.test_mode ? "Dry run" : "Live"} />
        </div>
      ) : (
        <div className="band stats cols-6">
          <Tile label="Found" title="Email found" value={num(c.found)} />
          <Tile label="Not found" title="No address" value={num(c.not_found)} />
          <Tile label="Held" title="Mail gateway" value={num(c.held)} chips={c.held ? <Chip tone="warn">held back</Chip> : undefined} />
          <Tile label="No website" title="Nothing to guess from" value={num(c.no_website)} />
          <Tile label="Checks" title="Verifications" value={num(c.verifs)} />
          <Tile
            label="Spend"
            title="Estimated cost"
            value={money(run.credits?.total_usd)}
            foot={run.test_mode ? "simulated" : <><b>{num(run.credits?.total_credits)}</b> credits</>}
          />
        </div>
      )}

      <Card title="What was checked" label={`${num(events.length)} events`}>
        <Seg
          label="Show"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({
            value: f,
            label: f !== "all" && byStatus[f] ? `${f} · ${byStatus[f]}` : f,
          }))}
        />
        <div
          ref={feed}
          className="feed"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {shown.length === 0 ? (
            <div className="empty">{live ? "Waiting for the first lead…" : "No events match that filter."}</div>
          ) : (
            <ul>
              {shown.map((e) => (
                <li key={e.seq}>
                  <Chip tone={TONE[e.status ?? ""]}>{e.stage}</Chip>
                  <span className="feed-text">
                    <b>{e.company || "—"}</b>
                    <span>{e.detail}</span>
                  </span>
                  <span className="mono faint">{(e.ts ?? "").slice(11)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {preview ? (
        <Modal label="Review the push" wide onClose={() => setPreview(null)}>
          <div className="editor-head">Review the push</div>
          <p className="muted">{preview.campaign_name ? `${preview.campaign_name} → Instantly` : "to Instantly"}</p>
          <dl className="figures">
            <div><dt>Send-ready</dt><dd>{num(preview.ready)}</dd></div>
            <div><dt>Held back</dt><dd>{num(preview.held_not_send_ready)}</dd></div>
            <div><dt>Delay between sends</dt><dd>{preview.delay ?? 0}s</dd></div>
          </dl>
          {!preview.has_key ? <ErrorBox title="No Instantly API key" detail="Add it in Settings — a live push will be refused without it." /> : null}
          {!preview.campaign_id ? <ErrorBox title="No Instantly campaign id" detail="Set it on the campaign's Instantly tab." /> : null}
          {preview.held_not_send_ready ? (
            <ErrorBox
              soft
              title={`${preview.held_not_send_ready} lead(s) held back`}
              detail="They found an address but did not pass verification. Only a real pass may be sent."
            />
          ) : null}
          {previewError ? <ErrorBox title="The push did not start" detail={previewError} /> : null}

          <div>
            <span className="lbl">Exact payload for the first {Math.min(preview.leads?.length ?? 0, 25)} lead(s)</span>
            <div className="payloads">
              {(preview.leads ?? []).slice(0, 25).map((l, i) => (
                <details key={i}>
                  <summary>
                    <b>{l.company_name}</b> <span className="faint">· {l.email}</span>
                  </summary>
                  <pre>{JSON.stringify(l, null, 2)}</pre>
                </details>
              ))}
            </div>
          </div>

          <div className="editor-actions">
            <button type="button" className="ctl" onClick={() => setPreview(null)}>Cancel</button>
            <button type="button" className="ctl" onClick={() => doPush(true)} disabled={busy}>
              Dry run (sends nothing)
            </button>
            <button
              type="button"
              className="ctl danger"
              disabled={busy || !preview.ready || !preview.has_key || !preview.campaign_id}
              onClick={() => setConfirmPush(true)}
            >
              Push {num(preview.ready)} leads
            </button>
          </div>
        </Modal>
      ) : null}

      {confirmPush && preview ? (
        <Confirm
          title="Send these leads to Instantly?"
          danger
          confirmLabel="Yes, push them"
          body={
            <>
              <p>
                This <b>leaves your machine</b>. {num(preview.ready)} lead(s) will be added to campaign{" "}
                <code>{preview.campaign_id}</code>.
              </p>
              <p className="muted">The sheet is updated row by row as each one goes.</p>
            </>
          }
          onConfirm={() => doPush(false)}
          onClose={() => setConfirmPush(false)}
        />
      ) : null}
    </div>
  );
}
