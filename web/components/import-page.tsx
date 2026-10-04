"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Confirm } from "@/components/modal";
import { NewCampaign } from "@/components/new-campaign";
import {
  Card, Checks, Chip, ErrorBox, Loading, StatTable, Tile, type CheckItem, type Col,
} from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { num } from "@/lib/format";
import { goWithNote, goWithParams, reloadWithNote } from "@/lib/nav";
import type { CampaignsView, ImportPreview, ImportRecord, ImportsView } from "@/lib/types";

/** Bring leads in: a CSV upload becomes a tab of its own (`import:<name>`) that a campaign can
 *  read like any sheet tab; a sheet tab can be previewed by name with the same counts. */
export function ImportPage({ tab }: { tab?: string }) {
  const [list, setList] = useState<ImportsView | null>(null);
  const [lanes, setLanes] = useState<CampaignsView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([getJson<ImportsView>("/imports"), getJson<CampaignsView>("/campaigns")])
      .then(([i, c]) => {
        setList(i);
        setLanes(c);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorBox title="Imports could not be loaded" detail={error} />;
  if (!list || !lanes) {
    return (
      <Card>
        <Loading rows={6} />
      </Card>
    );
  }

  return (
    <div className="stack">
      <UploadCard sheetTabs={list.sheet_tabs} />
      {tab ? <PreviewCard tab={tab} lanes={lanes} imports={list.imports} /> : null}
      <ImportList imports={list.imports} current={tab} />
    </div>
  );
}

function UploadCard({ sheetTabs }: { sheetTabs: string[] }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [sheetTab, setSheetTab] = useState("");

  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setProblem("");
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch("/api/imports/upload", { method: "POST", body });
      const r = (await res.json()) as { ok?: boolean; error?: string; import?: ImportRecord };
      if (!r.ok || !r.import) throw new Error(r.error || `${res.status} ${res.statusText}`);
      goWithNote(
        `/import?tab=${encodeURIComponent(r.import.tab)}`,
        `${r.import.name} imported: ${num(r.import.rows)} rows.`,
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Card title="Bring in leads" label="CSV or sheet tab">
      <div
        className={over ? "dropzone over" : "dropzone"}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          send(e.dataTransfer.files?.[0]);
        }}
      >
        <b>{busy ? "Uploading…" : "Drop a CSV here, or click to choose one"}</b>
        <span className="muted">
          It becomes a tab a campaign can read. Nothing is spent and nothing is sent by uploading.
        </span>
        <input
          ref={input}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          hidden
          onChange={(e) => send(e.target.files?.[0])}
        />
      </div>
      {problem ? <ErrorBox title="Not imported" detail={problem} /> : null}

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (sheetTab.trim()) goWithParams("/import", { tab: sheetTab.trim() });
        }}
      >
        <span className="muted">Or check a tab of the Google Sheet:</span>
        <input
          list="imp-tabs"
          value={sheetTab}
          onChange={(e) => setSheetTab(e.target.value)}
          placeholder="tab name, e.g. Practices"
          aria-label="Sheet tab name"
        />
        <datalist id="imp-tabs">{sheetTabs.map((t) => <option key={t} value={t} />)}</datalist>
        <button type="submit" className="ctl" disabled={!sheetTab.trim()}>Preview tab</button>
      </form>
    </Card>
  );
}

