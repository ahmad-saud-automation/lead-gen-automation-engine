"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Confirm } from "@/components/modal";
import { NewCampaign } from "@/components/new-campaign";
import { ScheduleEditor } from "@/components/schedule-editor";
import { TopBar } from "@/components/shell";
import { Card, Chip, ErrorBox, Field, Loading, Seg } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { goWithNote } from "@/lib/nav";
import type {
  CampaignDetail, CampaignRaw, CampaignsSaved, CampaignsView, CampaignSummary, Clause, ConfigIssue,
  LabelSpec, RuleBlock, SortKey,
} from "@/lib/types";

type Tab = "setup" | "rules" | "order" | "labels" | "instantly" | "schedule";

/* A rule's value is typed by its operator. `between` needs exactly two numbers, the list
 * operators need a list, everything else is a scalar. Doing this here means the JSON on disk is
 * always the shape core/rules.py expects. */
const LIST_OPS = new Set(["in", "not_in"]);
const NUM_OPS = new Set(["gt", "gte", "lt", "lte", "older_than_days"]);

const valueToText = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

function textToValue(op: string | undefined, text: string): unknown {
  const t = (text ?? "").trim();
  if (op === "between") {
    return t.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)).slice(0, 2);
  }
  if (op && LIST_OPS.has(op)) return t ? t.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (op && NUM_OPS.has(op)) {
    const n = Number(t);
    return Number.isNaN(n) ? t : n;
  }
  return t;
}

const BLOCKS: { key: RuleBlock; label: string; hint: string }[] = [
  { key: "all", label: "Must match ALL", hint: "every rule here has to pass" },
  { key: "any", label: "Must match ANY", hint: "at least one has to pass" },
  { key: "none", label: "Must match NONE", hint: "exclusions — a match here rejects the row" },
];

const SKIPS: [keyof NonNullable<CampaignRaw["instantly"]>, string][] = [
  ["skip_if_in_workspace", "Skip if the lead is already anywhere in the workspace"],
  ["skip_if_in_campaign", "Skip if the lead is already in this campaign"],
  ["skip_if_in_list", "Skip if the lead is already in the list"],
];

