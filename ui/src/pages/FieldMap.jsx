import { useEffect, useState } from 'react'
import {
  Columns3, AlertTriangle, CircleCheck, Wand2, Save, Info, Eye,
} from 'lucide-react'
import { api, num } from '../api.js'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Badge, Table, Th, Td, Select,
  Empty, Spinner, Note, Stat, useToast, cx,
} from '../components/ui.jsx'

export default function FieldMap() {
  const toast = useToast()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [map, setMap] = useState({})
  const [saving, setSaving] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const load = async () => {
    setErr(''); setD(null)
    try {
      const r = await api.fieldmap()
      if (r.error) throw new Error(r.error)
      setD(r)
      setMap(Object.fromEntries(r.fields.filter(f => f.mapped).map(f => [f.field, f.mapped])))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const acceptAll = () => {
    if (!d) return
    setMap(Object.fromEntries(d.fields.filter(f => f.suggested || f.mapped)
      .map(f => [f.field, f.mapped || f.suggested])))
    toast('Every auto-match accepted — review, then save', 'primary')
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await api.saveFieldmap(d.file, map)
      if (!r.ok) throw new Error(r.error || 'could not save')
      toast(`Saved ${r.mapped} mappings to ${r.file}`, 'success')
      await load()
    } catch (e) { toast(e.message, 'danger') }
    setSaving(false)
  }

  if (err) return <Note tone="danger" icon={AlertTriangle}>{err}</Note>
  if (!d) return <div className="flex justify-center py-20"><Spinner size={22} /></div>

  const check = d.check || {}
  const dirty = d.fields.some(f => (map[f.field] || '') !== (f.mapped || ''))
  const usedNow = new Set(Object.values(map).filter(Boolean))
  const unused = (d.headers || []).filter(h => !usedNow.has(h.name))

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tab" value={d.tab} sub={`${num(d.rows)} rows`} />
        <Stat label="Columns in sheet" value={d.headers?.length || 0} />
        <Stat label="Mapped" value={Object.keys(map).length} sub={`of ${d.fields.length} engine fields`} />
        <Stat label="Status" value={check.ok ? 'Valid' : 'Problem'} tone={check.ok ? 'success' : 'danger'}
          sub={check.ok ? 'safe to run' : 'a run would be blocked'} />
      </div>

      {d.source && !d.source.live && (
        <Note tone="warning" icon={AlertTriangle}>
          This tab is being read from a local file, not the live sheet —
          <span className="font-mono"> {d.source.path}</span>. The columns below are that
          snapshot's. Clear <span className="font-mono">local_tabs</span> in Settings to use
          the sheet again.
        </Note>
      )}
      {(check.blocking || []).map((b, i) => (
        <Note key={i} tone="danger" icon={AlertTriangle}>{b}</Note>
      ))}
      {check.ok && <Note tone="success" icon={CircleCheck}>
        Every required field resolves against this sheet.
      </Note>}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Column mapping</CardTitle>
            <p className="mt-0.5 text-xs text-muted">
              Left is what the engine calls a field. Right is the real column in your sheet.
              Editing <span className="font-mono">{d.file}</span>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => setShowPreview(v => !v)}><Eye size={14} /> Preview rows</Button>
            <Button onClick={acceptAll}><Wand2 size={14} /> Accept auto-match</Button>
            <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
              <Save size={14} /> {dirty ? 'Save mapping' : 'Saved'}
            </Button>
          </div>
        </CardHeader>

        <Note tone="primary" icon={Info} className="mx-5 mt-4">
          An <b>explicit</b> mapping always wins, and if the cell is blank the value is blank —
          the engine never quietly falls back to another column. Leave a field unmapped and it
          uses the old alias guessing instead.
        </Note>

        <Table className="mt-4">
          <thead>
            <tr>
              <Th>Engine field</Th>
              <Th>Your column</Th>
              <Th right>Filled</Th>
              <Th>Used for</Th>
            </tr>
          </thead>
          <tbody>
            {d.fields.map(f => {
              const chosen = map[f.field] || ''
              const resolvedByAlias = !chosen && f.resolved
              const missing = f.required && !chosen && !f.resolved
              const header = d.headers?.find(h => h.name === (chosen || f.resolved))
              return (
                <tr key={f.field} className={cx('hover:bg-surface-2', missing && 'bg-danger-soft/40')}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px]">{f.field}</span>
                      {f.required && <Badge tone="danger">required</Badge>}
                      {!f.required && f.recommended && <Badge tone="warning">recommended</Badge>}
                      {f.direction === 'write' && <Badge>write</Badge>}
                      {f.direction === 'both' && <Badge tone="primary">read + write</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Select className="w-64" value={chosen}
                        onChange={e => setMap(m => {
                          const n = { ...m }
                          if (e.target.value) n[f.field] = e.target.value; else delete n[f.field]
                          return n
                        })}>
                        <option value="">— not mapped —</option>
                        {(d.headers || []).map(h => <option key={h.name} value={h.name}>{h.name}</option>)}
                      </Select>
                      {!chosen && f.suggested && (
                        <Button size="sm" variant="ghost"
                          onClick={() => setMap(m => ({ ...m, [f.field]: f.suggested }))}>
                          use “{f.suggested}”
                        </Button>
                      )}
                    </div>
                    {resolvedByAlias && (
                      <div className="mt-1 text-[11px] text-faint">
                        currently guessed as <b>{f.resolved}</b>
                      </div>
                    )}
                    {missing && <div className="mt-1 text-[11px] text-danger">
                      required — a run is blocked until this is mapped</div>}
                  </Td>
                  <Td right>
                    {header ? (
                      // A low fill only matters for a column the engine READS. A write
                      // target is supposed to be empty — Status is blank on all 21,714
                      // rows precisely because blank means "not processed yet".
                      <span title={f.direction !== 'read' ? 'the engine writes this column, so a low fill is normal' : ''}
                        className={cx('tabular', f.direction !== 'read' ? 'text-faint'
                          : header.fill === 0 ? 'text-danger'
                          : header.fill < 30 ? 'text-warning' : 'text-muted')}>
                        {header.fill}%
                      </span>
                    ) : <span className="text-faint">—</span>}
                  </Td>
                  <Td className="max-w-sm text-xs text-muted">{f.note}</Td>
                </tr>
              )
            })}
          </tbody>
        </Table>

        <CardBody className="border-t bg-surface-2 rounded-b-xl">
          <div className="text-xs">
            <b>{unused.length}</b> column(s) in the sheet are not used by the engine:
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unused.map(h => (
                <Badge key={h.name} title={`${h.fill}% filled`}>
                  {h.name} <span className="text-faint">{h.fill}%</span>
                </Badge>
              ))}
            </div>
            <p className="mt-3 text-muted">
              That is fine — the campaign label table can still send any of them to Instantly
              by name, without the engine needing to understand them.
            </p>
          </div>
        </CardBody>
      </Card>

      {showPreview && (
        <Card>
          <CardHeader><CardTitle>First 5 rows, as the engine reads them</CardTitle></CardHeader>
          {(d.preview || []).length === 0 ? <Empty icon={Columns3} title="No rows to preview" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>Engine field</Th>
                  {(d.preview || []).map((_, i) => <Th key={i}>Row {i + 1}</Th>)}
                </tr>
              </thead>
              <tbody>
                {d.fields.filter(f => map[f.field] || f.resolved).map(f => (
                  <tr key={f.field} className="hover:bg-surface-2">
                    <Td className="font-mono text-[12px]">{f.field}</Td>
                    {(d.preview || []).map((row, i) => (
                      <Td key={i} className="max-w-[14rem] truncate text-xs text-muted"
                        title={row[map[f.field] || f.resolved] || ''}>
                        {row[map[f.field] || f.resolved] || <span className="text-faint">—</span>}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  )
}
