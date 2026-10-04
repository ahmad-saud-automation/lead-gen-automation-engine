"use client";

import { useState } from "react";

import {
  Card, Checks, Chip, ErrorBox, Loading, Seg, SnapshotNote, StatTable, Tile, type CheckItem, type Col,
} from "@/components/ui";
import { getJson } from "@/lib/client-api";
import { money, num } from "@/lib/format";
import type { PlanLane, PlanReport } from "@/lib/types";

type Scope = "all" | "enabled";

/** Below this many leads the decision agent refuses to call a result, so a test tells you
 *  nothing either way. Mirrors the engine's own threshold. */
const READS_AT = 300;

/* A lane's warnings come back as one list. The ones containing "will be refused" stop a run;
 * the rest are worth reading but do not. V2 split them the same way. */
const refuses = (w: string) => w.includes("will be refused");

const COLS: Col<PlanLane>[] = [
  {
    key: "campaign",
    head: "Campaign",
    align: "l",
    render: (r) => (
      <>
        <b>{r.name}</b>
        <small className="lane-id">{r.campaign}</small>
      </>
    ),
  },
  { key: "tab", head: "Tab", align: "l", render: (r) => <Chip>{r.tab}</Chip> },
  { key: "matched", head: "Matched", render: (r) => num(r.matched) },
  { key: "ledger", head: "Ledger", render: (r) => <span className="faint">{num(r.blocked_by_ledger)}</span> },
  { key: "available", head: "Available", render: (r) => <b>{num(r.available)}</b> },
  {
    key: "take",
    head: "This run",
    render: (r) => (
      <>
        {num(r.take_this_run)}
        <span className="faint"> / {r.per_run}</span>
      </>
    ),
  },
  { key: "spend", head: "Est. spend", render: (r) => money(r.estimated_spend_usd) },
  {
    key: "reads",
    head: "Reads?",
    align: "l",
    render: (r) =>
      r.available >= READS_AT ? (
        <Chip tone="up">reads</Chip>
      ) : r.available > 0 ? (
        <Chip tone="warn">too small</Chip>
      ) : (
        <Chip tone="down">empty</Chip>
      ),
  },
];

/** Everything that would stop a run, then everything merely worth reading. */
function findings(rep: PlanReport): CheckItem[] {
  const lanes = rep.campaigns ?? [];
  const out: CheckItem[] = [];
  for (const r of lanes) {
    for (const w of r.warnings ?? []) {
      if (refuses(w)) out.push({ tone: "fail", text: <><b>{r.campaign}</b> — {w}</> });
    }
  }
  for (const i of rep.config_issues ?? []) {
    out.push({ tone: "fail", text: <><b>{i.campaign}</b> — {i.issue}</> });
  }
  for (const r of lanes) {
    for (const w of r.warnings ?? []) {
      if (!refuses(w)) out.push({ tone: "warn", text: <><b>{r.campaign}</b> — {w}</> });
    }
  }
  for (const w of rep.warnings ?? []) out.push({ tone: "warn", text: w });
  return out;
}

export function PlanPreview() {
  const [scope, setScope] = useState<Scope>("all");
  const [rep, setRep] = useState<PlanReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setRep(await getJson<PlanReport>("/plan", scope === "all" ? { all: "true" } : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const lanes = rep?.campaigns ?? [];
  const snapshots = Object.entries(rep?.sources ?? {}).filter(([, s]) => !s.live && s.kind !== "import");
  const found = rep ? findings(rep) : [];

  return (
    <div className="stack">
      <Card title="What each campaign would take" label="No spend">
        <p className="muted">
          Reads your sheet and applies every rule. No finder, no verification, no push —{" "}
          <b>this costs nothing.</b> Run it before every real run.
        </p>
        <div className="toolbar">
          <Seg
            label="Which campaigns"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "Include disabled" },
              { value: "enabled", label: "Enabled only" },
            ]}
          />
          <button type="button" className="ctl solid" onClick={run} disabled={loading}>
            {loading ? "Reading the sheet…" : "Run preview"}
          </button>
        </div>
      </Card>

      {error ? <ErrorBox title="The preview did not run" detail={error} /> : null}

      {snapshots.map(([tab, s]) => (
        <SnapshotNote key={tab} tab={tab} path={s.path} />
      ))}

      {loading ? (
        <Card>
          <Loading rows={6} />
        </Card>
      ) : !rep ? (
        error ? null : (
          <Card>
            <div className="empty">
              Nothing previewed yet. Run the preview to see how many rows each campaign would take,
              and what it would cost, before anything is spent.
            </div>
          </Card>
        )
      ) : lanes.length === 0 ? (
        <Card title="No campaign matched a readable tab" label="Nothing to run">
          <p className="muted">Either nothing is enabled, or the sheet could not be read.</p>
          {/* the reason is the useful part — never make someone go and guess it */}
          {found.length ? <Checks items={found.map((f) => ({ ...f, tone: "fail" }))} /> : null}
        </Card>
      ) : (
        <>
          <div className="band cols-4 stats">
            <Tile label="Lanes" title="Lanes previewed" value={lanes.length} />
            <Tile
              label="This run"
              title="Leads this run"
              value={num(rep.total_take)}
              foot={<>daily cap <b>{num(rep.globals?.daily_push_cap)}</b></>}
            />
            <Tile
              label="Spend"
              title="Estimated spend"
              value={money(lanes.reduce((n, r) => n + (r.estimated_spend_usd || 0), 0))}
              foot="assumes ~2 verifications per lead"
            />
            <Tile
              label="Ledger"
              title="Blocked by ledger"
              value={num(lanes.reduce((n, r) => n + (r.blocked_by_ledger || 0), 0))}
              foot="already handled in an earlier run"
            />
          </div>

          <Card
            title="Lanes"
            label={`${lanes.length} campaign${lanes.length === 1 ? "" : "s"}`}
            foot={
              <>
                <b>Reads</b> means the lane has at least {READS_AT} leads. Below that the decision
                agent refuses to call a result, so the test cannot tell you anything either way.
              </>
            }
          >
            <StatTable cols={COLS} rows={lanes} rowKey={(r) => r.campaign} />
          </Card>

          <Card title="What would stop a run" label={found.some((f) => f.tone === "fail") ? "Blocked" : "Clear"}>
            <Checks items={found.length ? found : [{ tone: "ok", text: "Nothing would stop a run." }]} />
          </Card>

          {Object.keys(rep.fieldmaps ?? {}).length ? (
            <div className="grid2">
              {Object.entries(rep.fieldmaps ?? {}).map(([tab, m]) => {
                const items: CheckItem[] = [
                  ...(m.blocking ?? []).map((b): CheckItem => ({ tone: "fail", text: b })),
                  ...(m.missing_recommended?.length
                    ? [{
                        tone: "warn" as const,
                        text: <>Not mapped, so that capability is off: <b>{m.missing_recommended.join(", ")}</b></>,
                      }]
                    : []),
                ];
                return (
                  <Card key={tab} title={`Field map — ${tab}`} label={<Chip tone={m.ok ? "up" : "down"}>{m.ok ? "valid" : "problem"}</Chip>}>
                    <Checks items={items.length ? items : [{ tone: "ok", text: "Every field resolves against this sheet." }]} />
                  </Card>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
