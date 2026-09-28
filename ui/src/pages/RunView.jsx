import { useEffect, useRef, useState } from 'react'
import {
  Activity, Send, AlertTriangle, CircleCheck, Ban, Square, Info, ShieldCheck,
} from 'lucide-react'
import { api, num, money } from '../api.js'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Badge, Empty, Spinner, Note, Stat,
  Confirm, Drawer, Table, Th, Td, useToast, cx,
} from '../components/ui.jsx'

const STAGE_TONE = { success: 'success', fail: 'danger', held: 'warning', skip: 'neutral',
  retry: 'warning', info: 'primary' }

export default function RunView({ runId }) {
  const toast = useToast()
  const [run, setRun] = useState(null)
  const [events, setEvents] = useState([])
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('all')
  const [preview, setPreview] = useState(null)
  const [confirmPush, setConfirmPush] = useState(false)
  const since = useRef(0)
  const feed = useRef(null)
  const stick = useRef(true)

  // Poll while the run is live. The backend hands back only events newer than `since`,
  // so a 20,000-event run never re-sends its whole history.
  useEffect(() => {
    let alive = true
    let timer
    const tick = async () => {
      try {
        const r = await api.runStatus(runId, since.current)
        if (!alive) return
        if (!r || !r.run_id) { setRun(null); setErr('No run yet.'); return }
        setRun(r)
        if (r.events?.length) {
          since.current = Math.max(since.current, ...r.events.map(e => e.seq)) + 1
          setEvents(x => [...x, ...r.events].slice(-3000))
        }
        setErr('')
        if (r.status === 'running') timer = setTimeout(tick, 900)
      } catch (e) { if (alive) { setErr(e.message); } }
    }
    since.current = 0; setEvents([])
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [runId])

  // follow the feed unless the user has scrolled up to read something
  useEffect(() => {
    const el = feed.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events])

  const loadPreview = async () => {
    try { setPreview(await api.pushPreview(run?.run_id)) }
    catch (e) { toast(e.message, 'danger') }
  }

  const doPush = async (testMode) => {
    setConfirmPush(false)
    try {
      const r = await api.startPush(run?.run_id, testMode)
      if (r.error) throw new Error(r.error)
      toast(testMode ? 'Dry run started — nothing is being sent' : 'Push started', 'success')
      setPreview(null)
    } catch (e) { toast(e.message, 'danger') }
  }

  if (err && !run) return <Empty icon={Activity} title="No run to show" body={err} />
  if (!run) return <div className="flex justify-center py-20"><Spinner size={22} /></div>

  const c = run.counters || {}
  const live = run.status === 'running'
  const pct = run.total ? Math.round((run.processed / run.total) * 100) : 0
  const shown = events.filter(e => filter === 'all' || e.status === filter)
  const counts = events.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] || 0) + 1 }), {})

  return (
    <div className="space-y-5">
      {/* Current activity - the header pattern from Instantly's agent view */}
      <Card>
        <CardBody className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-faint">
              Current activity
              {live && <span className="flex items-center gap-1 text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-live" /> running</span>}
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              {live ? stageLabel(run.stage) : run.status === 'finished' ? 'Run finished' : 'Run ' + run.status}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {run.campaign_name && <Badge tone="primary">{run.campaign_name}</Badge>}
              <Badge tone={run.test_mode ? 'warning' : 'danger'} dot>
                {run.test_mode ? 'test mode — no API calls, no spend' : 'live'}
              </Badge>
              <span className="font-mono text-[11px] text-faint">{run.run_id}</span>
              <span className="text-[11px] text-faint">started {run.started}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {live && <Button variant="danger" onClick={() => api.cancelRun().then(() => toast('Cancelling…'))}>
              <Square size={13} /> Stop
            </Button>}
            {!live && <Button variant="primary" onClick={loadPreview}>
              <Send size={14} /> Review push
            </Button>}
          </div>
        </CardBody>

        <div className="h-1 w-full bg-accent">
          <div className={cx('h-full rounded-r-full transition-[width] duration-500',
            live ? 'bg-primary' : 'bg-success')} style={{ width: `${pct}%` }} />
        </div>
        <CardBody className="flex items-center justify-between py-2.5 text-xs text-muted">
          <span>{num(run.processed)} of {num(run.total)} leads</span>
          <span className="tabular">{pct}%</span>
        </CardBody>
      </Card>

      {run.selection && (
        <Note tone="primary" icon={Info}>
          Selected from <b>{num(run.selection.matched)}</b> matching rows —
          {' '}{num(run.selection.blocked_by_ledger)} already handled,
          {' '}{num(run.selection.available)} available,
          {' '}<b>{num(run.selection.selected)}</b> taken this run
          {run.selection.day_remaining < 1e6 && <> ({num(run.selection.day_remaining)} left in today's limit)</>}.
        </Note>
      )}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Found" value={num(c.found)} tone="success" />
        <Stat label="Not found" value={num(c.not_found)} />
        <Stat label="Held" value={num(c.held)} tone={c.held ? 'warning' : undefined} sub="mail gateway" />
        <Stat label="No website" value={num(c.no_website)} />
        <Stat label="Verifications" value={num(c.verifs)} />
        <Stat label="Spend" value={money(run.credits?.total_usd)}
          tone={run.test_mode ? undefined : 'warning'}
          sub={run.test_mode ? 'simulated' : `${num(run.credits?.total_credits)} credits`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What was checked</CardTitle>
          <div className="flex flex-wrap items-center gap-1">
            {['all', 'success', 'fail', 'held', 'skip', 'retry'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={cx('rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors',
                  filter === f ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-accent')}>
                {f}{f !== 'all' && counts[f] ? ` ${counts[f]}` : ''}
              </button>
            ))}
          </div>
        </CardHeader>
        <div ref={feed} onScroll={e => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }} className="max-h-[26rem] overflow-y-auto">
          {shown.length === 0 ? (
            <Empty icon={Activity} title={live ? 'Waiting for the first lead…' : 'No events match that filter'} />
          ) : (
            <ul className="divide-y">
              {shown.map(e => (
                <li key={e.seq} className="flex items-start gap-3 px-5 py-2 hover:bg-surface-2">
                  <Badge tone={STAGE_TONE[e.status] || 'neutral'} className="mt-0.5 w-20 justify-center">
                    {e.stage}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{e.company || '—'}</div>
                    <div className="truncate text-xs text-muted">{e.detail}</div>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{(e.ts || '').slice(11)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* Push review - the only thing that leaves the machine, so it is always explicit */}
      <Drawer open={!!preview} onClose={() => setPreview(null)} width="max-w-3xl"
        title="Review the push"
        subtitle={preview?.campaign_name ? `${preview.campaign_name} → Instantly` : 'to Instantly'}
        footer={preview && <>
          <Button onClick={() => doPush(true)}><ShieldCheck size={14} /> Dry run (sends nothing)</Button>
          <Button variant="danger" disabled={!preview.ready || !preview.has_key || !preview.campaign_id}
            onClick={() => setConfirmPush(true)}><Send size={14} /> Push {preview.ready} leads</Button>
        </>}>
        {preview && (
          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Send-ready" value={num(preview.ready)} tone="success" />
              <Stat label="Held back" value={num(preview.held_not_send_ready)}
                tone={preview.held_not_send_ready ? 'warning' : undefined} sub="did not pass verification" />
              <Stat label="Delay between sends" value={`${preview.delay}s`} />
            </div>

            {!preview.has_key && <Note tone="danger" icon={AlertTriangle}>
              No Instantly API key in Settings — a live push will be refused.</Note>}
            {!preview.campaign_id && <Note tone="danger" icon={AlertTriangle}>
              This lane has no Instantly campaign id — set it in the campaign's Instantly tab.</Note>}
            {preview.held_not_send_ready > 0 && <Note tone="warning" icon={Ban}>
              <b>{preview.held_not_send_ready}</b> lead(s) found an address but did not pass
              verification, so they are held back. Only a real pass may be sent.</Note>}

            <div>
              <div className="mb-2 text-xs font-semibold">
                Exact payload for the first {Math.min(preview.leads?.length || 0, 25)} lead(s)
              </div>
              <div className="space-y-2">
                {(preview.leads || []).slice(0, 25).map((l, i) => (
                  <details key={i} className="rounded-lg border bg-surface-2">
                    <summary className="cursor-pointer px-3 py-2 text-xs">
                      <span className="font-medium">{l.company_name}</span>
                      <span className="text-muted"> · {l.email}</span>
                    </summary>
                    <pre className="overflow-x-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed">
{JSON.stringify(l, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <Confirm open={confirmPush} onClose={() => setConfirmPush(false)}
        title="Send these leads to Instantly?" confirmLabel="Yes, push them" tone="danger"
        body={<div className="space-y-2">
          <p>This <b>leaves your machine</b>. {preview?.ready} lead(s) will be added to
            campaign <span className="font-mono text-xs">{preview?.campaign_id}</span>.</p>
          <p className="text-xs">The sheet will be updated row by row as each one goes.</p>
        </div>}
        onConfirm={() => doPush(false)} />

      {run.status === 'finished' && !c.pushed && (
        <Note tone="success" icon={CircleCheck}>
          Enrichment finished. Nothing has been sent — use <b>Review push</b> when you are ready.
        </Note>
      )}
    </div>
  )
}

const stageLabel = (s) => ({
  organize: 'Organising leads', gateway: 'Checking mail gateways', endole: 'Trying the existing address',
  pattern: 'Guessing address patterns', verify: 'Verifying addresses', icypeas: 'Searching Icypeas',
  anymail: 'Searching Anymailfinder', icebreaker: 'Writing ice breakers', push: 'Pushing to Instantly',
  sheet: 'Writing back to the sheet', result: 'Recording the result', done: 'Finished',
}[s] || 'Working')