function PreviewCard({
  tab,
  lanes,
  imports,
}: {
  tab: string;
  lanes: CampaignsView;
  imports: ImportRecord[];
}) {
  const [p, setP] = useState<ImportPreview | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const rec = imports.find((i) => i.tab === tab);

  useEffect(() => {
    getJson<ImportPreview>("/imports/preview", { tab })
      .then((r) => {
        if (r.error) throw new Error(r.error);
        setP(r);
      })
      .catch((e: Error) => setError(e.message));
  }, [tab]);

  if (error) return <ErrorBox title={`${tab} could not be read`} detail={error} />;
  if (!p) {
    return (
      <Card title={tab}>
        <Loading rows={5} />
      </Card>
    );
  }

  const s = p.stats;
  const isImport = p.source.kind === "import";
  const usable = s.rows - s.duplicates - s.suppressed - s.in_ledger - s.no_company;

  const checks: CheckItem[] = [];
  for (const b of p.check.blocking ?? []) checks.push({ tone: "fail", text: b });
  if (!p.check.blocking?.length) checks.push({ tone: "ok", text: "The engine can read every column it needs." });
  if (isImport) {
    checks.push({
      tone: "warn",
      text: "This is a file, not the live sheet: runs and pushes never write anything back to it.",
    });
  }
  if (p.import?.status_added) {
    checks.push({ tone: "ok", text: "The file had no Status column, so an empty one was added — every row starts as not done." });
  }
  if (p.hold_without_icebreaker && s.with_icebreaker < s.rows) {
    checks.push({
      tone: "warn",
      text: (
        <>
          {s.has_icebreaker_column
            ? `${num(s.rows - s.with_icebreaker)} rows have no ice breaker yet`
            : "There is no Ice Breaker column"}
          , and leads without one are held back from the push. Write them in Icebreaker Studio, or switch
          off <b>Hold leads without an ice breaker</b> in <Link href="/settings">Settings</Link>.
        </>
      ),
    });
  }

  const show = p.headers.slice(0, 6);
  const cols: Col<Record<string, string>>[] = show.map((h) => ({
    key: h,
    head: h,
    align: "l",
    render: (r) => <span className="cell-clip">{r[h]}</span>,
  }));

  return (
    <>
      <div className="band cols-4 stats">
        <Tile label="Rows" title="In the file" value={num(s.rows)} foot={`${p.headers.length} columns`} />
        <Tile
          label="Usable"
          title="A campaign could take"
          value={num(Math.max(0, usable))}
          foot="before the campaign's own rules"
        />
        <Tile
          label="Skipped"
          title="Left out"
          value={num(s.duplicates + s.suppressed + s.in_ledger + s.no_company)}
          foot={
            <>
              <b>{num(s.duplicates)}</b> repeats · <b>{num(s.suppressed)}</b> suppressed ·{" "}
              <b>{num(s.in_ledger)}</b> done before · <b>{num(s.no_company)}</b> no company
            </>
          }
        />
        <Tile
          label="Ice breakers"
          title="Already written"
          value={num(s.with_icebreaker)}
          foot={s.has_icebreaker_column ? "from the Ice Breaker column" : "no Ice Breaker column"}
        />
      </div>

      <Card
        title={rec ? rec.name : tab}
        label={isImport ? "Uploaded file" : "Sheet tab"}
        foot={
          p.lanes.length ? (
            <>
              Read by{" "}
              {p.lanes.map((l, i) => (
                <span key={l.id}>
                  {i ? ", " : ""}
                  <Link href={`/campaigns/${encodeURIComponent(l.id)}`}>{l.name}</Link>
                </span>
              ))}
            </>
          ) : (
            "No campaign reads this yet."
          )
        }
      >
        <Checks items={checks} />
        <div className="toolbar">
          {isImport ? (
            <button type="button" className="ctl solid" onClick={() => setCreating(true)}>
              + Create a campaign for it
            </button>
          ) : null}
          <Link className="ctl" href={`/fieldmap?tab=${encodeURIComponent(tab)}`}>Check its columns</Link>
        </div>
        <p className="muted">First {p.sample.length} rows{p.headers.length > show.length ? `, first ${show.length} columns` : ""}:</p>
        <StatTable cols={cols} rows={p.sample} rowKey={(r) => JSON.stringify(r)} compact />
      </Card>

      {creating ? (
        <NewCampaign
          lanes={lanes.campaigns}
          preset={{ tab, fieldmap: rec?.fieldmap ?? "", name: (rec?.name ?? tab).replace(/\.[a-z]+$/i, "") }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}

function ImportList({ imports, current }: { imports: ImportRecord[]; current?: string }) {
  const [removing, setRemoving] = useState<ImportRecord | null>(null);
  const [problem, setProblem] = useState("");

  const remove = async (rec: ImportRecord) => {
    setProblem("");
    try {
      const r = await postJson<{ ok: boolean; error?: string }>("/imports/delete", {
        slug: rec.slug,
        delete_file: true,
      });
      if (!r.ok) throw new Error(r.error || "The engine did not remove it.");
      if (current === rec.tab) goWithNote("/import", `${rec.name} removed.`);
      else reloadWithNote(`${rec.name} removed.`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setRemoving(null);
    }
  };

  const cols: Col<ImportRecord>[] = [
    {
      key: "name",
      head: "File",
      align: "l",
      render: (r) => (
        <>
          <Link href={`/import?tab=${encodeURIComponent(r.tab)}`}>{r.name}</Link>
          <span className="lane-id">{r.tab}</span>
        </>
      ),
    },
    { key: "rows", head: "Rows", render: (r) => num(r.rows) },
    { key: "when", head: "Uploaded", align: "l", render: (r) => <span className="faint">{r.uploaded}</span> },
    {
      key: "lanes",
      head: "Read by",
      align: "l",
      render: (r) =>
        r.lanes?.length ? r.lanes.map((l) => <Chip key={l.id} tone={l.enabled ? "up" : undefined}>{l.name}</Chip>) : <span className="faint">no campaign</span>,
    },
    {
      key: "act",
      head: "",
      render: (r) => (
        <button
          type="button"
          className="ctl sm danger"
          onClick={() => setRemoving(r)}
          disabled={!!r.lanes?.length}
          title={r.lanes?.length ? "A campaign reads this file — delete or repoint the campaign first" : undefined}
        >
          Remove
        </button>
      ),
    },
  ];

  return (
    <Card title="Uploaded files" label={`${imports.length} kept`}>
      {problem ? <ErrorBox title="Not removed" detail={problem} /> : null}
      <StatTable cols={cols} rows={imports} rowKey={(r) => r.slug} empty="Nothing uploaded yet. Drop a CSV above to start." />
      {removing ? (
        <Confirm
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove file"
          danger
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
          body="The uploaded copy is deleted. Runs already made from it keep their results, and the ledger still remembers every lead it handled."
        />
      ) : null}
    </Card>
  );
}
