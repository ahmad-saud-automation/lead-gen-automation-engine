import { useState } from 'react'
import { ClipboardCheck, AlertTriangle, Info, CircleCheck, Play } from 'lucide-react'
import { api, num, money } from '../api.js'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Badge, Table, Th, Td, Switch,
  Empty, Spinner, Note, Stat, useToast,
} from '../components/ui.jsx'

export default function Plan() {
  const toast = useToast()
  const [rep, setRep] = useState(null)
  const [loading, setLoading] = useState(false)
  const [all, setAll] = useState(true)

  const run = async () => {
    setLoading(true)
    try { setRep(await api.plan(all)) }
    catch (e) { toast(e.message, 'danger') }
    setLoading(false)
  }

  const rows = rep?.campaigns || []
  const blockers = rows.flatMap(r => (r.warnings || [])
    .filter(w => w.includes('will be refused')).map(w => ({ c: r.campaign, w })))
  const notes = rows.flatMap(r => (r.warnings || [])
    .filter(w => !w.includes('will be refused')).map(w => ({ c: r.campaign, w })))

  const snapshots = Object.entries(rep?.sources || {}).filter(([, s]) => !s.live)

  return (
    <div className="space-y-5">
      {snapshots.map(([tab, s]) => (
        <Note key={tab} tone="warning" icon={AlertTriangle}>
          Tab <b>{tab}</b> is being read from a local file, not the live sheet —
          <span className="font-mono"> {s.path}</span>. Counts reflect that snapshot. Clear
          <span className="font-mono"> local_tabs</span> in Settings to go back to the sheet.
        </Note>
      ))}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Plan preview</CardTitle>
            <p className="mt-0.5 text-xs text-muted">
              Reads your sheet and applies every rule. No finder, no verification, no push —
              <b className="text-foreground"> this costs nothing.</b> Run it before every real run.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              <Switch checked={all} onChange={setAll} label="Include disabled" />
              Include disabled
            </label>
            <Button variant="primary" onClick={run} loading={loading}>
              <ClipboardCheck size={14} /> Run preview
            </Button>
          </div>
        </CardHeader>

        {!rep ? (
          <Empty icon={ClipboardCheck} title="Nothing previewed yet"
            body="Run the preview to see how many rows each campaign would take, and what it would cost, before anything is spent."
            action={<Button variant="primary" onClick={run} loading={loading}>Run preview</Button>} />
        ) : loading ? (
          <div className="flex justify-center py-16"><Spinner size={22} /></div>
        ) : rows.length === 0 ? (
          <>
            <Empty icon={AlertTriangle} title="No campaign matched a readable tab"
              body="Either nothing is enabled, or the sheet could not be read." />
            {/* the reason is the useful part - never make someone go and guess it */}
            {(!!rep.warnings?.length || !!rep.config_issues?.length) && (
              <CardBody className="space-y-2 border-t bg-surface-2 rounded-b-xl">
                {(rep.warnings || []).map((w, i) => (
                  <Note key={'w' + i} tone="danger" icon={AlertTriangle}>{w}</Note>
                ))}
                {(rep.config_issues || []).map((i, k) => (
                  <Note key={'c' + k} tone="danger" icon={AlertTriangle}>
                    <b>{i.campaign}</b> — {i.issue}
                  </Note>
                ))}
              </CardBody>
            )}
          </>
        ) : (
          <>
            <div className="grid gap-3 border-b p-5 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Lanes previewed" value={rows.length} />
              <Stat label="Leads this run" value={num(rep.total_take)}
                sub={`daily cap ${num(rep.globals?.daily_push_cap)}`} />
              <Stat label="Estimated spend" tone="warning"
                value={money(rows.reduce((n, r) => n + (r.estimated_spend_usd || 0), 0))}
                sub="assumes ~2 verifications per lead" />
              <Stat label="Blocked by ledger"
                value={num(rows.reduce((n, r) => n + (r.blocked_by_ledger || 0), 0))}
                sub="already handled in an earlier run" />
            </div>

            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th><Th>Tab</Th>
                  <Th right>Matched</Th><Th right>Ledger</Th><Th right>Available</Th>
                  <Th right>This run</Th><Th right>Est. spend</Th><Th>Reads?</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.campaign} className="hover:bg-surface-2">
                    <Td>
                      <div className="font-medium">{r.name}</div>
                      <div className="font-mono text-[11px] text-faint">{r.campaign}</div>
                    </Td>
                    <Td><Badge>{r.tab}</Badge></Td>
                    <Td right>{num(r.matched)}</Td>
                    <Td right className="text-faint">{num(r.blocked_by_ledger)}</Td>
                    <Td right className="font-medium">{num(r.available)}</Td>
                    <Td right>{num(r.take_this_run)}<span className="text-faint"> / {r.per_run}</span></Td>
                    <Td right className="text-muted">{money(r.estimated_spend_usd)}</Td>
                    <Td>
                      {r.available >= 300
                        ? <Badge tone="success" dot>reads</Badge>
                        : r.available > 0
                          ? <Badge tone="warning" dot>too small</Badge>
                          : <Badge tone="danger" dot>empty</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <CardBody className="space-y-3 border-t bg-surface-2 rounded-b-xl">
              {blockers.length === 0 && notes.length === 0 && (
                <Note tone="success" icon={CircleCheck}>Nothing would stop a run.</Note>
              )}
              {blockers.map((b, i) => (
                <Note key={'b' + i} tone="danger" icon={AlertTriangle}>
                  <b>{b.c}</b> — {b.w}
                </Note>
              ))}
              {notes.map((n, i) => (
                <Note key={'n' + i} tone="warning" icon={Info}><b>{n.c}</b> — {n.w}</Note>
              ))}
              {(rep.warnings || []).map((w, i) => (
                <Note key={'g' + i} tone="warning" icon={Info}>{w}</Note>
              ))}
              {(rep.config_issues || []).map((i, k) => (
                <Note key={'c' + k} tone="danger" icon={AlertTriangle}><b>{i.campaign}</b> — {i.issue}</Note>
              ))}
            </CardBody>
          </>
        )}
      </Card>

      {rep && Object.entries(rep.fieldmaps || {}).map(([tab, m]) => (
        <Card key={tab}>
          <CardHeader>
            <CardTitle>Field map — {tab}</CardTitle>
            {m.ok ? <Badge tone="success" dot>valid</Badge> : <Badge tone="danger" dot>problem</Badge>}
          </CardHeader>
          <CardBody className="space-y-2">
            {m.blocking?.map((b, i) => <Note key={i} tone="danger" icon={AlertTriangle}>{b}</Note>)}
            {!!m.missing_recommended?.length && (
              <Note tone="warning" icon={Info}>
                Not mapped, so that capability is off: <b>{m.missing_recommended.join(', ')}</b>
              </Note>
            )}
            {m.ok && !m.missing_recommended?.length &&
              <Note tone="success" icon={CircleCheck}>Every field resolves against this sheet.</Note>}
          </CardBody>
        </Card>
      ))}

      <Note tone="primary" icon={Play}>
        <b>"Reads"</b> means the lane has at least 300 leads. Below that the decision agent
        refuses to call a result, so the test cannot tell you anything either way.
      </Note>
    </div>
  )
}
