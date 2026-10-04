"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Confirm } from "@/components/modal";
import { NewCampaign } from "@/components/new-campaign";
import { Card, Chip, ErrorBox, Loading, Tile } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { money, num } from "@/lib/format";
import { flashNote, goWithNote } from "@/lib/nav";
import type {
  CampaignSummary, CampaignsSaved, CampaignsView, HistoryRow, PlanLane, PlanReport, RunStarted,
} from "@/lib/types";

/** MillionVerifier's rate, and the ~2 checks a lead takes: only to put a rough figure on the
 *  live-run button. The engine's own cost counters are what count. */
const LIVE_COST_PER_LEAD = 2 * 0.00178;

/** When the lane runs by itself next, linked to its Schedule tab. */
export function NextRun({ s, id }: { s?: CampaignSummary["schedule"]; id: string }) {
  const href = `/campaigns/${encodeURIComponent(id)}`;
  if (s?.problems?.length) return <Chip tone="warn">schedule problem</Chip>;
  if (!s?.active) return <span className="faint">manual</span>;
  return (
    <Link className="btn-link" href={href} title={s.summary}>
      {s.next_run || "—"}
      <small className="lane-id">{s.via === "windows" ? "Windows" : "app"} · {s.summary}</small>
    </Link>
  );
}

