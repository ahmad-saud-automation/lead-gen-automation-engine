"use client";

import { useEffect, useState } from "react";

import { Card, Checks, Chip, ErrorBox, Loading, SnapshotNote, Tile } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { num } from "@/lib/format";
import { goWithParams, reloadWithNote } from "@/lib/nav";
import type { CampaignsView, FieldmapDetail, FieldmapField, FieldmapSaved, ImportsView } from "@/lib/types";

type Mapping = Record<string, string>;

const DIRECTION: Record<FieldmapField["direction"], string | null> = {
  read: null,
  write: "write",
  both: "read + write",
};

/** How full a column is. A low fill only matters for a column the engine READS: a write
 *  target is supposed to be empty — Status is blank on all 21,714 rows precisely because blank
 *  means "not processed yet". */
function Fill({ field, fill }: { field: FieldmapField; fill: number | undefined }) {
  if (fill === undefined) return <span className="faint">—</span>;
  if (field.direction !== "read") {
    return <span className="faint" title="the engine writes this column, so a low fill is normal">{fill}%</span>;
  }
  return <span className={fill === 0 ? "neg" : fill < 30 ? "warn-ink" : undefined}>{fill}%</span>;
}

export function FieldmapEditor({ tab }: { tab?: string }) {
  const [d, setD] = useState<FieldmapDetail | null>(null);
  const [error, setError] = useState("");
  const [map, setMap] = useState<Mapping>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [tabs, setTabs] = useState<string[]>([]);

  useEffect(() => {
    getJson<FieldmapDetail>("/fieldmap/detail", tab ? { tab } : undefined)
      .then((r) => {
        if (r.error) throw new Error(r.error);
        setD(r);
        setMap(Object.fromEntries(r.fields.filter((f) => f.mapped).map((f) => [f.field, f.mapped])));
      })
      .catch((e: Error) => setError(e.message));
    // every tab a map can be opened for: the campaigns' tabs, then uploads nobody reads yet
    Promise.all([getJson<CampaignsView>("/campaigns"), getJson<ImportsView>("/imports")])
      .then(([c, i]) => setTabs([...new Set([...c.campaigns.map((l) => l.tab), ...i.imports.map((x) => x.tab)].filter(Boolean))]))
      .catch(() => {});
  }, [tab]);

  const picker = tabs.length > 1 ? (
    <div className="toolbar">
      <span className="muted">Tab</span>
      <select
        aria-label="Tab to map"
        value={d?.tab ?? tab ?? ""}
        onChange={(e) => goWithParams("/fieldmap", { tab: e.target.value })}
      >
        {tabs.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  ) : null;

  if (error) return <>{picker}<ErrorBox title="The field map could not be loaded" detail={error} /></>;
  if (!d) {
    return (
      <Card>
        <Loading rows={8} />
      </Card>
    );
  }

  const fill = new Map(d.headers.map((h) => [h.name, h.fill]));
  const dirty = d.fields.some((f) => (map[f.field] || "") !== (f.mapped || ""));
  const used = new Set(Object.values(map).filter(Boolean));
  const unused = d.headers.filter((h) => !used.has(h.name));
  const shown = d.fields.filter((f) => map[f.field] || f.resolved);

  const pick = (field: string, header: string) =>
    setMap((m) => {
      const next = { ...m };
      if (header) next[field] = header;
      else delete next[field];
      return next;
    });

  const acceptAll = () =>
    setMap(Object.fromEntries(
      d.fields.filter((f) => f.suggested || f.mapped).map((f) => [f.field, f.mapped || f.suggested]),
    ));

  const save = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const r = await postJson<FieldmapSaved>("/fieldmap/save", { file: d.file, mapping: map });
      if (!r.ok) throw new Error(r.error || "The engine did not save the mapping.");
      reloadWithNote(`Saved ${r.mapped} mappings to ${r.file}.`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      {picker}
      <div className="band cols-4 stats">
        <Tile label="Tab" title="Sheet tab" value={d.tab} foot={<><b>{num(d.rows)}</b> rows</>} />
        <Tile label="Columns" title="Columns in the sheet" value={d.headers.length} />
        <Tile label="Mapped" title="Engine fields mapped" value={Object.keys(map).length} unit={`of ${d.fields.length}`} />
        <Tile
          label="Status"
          title="Saved field map"
          value={d.check.ok ? "Valid" : "Problem"}
          chips={<Chip tone={d.check.ok ? "up" : "down"}>{d.check.ok ? "safe to run" : "a run would be blocked"}</Chip>}
        />
      </div>

      {d.source && !d.source.live && d.source.kind !== "import" ? <SnapshotNote tab={d.tab} path={d.source.path} /> : null}

      <Card title="Check" label={d.file}>
        <Checks
          items={
            d.check.blocking?.length
              ? d.check.blocking.map((b) => ({ tone: "fail" as const, text: b }))
              : [{ tone: "ok", text: "Every required field resolves against this sheet." }]
          }
        />
      </Card>

      <Card title="Column mapping" label={d.file}>
        <p className="muted">
          Left is what the engine calls a field. Right is the real column in your sheet. An{" "}
          <b>explicit</b> mapping always wins, and if the cell is blank the value is blank — the
          engine never quietly falls back to another column. Leave a field unmapped and it uses the
          old alias guessing instead.
        </p>
        <div className="toolbar">
          <button type="button" className="ctl" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? "Hide preview" : "Preview rows"}
          </button>
          <button type="button" className="ctl" onClick={acceptAll}>
            Accept auto-match
          </button>
          <button type="button" className="ctl solid" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : dirty ? "Save mapping" : "Saved"}
          </button>
        </div>
        {saveError ? <ErrorBox title="The mapping was not saved" detail={saveError} /> : null}

        <div className="scroll-x">
          <table className="stat">
            <thead>
              <tr>
                <th className="l">Engine field</th>
                <th className="l">Your column</th>
                <th>Filled</th>
                <th className="l">Used for</th>
              </tr>
            </thead>
            <tbody>
              {d.fields.map((f) => {
                const chosen = map[f.field] || "";
                const missing = f.required && !chosen && !f.resolved;
                const direction = DIRECTION[f.direction];
                return (
                  <tr key={f.field}>
                    <td className="l">
                      <div className="field-tags">
                        <span className="mono">{f.field}</span>
                        {f.required ? <Chip>required</Chip> : f.recommended ? <Chip>recommended</Chip> : null}
                        {direction ? <Chip>{direction}</Chip> : null}
                      </div>
                    </td>
                    <td className="l">
                      <div className="map-pick">
                        <select
                          value={chosen}
                          aria-label={`Column for ${f.field}`}
                          onChange={(e) => pick(f.field, e.target.value)}
                        >
                          <option value="">— not mapped —</option>
                          {d.headers.map((h) => (
                            <option key={h.name} value={h.name}>{h.name}</option>
                          ))}
                        </select>
                        {!chosen && f.suggested ? (
                          <button type="button" className="btn-link" onClick={() => pick(f.field, f.suggested)}>
                            use “{f.suggested}”
                          </button>
                        ) : null}
                      </div>
                      {!chosen && f.resolved ? (
                        <small className="hint">currently guessed as <b>{f.resolved}</b></small>
                      ) : null}
                      {missing ? (
                        <small className="hint neg">required — a run is blocked until this is mapped</small>
                      ) : null}
                    </td>
                    <td>
                      <Fill field={f} fill={fill.get(chosen || f.resolved)} />
                    </td>
                    <td className="l">
                      <span className="note-text">{f.note}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {showPreview ? (
        <Card title="First 5 rows, as the engine reads them" label={`${shown.length} fields`}>
          {d.preview.length === 0 ? (
            <div className="empty">No rows to preview.</div>
          ) : (
            <div className="scroll-x">
              <table className="stat compact">
                <thead>
                  <tr>
                    <th className="l">Engine field</th>
                    {d.preview.map((_, i) => (
                      <th key={i} className="l">Row {i + 1}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((f) => {
                    const col = map[f.field] || f.resolved;
                    return (
                      <tr key={f.field}>
                        <td className="l mono">{f.field}</td>
                        {d.preview.map((row, i) => (
                          <td key={i} className="l cell-clip" title={row[col] || ""}>
                            {row[col] || <span className="faint">—</span>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Card title="Columns the engine does not use" label={`${unused.length} of ${d.headers.length}`}>
        <div className="chip-wrap">
          {unused.map((h) => (
            <Chip key={h.name}>
              {h.name} <span className="faint">{h.fill}%</span>
            </Chip>
          ))}
        </div>
        <p className="muted">
          That is fine — the campaign label table can still send any of them to Instantly by name,
          without the engine needing to understand them.
        </p>
      </Card>
    </div>
  );
}