/** A setting that is on or off, with what it does underneath. */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="switch-row">
      <span className="t">
        <b>{label}</b>
        {hint ? <em>{hint}</em> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** A titled list of editable rows — a rule block, the sort order, the label table. */
function RowList({
  title,
  hint,
  addLabel,
  onAdd,
  empty,
  children,
}: {
  title: string;
  hint?: string;
  addLabel: string;
  onAdd: () => void;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <div className="rowlist">
      <div className="rowlist-head">
        <span className="t">
          <b>{title}</b>
          {hint ? <em>{hint}</em> : null}
        </span>
        <button type="button" className="ctl sm" onClick={onAdd}>
          + {addLabel}
        </button>
      </div>
      {children.length ? children : <div className="rowlist-empty">{empty}</div>}
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="xbtn" aria-label={label} title={label} onClick={onClick}>
      ✕
    </button>
  );
}

const TABS: Tab[] = ["setup", "rules", "order", "labels", "instantly", "schedule"];

export function CampaignEditor({ id, initialTab }: { id: string; initialTab?: string }) {
  const [meta, setMeta] = useState<CampaignDetail | null>(null);
  const [c, setC] = useState<CampaignRaw | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : "setup");
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [lanes, setLanes] = useState<CampaignSummary[]>([]);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    getJson<CampaignDetail>("/campaigns/detail", { id })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setMeta(d);
        setC(structuredClone(d.campaign));
      })
      .catch((e: Error) => setError(e.message));
    // the other lanes: Duplicate offers their tabs and field maps
    getJson<CampaignsView>("/campaigns").then((v) => setLanes(v.campaigns ?? [])).catch(() => {});
  }, [id]);

  const back = { href: "/campaigns", label: "Campaigns" };

  if (error || !c || !meta) {
    return (
      <>
        <TopBar title="Campaign" back={back} />
        <div className="page">
          {error ? <ErrorBox title="This campaign could not be loaded" detail={error} /> : <Card><Loading rows={8} /></Card>}
        </div>
      </>
    );
  }

  const set = (patch: Partial<CampaignRaw>) => setC((x) => (x ? { ...x, ...patch } : x));
  const setIn = <K extends "limits" | "writeback" | "instantly">(key: K, patch: NonNullable<CampaignRaw[K]>) =>
    setC((x) => (x ? { ...x, [key]: { ...(x[key] ?? {}), ...patch } } : x));

  /* ── rules ── */
  const rulesOf = (b: RuleBlock): Clause[] => c.rules?.[b] ?? [];
  const setRules = (b: RuleBlock, list: Clause[]) =>
    setC((x) => {
      if (!x) return x;
      const rules = { ...(x.rules ?? {}) };
      if (list.length) rules[b] = list;
      else delete rules[b];
      return { ...x, rules };
    });
  const setClause = (b: RuleBlock, i: number, patch: Clause) =>
    setRules(b, rulesOf(b).map((cl, k) => (k === i ? { ...cl, ...patch } : cl)));

  /* ── order ── */
  const order = c.order ?? [];
  const setSort = (i: number, patch: SortKey) => set({ order: order.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

  /* ── labels ── */
  const labels = c.labels ?? [];
  const setLabel = (i: number, patch: LabelSpec) => set({ labels: labels.map((l, k) => (k === i ? { ...l, ...patch } : l)) });

  const ops = meta.operators;
  const valueLess = new Set(meta.value_less);
  const ruleCount = BLOCKS.reduce((n, b) => n + rulesOf(b.key).length, 0);

  const save = async () => {
    setSaving(true);
    setIssues([]);
    try {
      // the schedule is saved by its own tab (it may create a Windows task); sending the copy
      // loaded with this page would overwrite a schedule saved since
      const { schedule: _schedule, ...rest } = c;
      const r = await postJson<CampaignsSaved>("/campaigns/save", rest);
      if (!r.ok) {
        setIssues(r.issues ?? [{ campaign: c.id, issue: "The engine did not save it." }]);
        setSaving(false);
        return;
      }
      goWithNote("/campaigns", `${c.name || c.id} saved.`);
    } catch (e) {
      setIssues([{ campaign: c.id, issue: e instanceof Error ? e.message : String(e) }]);
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setSaving(true);
    try {
      const r = await postJson<CampaignsSaved>("/campaigns/delete", { id: c.id });
      if (!r.ok) {
        setIssues(r.issues ?? [{ campaign: c.id, issue: "The engine did not remove it." }]);
        setSaving(false);
        return;
      }
      goWithNote("/campaigns", `${c.name || c.id} removed. Its past runs and ledger rows are kept.`);
    } catch (e) {
      setIssues([{ campaign: c.id, issue: e instanceof Error ? e.message : String(e) }]);
      setSaving(false);
    }
  };

  const self = lanes.find((l) => l.id === c.id);

  return (
    <>
      <TopBar
        title={c.name || c.id}
        sub={`${c.id} · reads "${c.tab}"`}
        back={back}
        right={
          <>
            <button
              type="button"
              className="ctl"
              onClick={() => setDuplicating(true)}
              disabled={!self}
              title="Saved settings are copied — save first if you changed anything"
            >
              Duplicate
            </button>
            <button type="button" className="ctl solid" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save campaign"}
            </button>
          </>
        }
      />
      <div className="page stack">
        {issues.length ? (
          <ErrorBox
            title="Not saved — fix these first"
            detail={<ul className="issue-list">{issues.map((i, k) => <li key={k}>{i.issue}</li>)}</ul>}
          />
        ) : null}

        <Seg
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: "setup", label: "Setup" },
            { value: "rules", label: `Rules · ${ruleCount}` },
            { value: "order", label: `Order · ${order.length}` },
            { value: "labels", label: `Labels · ${labels.length}` },
            { value: "instantly", label: "Instantly" },
            { value: "schedule", label: "Schedule" },
          ]}
        />

        {tab === "schedule" ? (
          <ScheduleEditor id={c.id} enabled={Boolean(c.enabled)} autoPush={Boolean(c.auto_push)} />
        ) : null}

        {tab === "setup" ? (
          <>
            {c.note ? <ErrorBox soft title="Note on this lane" detail={c.note} /> : null}
            <Card title="Lane">
              <div className="form-grid">
                <Field label="Name">
                  <input value={c.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <Field label="Sheet tab" hint="which tab of the spreadsheet this lane reads">
                  <input value={c.tab ?? ""} onChange={(e) => set({ tab: e.target.value })} />
                </Field>
                <Field label="Priority" hint="lower number is checked first and claims the row">
                  <input type="number" value={c.priority ?? 100} onChange={(e) => set({ priority: Number(e.target.value) })} />
                </Field>
                <Field label="Field map file" hint="which config/*.json translates the column names">
                  <input className="mono" value={c.fieldmap ?? ""} onChange={(e) => set({ fieldmap: e.target.value })} />
                </Field>
              </div>
            </Card>
            <Card title="Limits">
              <div className="form-grid">
                <Field label="Leads per run">
                  <input
                    type="number"
                    value={c.limits?.per_run ?? 50}
                    onChange={(e) => setIn("limits", { per_run: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Leads per day" hint="0 = no limit">
                  <input
                    type="number"
                    value={c.limits?.per_day ?? 0}
                    onChange={(e) => setIn("limits", { per_day: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Max spend per run ($)">
                  <input
                    type="number"
                    step="0.5"
                    value={c.limits?.max_spend_usd ?? 0}
                    onChange={(e) => setIn("limits", { max_spend_usd: Number(e.target.value) })}
                  />
                </Field>
              </div>
            </Card>
            <Card title="Behaviour">
              <div className="switches one">
                <SwitchRow
                  label="Enabled"
                  hint="a disabled lane is never read and never claims a row"
                  checked={Boolean(c.enabled)}
                  onChange={(v) => set({ enabled: v })}
                />
                <SwitchRow
                  label="Write back to the sheet"
                  hint="writes Status, send_ready, the email and the ice breaker onto the row"
                  checked={c.writeback?.enabled !== false}
                  onChange={(v) => setIn("writeback", { enabled: v })}
                />
                <SwitchRow
                  label="Auto push"
                  hint="sends without asking. Leave off until you trust the lane"
                  checked={Boolean(c.auto_push)}
                  onChange={(v) => set({ auto_push: v })}
                />
              </div>
              <div className="form-grid">
                <Field
                  label="Campaign Type written to the sheet"
                  hint="lands in the Campaign Type column so you can see which lane sent a row"
                  wide
                >
                  <input
                    value={c.writeback?.campaign_type ?? ""}
                    onChange={(e) => setIn("writeback", { campaign_type: e.target.value })}
                  />
                </Field>
              </div>
            </Card>
            <Card title="Remove this campaign">
              <p className="muted">
                Removes the lane from <code>config/campaigns.json</code> (the previous file is kept
                as <code>campaigns.backup.json</code>). Its past runs, events and ledger rows keep
                their id. To pause a lane instead, switch it off above.
              </p>
              <div className="toolbar">
                <button type="button" className="ctl danger" onClick={() => setConfirmDelete(true)} disabled={saving}>
                  Remove campaign
                </button>
              </div>
            </Card>
          </>
        ) : null}

        {tab === "rules" ? (
          <Card title="Rules" label={`${ruleCount} rule${ruleCount === 1 ? "" : "s"}`}>
            <p className="muted">
              A field can be an engine name (<code>employees</code>, <code>send_gate</code>) or a
              column exactly as it appears in your sheet (<code>a8om_contacted</code>).
            </p>
            {BLOCKS.map((b) => (
              <RowList
                key={b.key}
                title={b.label}
                hint={b.hint}
                addLabel="Add rule"
                onAdd={() => setRules(b.key, [...rulesOf(b.key), { field: "", op: "equals", value: "" }])}
                empty="No rules — this block is skipped."
              >
                {rulesOf(b.key).map((cl, i) => {
                  const noValue = valueLess.has(cl.op ?? "");
                  return (
                    <div key={i} className="rule-line">
                      <input
                        placeholder="field"
                        aria-label="Field"
                        value={cl.field ?? ""}
                        onChange={(e) => setClause(b.key, i, { field: e.target.value })}
                      />
                      <select
                        aria-label="Operator"
                        value={cl.op ?? "equals"}
                        onChange={(e) => {
                          const op = e.target.value;
                          setClause(b.key, i, valueLess.has(op)
                            ? { op, value: undefined }
                            : { op, value: textToValue(op, valueToText(cl.value)) });
                        }}
                      >
                        {ops.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <input
                        aria-label="Value"
                        disabled={noValue}
                        placeholder={noValue ? "no value needed" : cl.op === "between" ? "2, 10" : LIST_OPS.has(cl.op ?? "") ? "a, b, c" : "value"}
                        value={valueToText(cl.value)}
                        onChange={(e) => setClause(b.key, i, { value: textToValue(cl.op, e.target.value) })}
                      />
                      <RemoveButton label="Remove rule" onClick={() => setRules(b.key, rulesOf(b.key).filter((_, k) => k !== i))} />
                    </div>
                  );
                })}
              </RowList>
            ))}
          </Card>
        ) : null}

        {tab === "order" ? (
          <Card title="Sort order" label="Best leads first">
            <p className="muted">
              The <b>first</b> row is the strongest sort. A blank cell always sorts last, and a value
              missing from an explicit list sorts last too.
            </p>
            <RowList
              title="Sort keys"
              addLabel="Add"
              onAdd={() => set({ order: [...order, { field: "", dir: "desc" }] })}
              empty="No sort — rows keep sheet order."
            >
              {order.map((s, i) => (
                <div key={i} className="sort-line">
                  <Chip>{i + 1}</Chip>
                  <input
                    placeholder="field"
                    aria-label="Field"
                    value={s.field ?? ""}
                    onChange={(e) => setSort(i, { field: e.target.value })}
                  />
                  <input
                    placeholder="best-first list, e.g. strong, medium, weak (blank = sort by value)"
                    aria-label="Best-first list"
                    value={(s.order ?? []).join(", ")}
                    onChange={(e) => {
                      const list = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
                      if (list.length) {
                        setSort(i, { order: list });
                      } else {
                        const { order: _drop, ...rest } = s;
                        set({ order: order.map((x, k) => (k === i ? rest : x)) });
                      }
                    }}
                  />
                  <select aria-label="Direction" value={s.dir ?? "asc"} onChange={(e) => setSort(i, { dir: e.target.value as "asc" | "desc" })}>
                    <option value="asc">asc</option>
                    <option value="desc">desc</option>
                  </select>
                  <RemoveButton label="Remove sort key" onClick={() => set({ order: order.filter((_, k) => k !== i) })} />
                </div>
              ))}
            </RowList>
          </Card>
        ) : null}

        {tab === "labels" ? (
          <Card title="Labels" label="custom_variables">
            <p className="muted">
              These ride to Instantly in <code>custom_variables</code> and come back out in the
              results, which is what lets the decision agent group by them. Any variable name is
              allowed; values must be text, a number, true/false or null.
            </p>
            {meta.label_issues.length ? (
              <ErrorBox
                title="Label problems in the saved file"
                detail={<ul className="issue-list">{meta.label_issues.map((i, k) => <li key={k}>{i}</li>)}</ul>}
              />
            ) : null}
            <RowList
              title="Label table"
              addLabel="Add label"
              onAdd={() => set({ labels: [...labels, { send_as: "", type: "column", source: "", fallback: "" }] })}
              empty="No labels — only the standard lead fields are sent."
            >
              {labels.map((l, i) => (
                <div key={i} className="label-line">
                  <input
                    placeholder="send as"
                    aria-label="Send as"
                    value={l.send_as ?? ""}
                    onChange={(e) => setLabel(i, { send_as: e.target.value })}
                  />
                  <select aria-label="Type" value={l.type ?? "column"} onChange={(e) => setLabel(i, { type: e.target.value })}>
                    {(meta.label_types.length ? meta.label_types : ["column"]).map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {l.type === "fixed" ? (
                    <input
                      placeholder="fixed value"
                      aria-label="Fixed value"
                      value={valueToText(l.value)}
                      onChange={(e) => setLabel(i, { value: e.target.value })}
                    />
                  ) : l.type === "derived" ? (
                    <select aria-label="Derived from" value={valueToText(l.source)} onChange={(e) => setLabel(i, { source: e.target.value })}>
                      <option value="">choose…</option>
                      {meta.derived.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  ) : (
                    <input
                      placeholder="column"
                      aria-label="Column"
                      value={valueToText(l.source)}
                      onChange={(e) => {
                        const t = e.target.value;
                        setLabel(i, { source: t.includes(",") ? t.split(",").map((s) => s.trim()).filter(Boolean) : t });
                      }}
                    />
                  )}
                  <input
                    placeholder="fallback when empty"
                    aria-label="Fallback"
                    disabled={l.type === "fixed" || l.omit_if_blank}
                    value={l.fallback ?? ""}
                    onChange={(e) => setLabel(i, { fallback: e.target.value })}
                  />
                  <RemoveButton label="Remove label" onClick={() => set({ labels: labels.filter((_, k) => k !== i) })} />
                  <label className="label-omit">
                    <input
                      type="checkbox"
                      role="switch"
                      className="switch"
                      checked={Boolean(l.omit_if_blank)}
                      onChange={(e) => setLabel(i, { omit_if_blank: e.target.checked })}
                    />
                    <span>omit the whole variable when empty, instead of sending the fallback</span>
                  </label>
                </div>
              ))}
            </RowList>
          </Card>
        ) : null}

        {tab === "instantly" ? (
          <Card title="Instantly">
            <div className="form-grid">
              <Field
                label="Instantly campaign id"
                hint="⛔ a live push is refused without this. Copy it from the campaign's URL in Instantly."
                wide
              >
                <input
                  className="mono"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={c.instantly?.campaign_id ?? ""}
                  onChange={(e) => setIn("instantly", { campaign_id: e.target.value.trim() })}
                />
              </Field>
              <Field label="Blocklist id" hint="checked by Instantly before the lead is accepted — the API-level suppression gate">
                <input
                  className="mono"
                  value={c.instantly?.blocklist_id ?? ""}
                  onChange={(e) => setIn("instantly", { blocklist_id: e.target.value.trim() })}
                />
              </Field>
              <Field label="List id" hint="optional, only if you also file leads into an Instantly list">
                <input
                  className="mono"
                  value={c.instantly?.list_id ?? ""}
                  onChange={(e) => setIn("instantly", { list_id: e.target.value.trim() })}
                />
              </Field>
            </div>
            <div className="switches one">
              {SKIPS.map(([k, label]) => (
                <SwitchRow
                  key={k}
                  label={label}
                  checked={Boolean(c.instantly?.[k])}
                  onChange={(v) => setIn("instantly", { [k]: v })}
                />
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      {duplicating && self ? <NewCampaign lanes={lanes} copyFrom={self} onClose={() => setDuplicating(false)} /> : null}

      {confirmDelete ? (
        <Confirm
          title={`Remove "${c.name || c.id}"?`}
          danger
          confirmLabel="Remove it"
          body={
            <>
              <p>
                The lane stops existing: it will not appear in Campaigns, Plan or Runs, and its rules,
                labels and Instantly settings go with it.
              </p>
              <p className="muted">
                Nothing already sent is affected, and the ledger still remembers every lead it handled.
              </p>
            </>
          }
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}