export function CampaignList() {
  const [data, setData] = useState<CampaignsView | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [counts, setCounts] = useState<Record<string, PlanLane> | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [busy, setBusy] = useState("");
  const [confirmRun, setConfirmRun] = useState<CampaignSummary | null>(null);
  const [adding, setAdding] = useState<{ copyFrom?: CampaignSummary } | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, HistoryRow>>({});

  const load = () =>
    getJson<CampaignsView>("/campaigns")
      .then(setData)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
    // Newest first, so the first row seen for a lane is its last run. Pushes are not runs.
    getJson<{ runs: HistoryRow[] }>("/history")
      .then((h) => {
        const by: Record<string, HistoryRow> = {};
        for (const r of h.runs ?? []) if (r.campaign && r.kind !== "push" && !by[r.campaign]) by[r.campaign] = r;
        setLastRun(by);
      })
      .catch(() => {});
  }, []);

  // Counts mean reading the whole sheet, so they are asked for, never automatic — the campaign
  // list must open instantly even with no sheet configured.
  const loadCounts = async () => {
    setLoadingCounts(true);
    setActionError("");
    try {
      const p = await getJson<PlanReport>("/plan", { all: "true" });
      setCounts(Object.fromEntries((p.campaigns ?? []).map((r) => [r.campaign, r])));
      if (!p.campaigns?.length) {
        setActionError(["No lane matched a readable tab.", ...(p.warnings ?? [])].join(" "));
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
    setLoadingCounts(false);
  };

  const toggle = async (c: CampaignSummary, enabled: boolean) => {
    setBusy(c.id);
    setActionError("");
    try {
      const r = await postJson<CampaignsSaved>("/campaigns/save", { id: c.id, enabled });
      if (!r.ok) throw new Error(r.issues?.map((i) => i.issue).join("; ") || "The engine did not save it.");
      await load();
      flashNote(`${c.name} ${enabled ? "enabled" : "disabled"}.`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
    setBusy("");
  };

  const run = async (c: CampaignSummary, testMode: boolean) => {
    setConfirmRun(null);
    setBusy(c.id);
    setActionError("");
    try {
      const r = await postJson<RunStarted>("/campaign/run", { campaign: c.id, test_mode: testMode });
      if (r.error || !r.run_id) throw new Error(r.error || "The engine did not start a run.");
      goWithNote(`/runs?run=${r.run_id}`, `${c.name}: run started${testMode ? " (test mode, no spend)" : ""}.`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  };

  if (error) return <ErrorBox title="Campaigns could not be loaded" detail={error} />;
  if (!data) {
    return (
      <Card>
        <Loading rows={6} />
      </Card>
    );
  }

  const list = data.campaigns ?? [];
  const enabled = list.filter((c) => c.enabled);
  const ready = enabled.filter((c) => c.instantly_campaign_id);
  const liveCost = money((confirmRun?.per_run || 0) * LIVE_COST_PER_LEAD);

  return (
    <div className="stack">
      <div className="band cols-4 stats">
        <Tile label="Campaigns" title="Lanes configured" value={list.length} foot={<><b>{enabled.length}</b> enabled</>} />
        <Tile
          label="Ready"
          title="Ready to send"
          value={ready.length}
          chips={enabled.length && !ready.length ? <Chip tone="warn">none has an Instantly id</Chip> : undefined}
          foot="enabled and pointed at an Instantly campaign"
        />
        <Tile label="Send cap" title="Daily send cap" value={num(data.globals?.daily_push_cap)} foot="across all campaigns" />
        <Tile label="Spend cap" title="Daily spend cap" value={money(data.globals?.daily_spend_cap_usd)} foot="across all campaigns" />
      </div>

      {data.issues?.length ? (
        <ErrorBox
          title="Config problems in campaigns.json"
          detail={
            <ul className="issue-list">
              {data.issues.map((i, k) => <li key={k}><b>{i.campaign}</b> — {i.issue}</li>)}
            </ul>
          }
        />
      ) : null}

      {actionError ? <ErrorBox title="That did not work" detail={actionError} /> : null}

      <Card
        title="Campaigns"
        label="Priority order"
        foot={
          <>
            <b>Available</b> = rows matching the rules that the ledger has not already handled.{" "}
            <b>Run</b> starts enrichment only — sending is always a separate, confirmed step.
          </>
        }
      >
        <p className="muted">
          Checked in priority order — the first lane whose rules match claims the row, so one firm
          is never in two campaigns.
        </p>
        <div className="toolbar">
          <button type="button" className="ctl solid" onClick={() => setAdding({})}>
            + New campaign
          </button>
          <button type="button" className="ctl" onClick={loadCounts} disabled={loadingCounts}>
            {loadingCounts ? "Reading the sheet…" : counts ? "Reload counts" : "Load counts"}
          </button>
        </div>

        {list.length === 0 ? (
          <div className="empty">No campaigns yet. Use New campaign to add the first lane.</div>
        ) : (
          <div className="scroll-x">
            <table className="stat">
              <thead>
                <tr>
                  <th className="l">On</th>
                  <th className="l">Campaign</th>
                  <th className="l">Tab</th>
                  <th>Priority</th>
                  <th>Available</th>
                  <th>Per run</th>
                  <th>Per day</th>
                  <th className="l">Target</th>
                  <th className="l">Last run</th>
                  <th className="l">Next run</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const cnt = counts?.[c.id];
                  return (
                    <tr key={c.id}>
                      <td className="l">
                        <input
                          type="checkbox"
                          role="switch"
                          className="switch"
                          aria-label={`Enable ${c.name}`}
                          checked={c.enabled}
                          disabled={busy === c.id}
                          onChange={(e) => toggle(c, e.target.checked)}
                        />
                      </td>
                      <td className="l">
                        <b>{c.name}</b>
                        <span className="lane-id">
                          {c.id}
                          {c.label_issues?.length ? (
                            <>
                              {" "}
                              <Chip tone="down">
                                {c.label_issues.length} label problem{c.label_issues.length === 1 ? "" : "s"}
                              </Chip>
                            </>
                          ) : null}
                        </span>
                      </td>
                      <td className="l"><Chip>{c.tab}</Chip></td>
                      <td>{c.priority}</td>
                      <td>
                        {cnt ? (
                          <>
                            <b>{num(cnt.available)}</b>
                            {cnt.blocked_by_ledger > 0 ? (
                              <small className="lane-id">{num(cnt.blocked_by_ledger)} done</small>
                            ) : null}
                          </>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>{c.per_run}</td>
                      <td>{c.per_day || "∞"}</td>
                      <td className="l">
                        {c.instantly_campaign_id ? (
                          <span className="mono faint" title={c.instantly_campaign_id}>
                            {c.instantly_campaign_id.slice(0, 8)}…
                          </span>
                        ) : (
                          <Chip tone="warn">no Instantly id</Chip>
                        )}
                      </td>
                      <td className="l">
                        {lastRun[c.id] ? (
                          <a className="btn-link" href={`/runs?run=${lastRun[c.id].run_id}`}>
                            {lastRun[c.id].when.slice(0, 16)}
                            <small className="lane-id">
                              {num(lastRun[c.id].found)} of {num(lastRun[c.id].leads)} found
                              {lastRun[c.id].test_mode ? " · test" : ""}
                            </small>
                          </a>
                        ) : (
                          <span className="faint">never</span>
                        )}
                      </td>
                      <td className="l">
                        <NextRun s={c.schedule} id={c.id} />
                      </td>
                      <td>
                        <span className="row-btns">
                          <Link className="ctl sm" href={`/campaigns/${encodeURIComponent(c.id)}`}>
                            Configure
                          </Link>
                          <button type="button" className="ctl sm" onClick={() => setAdding({ copyFrom: c })}>
                            Duplicate
                          </button>
                          <button
                            type="button"
                            className="ctl sm solid"
                            disabled={!c.enabled || busy === c.id}
                            title={c.enabled ? undefined : "Enable the campaign to run it"}
                            onClick={() => setConfirmRun(c)}
                          >
                            Run
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ErrorBox
        soft
        title="Enable one pair of lanes at a time"
        detail="Lanes are claimed in priority order, so turning all four on means the size lanes take the rows first and the seniority test reads a fraction of its real population."
      />

      {adding ? <NewCampaign lanes={list} copyFrom={adding.copyFrom} onClose={() => setAdding(null)} /> : null}

      {confirmRun ? (
        <Confirm
          title={`Run "${confirmRun.name}"?`}
          confirmLabel="Run in test mode"
          secondary={{ label: `Run live (~${liveCost})`, onClick: () => run(confirmRun, false) }}
          body={
            <>
              <p>
                <b>Test mode</b> makes no API calls at all and costs nothing. It proves the rules, the
                field map and the payload — but the email addresses it produces are invented and
                must never be mailed.
              </p>
              <p>
                <b>Live</b> calls MillionVerifier for real. Up to <b>{confirmRun.per_run}</b> leads,
                roughly {liveCost} at ~2 checks each.
              </p>
              <p className="muted">
                Either way nothing is sent — the push to Instantly is a separate, confirmed step
                afterwards.
              </p>
            </>
          }
          onConfirm={() => run(confirmRun, true)}
          onClose={() => setConfirmRun(null)}
        />
      ) : null}
    </div>
  );
}
