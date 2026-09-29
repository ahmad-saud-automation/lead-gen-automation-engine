"use client";

import { useEffect, useState } from "react";

import { Card, Chip, ErrorBox, Loading, Seg } from "@/components/ui";
import { getJson } from "@/lib/client-api";
import { num } from "@/lib/format";
import type { HistoryRow, LogView } from "@/lib/types";

type Filter = "all" | "success" | "failed" | "held" | "skipped";

const TONE: Record<string, "up" | "down" | "warn" | undefined> = { success: "up", fail: "down", held: "warn", retry: "warn" };

/** Every event the engine kept, across runs and pushes: what happened to which company, when.
 *  The engine filters and searches; this shows the newest 300 of whatever matches. */
export function LogViewer() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [runId, setRunId] = useState("");
  const [runs, setRuns] = useState<HistoryRow[]>([]);
  const [data, setData] = useState<LogView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getJson<{ runs: HistoryRow[] }>("/history").then((h) => setRuns(h.runs ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    // wait for typing to pause, so a search is one request rather than one per key
    const t = setTimeout(() => {
      getJson<LogView>("/log", { filter, search, run_id: runId })
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [filter, search, runId]);

  const c = data?.counts;
  const label = (f: Filter, n?: number) => (n ? `${f} · ${num(n)}` : f);

  return (
    <Card
      title="Event log"
      label={data ? `${num(data.events.length)} shown${data.events.length >= 300 ? " · newest 300" : ""}` : undefined}
      foot={
        <a className="btn-link" href={`/api/log/download${runId ? `?run_id=${runId}` : ""}`}>
          Download {runId ? "this run's" : "the whole"} log as CSV
        </a>
      }
    >
      <div className="toolbar">
        <Seg
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "all" },
            { value: "success", label: label("success", c?.success) },
            { value: "failed", label: label("failed", c?.failed) },
            { value: "held", label: label("held", c?.held) },
            { value: "skipped", label: label("skipped", c?.skipped) },
          ]}
        />
        <input
          type="search"
          className="log-search"
          placeholder="Search company, detail or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the log"
        />
        <select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Which run">
          <option value="">All runs</option>
          {runs.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {r.when.slice(0, 16)} · {r.kind === "push" ? "push" : "run"}{r.campaign_name ? ` · ${r.campaign_name}` : ""}{r.test_mode ? " · test" : ""}
            </option>
          ))}
        </select>
      </div>

      {error ? <ErrorBox title="The log could not be loaded" detail={error} /> : null}
      {!data ? (
        <Loading rows={8} />
      ) : data.events.length === 0 ? (
        <div className="empty">No events match.</div>
      ) : (
        <div className="scroll-x">
          <table className="stat compact">
            <thead>
              <tr>
                <th className="l">When</th>
                <th className="l">Company</th>
                <th className="l">Stage</th>
                <th className="l">Result</th>
                <th className="l">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={`${e.run_id}-${e.seq}`}>
                  <td className="l">
                    <a className="btn-link" href={`/runs?run=${e.run_id}`} title={`Open run ${e.run_id}`}>
                      {(e.when ?? "").slice(5, 16) || e.ts}
                    </a>
                  </td>
                  <td className="l">{e.company || <span className="faint">—</span>}</td>
                  <td className="l">{e.stage}</td>
                  <td className="l"><Chip tone={TONE[e.status ?? ""]}>{e.status}</Chip></td>
                  <td className="l cell-clip wide" title={e.detail}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
