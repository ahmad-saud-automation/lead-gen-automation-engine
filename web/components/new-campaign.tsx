"use client";

import { useState } from "react";

import { Modal } from "@/components/modal";
import { ErrorBox, Field } from "@/components/ui";
import { postJson } from "@/lib/client-api";
import { goWithNote } from "@/lib/nav";
import type { CampaignSummary, CampaignsSaved } from "@/lib/types";

/** Same rule as core/campaigns.py slug(): the id the ledger, the runs and the sheet record. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

/** Add a lane: blank, or a copy of one that already works. The engine creates it switched off
 *  and checked last, so it can never take rows from a running lane until someone turns it on. */
export function NewCampaign({
  lanes,
  copyFrom,
  onClose,
}: {
  lanes: CampaignSummary[];
  /** Open as "Duplicate": the lane to copy, preselected. */
  copyFrom?: CampaignSummary;
  onClose: () => void;
}) {
  const tabs = [...new Set(lanes.map((l) => l.tab).filter(Boolean))];
  const maps = [...new Set(lanes.map((l) => l.fieldmap).filter(Boolean))];
  const [source, setSource] = useState(copyFrom?.id ?? "");
  const src = lanes.find((l) => l.id === source);
  const [name, setName] = useState(copyFrom ? `${copyFrom.name} (copy)` : "");
  const [id, setId] = useState("");
  const [tab, setTab] = useState(copyFrom?.tab ?? tabs[0] ?? "");
  const [fieldmap, setFieldmap] = useState(copyFrom?.fieldmap ?? maps[0] ?? "");
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  const finalId = id.trim() || slug(name);

  const create = async () => {
    setSaving(true);
    setIssues([]);
    try {
      const r = await postJson<CampaignsSaved>("/campaigns/create", {
        name, id: finalId, tab, fieldmap, copy_from: source || undefined,
      });
      if (!r.ok || !r.campaign) {
        setIssues((r.issues ?? []).map((i) => i.issue));
        setSaving(false);
        return;
      }
      goWithNote(
        `/campaigns/${encodeURIComponent(r.campaign)}`,
        `${name} created. It is off and checked last — set its rules and Instantly id, then switch it on.`,
      );
    } catch (e) {
      setIssues([e instanceof Error ? e.message : String(e)]);
      setSaving(false);
    }
  };

  return (
    <Modal label={copyFrom ? "Duplicate campaign" : "New campaign"} onClose={onClose}>
      <div className="editor-head">{copyFrom ? `Duplicate "${copyFrom.name}"` : "New campaign"}</div>
      <div className="form-grid">
        <Field label="Start from" wide hint={src
          ? "Copies its rules, order, labels and limits. Never its Instantly campaign — two lanes on one campaign cannot be told apart."
          : "An empty lane: no rules yet, so it would match every row until you add some."}>
          <select value={source} onChange={(e) => {
            const next = lanes.find((l) => l.id === e.target.value);
            setSource(e.target.value);
            if (next) {
              setTab(next.tab);
              setFieldmap(next.fieldmap);
            }
          }}>
            <option value="">Blank lane</option>
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>Copy of {l.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Name" wide>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Practices 51-200 staff" />
        </Field>
        <Field label="Id" hint={<>recorded in the ledger, the runs and the sheet&apos;s Campaign Type — cannot be changed later</>}>
          <input className="mono" value={id} onChange={(e) => setId(e.target.value)} placeholder={slug(name) || "auto from the name"} />
        </Field>
        <Field label="Sheet tab" hint="which tab of the spreadsheet this lane reads">
          <input list="nc-tabs" value={tab} onChange={(e) => setTab(e.target.value)} />
          <datalist id="nc-tabs">{tabs.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field label="Field map file" hint="translates your column names" wide>
          <input className="mono" list="nc-maps" value={fieldmap} onChange={(e) => setFieldmap(e.target.value)} />
          <datalist id="nc-maps">{maps.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
      </div>
      {issues.length ? (
        <ErrorBox title="Not created" detail={<ul className="issue-list">{issues.map((i, k) => <li key={k}>{i}</li>)}</ul>} />
      ) : null}
      <div className="editor-actions">
        <button type="button" className="ctl" onClick={onClose}>Cancel</button>
        <button type="button" className="ctl solid" onClick={create} disabled={saving || !name.trim() || !tab.trim()}>
          {saving ? "Creating…" : copyFrom || source ? "Create copy" : "Create campaign"}
        </button>
      </div>
    </Modal>
  );
}
