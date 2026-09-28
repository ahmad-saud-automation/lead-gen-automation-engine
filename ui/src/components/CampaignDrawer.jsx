import { useEffect, useState } from 'react'
import { Plus, Trash2, AlertTriangle, Info } from 'lucide-react'
import { api } from '../api.js'
import {
  Drawer, Button, Input, Select, Switch, Field, Tabs, Badge, Note, Spinner, useToast, cx,
} from './ui.jsx'

/* A rule's value is typed by its operator. `between` needs exactly two numbers, the list
   operators need a list, everything else is a scalar. Doing this here means the JSON on
   disk is always the shape core/rules.py expects. */
const LIST_OPS = new Set(['in', 'not_in'])
const NUM_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'older_than_days'])

const valueToText = (v) => Array.isArray(v) ? v.join(', ') : (v ?? '') + ''
const textToValue = (op, text) => {
  const t = (text ?? '').trim()
  if (op === 'between') {
    const parts = t.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n))
    return parts.slice(0, 2)
  }
  if (LIST_OPS.has(op)) return t ? t.split(',').map(s => s.trim()).filter(Boolean) : []
  if (NUM_OPS.has(op)) { const n = Number(t); return Number.isNaN(n) ? t : n }
  return t
}

const BLOCKS = [
  { key: 'all', label: 'Must match ALL', hint: 'every rule here has to pass' },
  { key: 'any', label: 'Must match ANY', hint: 'at least one has to pass' },
  { key: 'none', label: 'Must match NONE', hint: 'exclusions — a match here rejects the row' },
]

