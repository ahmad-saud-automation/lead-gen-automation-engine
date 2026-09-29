"use client";

import { useEffect, useState } from "react";

import { HISTORY_COLS } from "@/components/dashboard";
import { Card, ErrorBox, Loading, Seg, StatTable } from "@/components/ui";
import { getJson } from "@/lib/client-api";
import { money, num } from "@/lib/format";
import type { HistoryRow } from "@/lib/types";

type Show = "all" | "run" | "push" | "live";

/** Every run and push the engine still keeps, newest first. Each opens its own page. */
export function HistoryList() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState("");
  const [show, setShow] = useState<Show>("all");

  useEffect(() => {
    getJson<{ runs: HistoryRow[] }>("/history")
      .then((h) => setRows(h.runs ?? []))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorBox title="History could not be loaded" detail={error} />;
  if (!rows) {
    return (
      <Card>
        <Loading rows={6} />
      </Card>
    );
  }

  const shown = rows.filter((r) =>
    show === "all" ? true : show === "live" ? !r.test_mode : (r.kind ?? "run") === show);
  const spent = shown.filter((r) => !r.test_mode).reduce((n, r) => n + (r.spent_usd || 0), 0);

  return (
    <Card title="Runs and pushes" label={`${num(shown.length)} shown · ${money(spent)} live spend`}>
      <Seg
        label="Show"
        value={show}
        onChange={setShow}
        options={[
          { value: "all", label: "All" },
          { value: "run", label: "Runs" },
          { value: "push", label: "Pushes" },
          { value: "live", label: "Live only" },
        ]}
      />
      <StatTable cols={HISTORY_COLS} rows={shown} rowKey={(r) => r.run_id} empty="Nothing here yet." />
      <p className="muted">
        Pushes are recorded from 29 September 2026 on; older runs show no campaign because the engine
        did not record it then.
      </p>
    </Card>
  );
}