export default function CampaignDrawer({ id, onClose, onSaved }) {
  const toast = useToast()
  const [meta, setMeta] = useState(null)
  const [c, setC] = useState(null)
  const [tab, setTab] = useState('setup')
  const [saving, setSaving] = useState(false)
  const [issues, setIssues] = useState([])

  useEffect(() => {
    if (!id) { setC(null); return }
    setTab('setup'); setIssues([]); setC(null)
    api.campaignDetail(id)
      .then(d => { if (d.error) throw new Error(d.error); setMeta(d); setC(structuredClone(d.campaign)) })
      .catch(e => { toast(e.message, 'danger'); onClose() })
  }, [id])

  const set = (patch) => setC(x => ({ ...x, ...patch }))
  const setIn = (key, patch) => setC(x => ({ ...x, [key]: { ...(x[key] || {}), ...patch } }))

  const save = async () => {
    setSaving(true); setIssues([])
    try {
      const r = await api.saveCampaign(c)
      if (!r.ok) { setIssues(r.issues || []); toast('Not saved — fix the problems listed', 'danger') }
      else { onSaved?.(); onClose() }
    } catch (e) { toast(e.message, 'danger') }
    setSaving(false)
  }

  const ops = meta?.operators || []
  const valueLess = new Set(meta?.value_less || [])

  /* ── rules ── */
  const setClause = (block, i, patch) => setC(x => {
    const rules = structuredClone(x.rules || {})
    rules[block] = rules[block] || []
    rules[block][i] = { ...rules[block][i], ...patch }
    return { ...x, rules }
  })
  const addClause = (block) => setC(x => {
    const rules = structuredClone(x.rules || {})
    rules[block] = [...(rules[block] || []), { field: '', op: 'equals', value: '' }]
    return { ...x, rules }
  })
  const delClause = (block, i) => setC(x => {
    const rules = structuredClone(x.rules || {})
    rules[block] = (rules[block] || []).filter((_, k) => k !== i)
    if (!rules[block].length) delete rules[block]
    return { ...x, rules }
  })

  /* ── labels ── */
  const setLabel = (i, patch) => setC(x => {
    const labels = structuredClone(x.labels || [])
    labels[i] = { ...labels[i], ...patch }
    return { ...x, labels }
  })
  const addLabel = () => setC(x => ({ ...x, labels: [...(x.labels || []),
    { send_as: '', type: 'column', source: '', fallback: '' }] }))
  const delLabel = (i) => setC(x => ({ ...x, labels: (x.labels || []).filter((_, k) => k !== i) }))

  return (
    <Drawer open={!!id} onClose={onClose} width="max-w-3xl"
      title={c?.name || 'Campaign'}
      subtitle={c ? `${c.id} · reads the "${c.tab}" tab` : ''}
      footer={c && <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={saving}>Save campaign</Button>
      </>}>
      {!c ? <div className="flex justify-center py-20"><Spinner size={22} /></div> : (
        <>
          <Tabs value={tab} onChange={setTab} className="sticky top-0 z-10 bg-surface"
            tabs={[
              { id: 'setup', label: 'Setup' },
              { id: 'rules', label: 'Rules', count: BLOCKS.reduce((n, b) => n + (c.rules?.[b.key]?.length || 0), 0) },
              { id: 'order', label: 'Order', count: c.order?.length || 0 },
              { id: 'labels', label: 'Labels', count: c.labels?.length || 0 },
              { id: 'instantly', label: 'Instantly' },
            ]} />

          {!!issues.length && (
            <div className="px-5 pt-4">
              <Note tone="danger" icon={AlertTriangle}>
                <ul className="list-disc pl-4 space-y-0.5">
                  {issues.map((i, k) => <li key={k}>{i.issue}</li>)}
                </ul>
              </Note>
            </div>
          )}

          <div className="space-y-5 p-5">
            {tab === 'setup' && (
              <>
                {c.note && <Note tone="primary" icon={Info}>{c.note}</Note>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name"><Input value={c.name || ''} onChange={e => set({ name: e.target.value })} /></Field>
                  <Field label="Sheet tab" hint="which tab of the spreadsheet this lane reads">
                    <Input value={c.tab || ''} onChange={e => set({ tab: e.target.value })} />
                  </Field>
                  <Field label="Priority" hint="lower number is checked first and claims the row">
                    <Input type="number" value={c.priority ?? 100}
                      onChange={e => set({ priority: Number(e.target.value) })} />
                  </Field>
                  <Field label="Field map file" hint="which config/*.json translates the column names">
                    <Input value={c.fieldmap || ''} onChange={e => set({ fieldmap: e.target.value })} />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Leads per run"><Input type="number" value={c.limits?.per_run ?? 50}
                    onChange={e => setIn('limits', { per_run: Number(e.target.value) })} /></Field>
                  <Field label="Leads per day" hint="0 = no limit"><Input type="number" value={c.limits?.per_day ?? 0}
                    onChange={e => setIn('limits', { per_day: Number(e.target.value) })} /></Field>
                  <Field label="Max spend per run ($)"><Input type="number" step="0.5" value={c.limits?.max_spend_usd ?? 0}
                    onChange={e => setIn('limits', { max_spend_usd: Number(e.target.value) })} /></Field>
                </div>

                <div className="space-y-3 rounded-lg border p-4">
                  <Row label="Enabled" hint="a disabled lane is never read and never claims a row">
                    <Switch checked={!!c.enabled} onChange={v => set({ enabled: v })} label="Enabled" />
                  </Row>
                  <Row label="Write back to the sheet"
                    hint="writes Status, send_ready, the email and the ice breaker onto the row">
                    <Switch checked={c.writeback?.enabled !== false}
                      onChange={v => setIn('writeback', { enabled: v })} label="Write back" />
                  </Row>
                  <Row label="Auto push" hint="⚠️ sends without asking. Leave off until you trust the lane">
                    <Switch checked={!!c.auto_push} onChange={v => set({ auto_push: v })} label="Auto push" />
                  </Row>
                </div>

                <Field label="Campaign Type written to the sheet"
                  hint="lands in the Campaign Type column so you can see which lane sent a row">
                  <Input value={c.writeback?.campaign_type || ''}
                    onChange={e => setIn('writeback', { campaign_type: e.target.value })} />
                </Field>
              </>
            )}

            {tab === 'rules' && (
              <>
                <Note tone="primary" icon={Info}>
                  A field can be an engine name (<code>employees</code>, <code>send_gate</code>)
                  or a column exactly as it appears in your sheet (<code>a8om_contacted</code>).
                </Note>
                {BLOCKS.map(b => (
                  <div key={b.key} className="rounded-lg border">
                    <div className="flex items-center justify-between border-b bg-surface-2 px-3 py-2">
                      <div>
                        <div className="text-xs font-semibold">{b.label}</div>
                        <div className="text-[11px] text-faint">{b.hint}</div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => addClause(b.key)}>
                        <Plus size={13} /> Add rule
                      </Button>
                    </div>
                    <div className="divide-y">
                      {(c.rules?.[b.key] || []).length === 0 && (
                        <div className="px-3 py-3 text-xs text-faint">No rules — this block is skipped.</div>
                      )}
                      {(c.rules?.[b.key] || []).map((cl, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-2">
                          <Input className="flex-1" placeholder="field" value={cl.field || ''}
                            onChange={e => setClause(b.key, i, { field: e.target.value })} />
                          <Select className="w-40" value={cl.op || 'equals'}
                            onChange={e => {
                              const op = e.target.value
                              setClause(b.key, i, valueLess.has(op)
                                ? { op, value: undefined }
                                : { op, value: textToValue(op, valueToText(cl.value)) })
                            }}>
                            {ops.map(o => <option key={o} value={o}>{o}</option>)}
                          </Select>
                          <Input className="flex-1" disabled={valueLess.has(cl.op)}
                            placeholder={valueLess.has(cl.op) ? 'no value needed'
                              : cl.op === 'between' ? '2, 10' : LIST_OPS.has(cl.op) ? 'a, b, c' : 'value'}
                            value={valueToText(cl.value)}
                            onChange={e => setClause(b.key, i, { value: textToValue(cl.op, e.target.value) })} />
                          <Button size="icon" variant="ghost" onClick={() => delClause(b.key, i)}
                            aria-label="Remove rule"><Trash2 size={14} /></Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === 'order' && (
              <>
                <Note tone="primary" icon={Info}>
                  Best leads first. The <b>first</b> row is the strongest sort. A blank cell always
                  sorts last, and a value missing from an explicit list sorts last too.
                </Note>
                <div className="rounded-lg border">
                  <div className="flex items-center justify-between border-b bg-surface-2 px-3 py-2">
                    <div className="text-xs font-semibold">Sort order</div>
                    <Button size="sm" variant="ghost"
                      onClick={() => set({ order: [...(c.order || []), { field: '', dir: 'desc' }] })}>
                      <Plus size={13} /> Add
                    </Button>
                  </div>
                  <div className="divide-y">
                    {(c.order || []).length === 0 &&
                      <div className="px-3 py-3 text-xs text-faint">No sort — rows keep sheet order.</div>}
                    {(c.order || []).map((s, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2">
                        <Badge className="w-6 justify-center">{i + 1}</Badge>
                        <Input className="flex-1" placeholder="field" value={s.field || ''}
                          onChange={e => set({ order: c.order.map((x, k) => k === i ? { ...x, field: e.target.value } : x) })} />
                        <Input className="flex-[2]" placeholder="best-first list, e.g. strong, medium, weak (blank = sort by value)"
                          value={(s.order || []).join(', ')}
                          onChange={e => {
                            const list = e.target.value.split(',').map(t => t.trim()).filter(Boolean)
                            set({ order: c.order.map((x, k) => k === i
                              ? (list.length ? { ...x, order: list } : (({ order, ...rest }) => rest)(x)) : x) })
                          }} />
                        <Select className="w-24" value={s.dir || 'asc'}
                          onChange={e => set({ order: c.order.map((x, k) => k === i ? { ...x, dir: e.target.value } : x) })}>
                          <option value="asc">asc</option><option value="desc">desc</option>
                        </Select>
                        <Button size="icon" variant="ghost" aria-label="Remove"
                          onClick={() => set({ order: c.order.filter((_, k) => k !== i) })}><Trash2 size={14} /></Button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'labels' && (
              <>
                <Note tone="primary" icon={Info}>
                  These ride to Instantly in <code>custom_variables</code> and come back out in the
                  results, which is what lets the decision agent group by them. Any variable name is
                  allowed; values must be text, a number, true/false or null.
                </Note>
                {!!meta?.label_issues?.length && (
                  <Note tone="danger" icon={AlertTriangle}>
                    <ul className="list-disc pl-4">{meta.label_issues.map((i, k) => <li key={k}>{i}</li>)}</ul>
                  </Note>
                )}
                <div className="rounded-lg border">
                  <div className="flex items-center justify-between border-b bg-surface-2 px-3 py-2">
                    <div className="text-xs font-semibold">Label table</div>
                    <Button size="sm" variant="ghost" onClick={addLabel}><Plus size={13} /> Add label</Button>
                  </div>
                  <div className="divide-y">
                    {(c.labels || []).map((l, i) => (
                      <div key={i} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                        <Input className="col-span-3" placeholder="send as" value={l.send_as || ''}
                          onChange={e => setLabel(i, { send_as: e.target.value })} />
                        <Select className="col-span-2" value={l.type || 'column'}
                          onChange={e => setLabel(i, { type: e.target.value })}>
                          {(meta?.label_types || ['column']).map(t => <option key={t} value={t}>{t}</option>)}
                        </Select>
                        {l.type === 'fixed' ? (
                          <Input className="col-span-3" placeholder="fixed value"
                            value={l.value ?? ''} onChange={e => setLabel(i, { value: e.target.value })} />
                        ) : l.type === 'derived' ? (
                          <Select className="col-span-3" value={l.source || ''}
                            onChange={e => setLabel(i, { source: e.target.value })}>
                            <option value="">choose…</option>
                            {(meta?.derived || []).map(d => <option key={d} value={d}>{d}</option>)}
                          </Select>
                        ) : (
                          <Input className="col-span-3" placeholder="column"
                            value={valueToText(l.source)}
                            onChange={e => {
                              const t = e.target.value
                              setLabel(i, { source: t.includes(',') ? t.split(',').map(s => s.trim()).filter(Boolean) : t })
                            }} />
                        )}
                        <Input className="col-span-3" placeholder="fallback when empty"
                          disabled={l.type === 'fixed' || l.omit_if_blank}
                          value={l.fallback ?? ''} onChange={e => setLabel(i, { fallback: e.target.value })} />
                        <div className="col-span-1 flex justify-end">
                          <Button size="icon" variant="ghost" aria-label="Remove label"
                            onClick={() => delLabel(i)}><Trash2 size={14} /></Button>
                        </div>
                        <div className="col-span-12 -mt-1 flex items-center gap-2 pl-1">
                          <Switch checked={!!l.omit_if_blank} label="Omit when blank"
                            onChange={v => setLabel(i, { omit_if_blank: v })} />
                          <span className="text-[11px] text-faint">
                            omit the whole variable when empty, instead of sending the fallback
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'instantly' && (
              <>
                <Field label="Instantly campaign id"
                  hint="⛔ a live push is refused without this. Copy it from the campaign's URL in Instantly.">
                  <Input className="font-mono" placeholder="00000000-0000-0000-0000-000000000000"
                    value={c.instantly?.campaign_id || ''}
                    onChange={e => setIn('instantly', { campaign_id: e.target.value.trim() })} />
                </Field>
                <Field label="Blocklist id"
                  hint="checked by Instantly before the lead is accepted — the API-level suppression gate">
                  <Input className="font-mono" value={c.instantly?.blocklist_id || ''}
                    onChange={e => setIn('instantly', { blocklist_id: e.target.value.trim() })} />
                </Field>
                <Field label="List id" hint="optional, only if you also file leads into an Instantly list">
                  <Input className="font-mono" value={c.instantly?.list_id || ''}
                    onChange={e => setIn('instantly', { list_id: e.target.value.trim() })} />
                </Field>
                <div className="space-y-3 rounded-lg border p-4">
                  {[['skip_if_in_workspace', 'Skip if the lead is already anywhere in the workspace'],
                    ['skip_if_in_campaign', 'Skip if the lead is already in this campaign'],
                    ['skip_if_in_list', 'Skip if the lead is already in the list']].map(([k, label]) => (
                    <Row key={k} label={label}>
                      <Switch checked={!!c.instantly?.[k]} label={label}
                        onChange={v => setIn('instantly', { [k]: v })} />
                    </Row>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </Drawer>
  )
}

const Row = ({ label, hint, children }) => (
  <div className="flex items-start justify-between gap-4">
    <div className="min-w-0">
      <div className="text-xs font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-faint leading-snug">{hint}</div>}
    </div>
    <div className="shrink-0 pt-0.5">{children}</div>
  </div>
)
