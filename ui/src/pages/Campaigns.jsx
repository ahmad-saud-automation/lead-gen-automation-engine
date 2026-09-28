import { useEffect, useState } from 'react'
import {
  AlertTriangle, Play, Settings2, RefreshCw, LayoutList, Gauge, TriangleAlert,
} from 'lucide-react'
import { api, num, money } from '../api.js'
import { go } from '../App.jsx'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Badge, Table, Th, Td, Switch,
  Empty, Spinner, Note, Stat, Confirm, useToast,
} from '../components/ui.jsx'
import CampaignDrawer from '../components/CampaignDrawer.jsx'

export default function Campaigns() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [counts, setCounts] = useState(null)
  const [loadingCounts, setLoadingCounts] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirmRun, setConfirmRun] = useState(null)
  const [busy, setBusy] = useState('')

  const load = () => api.campaigns().then(setData).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])

  // Counts mean reading the whole sheet, so they are asked for, never automatic - the
  // campaign list must open instantly even with no sheet configured.
  const loadCounts = async () => {
    setLoadingCounts(true)
    try {
      const p = await api.plan(true)
      const by = {}
      for (const r of p.campaigns || []) by[r.campaign] = r
      setCounts(by)
      if (!p.campaigns?.length) toast('No lane matched a readable tab', 'warning')
    } catch (e) { toast(e.message, 'danger') }
    setLoadingCounts(false)
  }

  const toggle = async (c, enabled) => {
    setBusy(c.id)
    try {
      const r = await api.saveCampaign({ id: c.id, enabled })
      if (!r.ok) throw new Error(r.issues?.map(i => i.issue).join('; ') || 'could not save')
      toast(`${c.name} ${enabled ? 'enabled' : 'disabled'}`, 'success')
      await load()
    } catch (e) { toast(e.message, 'danger') }
    setBusy('')
  }

  const run = async (c, testMode) => {
    setConfirmRun(null); setBusy(c.id)
    try {
      const r = await api.runCampaign(c.id, testMode)
      if (r.error) throw new Error(r.error)
      toast(`${c.name}: run started${testMode ? ' (test mode, no spend)' : ''}`, 'success')
      go('run', r.run_id)
    } catch (e) { toast(e.message, 'danger') }
    setBusy('')
  }

  if (err) return <Note tone="danger" icon={AlertTriangle}>{err}</Note>
  if (!data) return <div className="flex justify-center py-20"><Spinner size={22} /></div>

  const list = data.campaigns || []
  const enabled = list.filter(c => c.enabled)
  const ready = enabled.filter(c => c.instantly_campaign_id)

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Campaigns" value={list.length} sub={`${enabled.length} enabled`} />
        <Stat label="Ready to send" value={ready.length}
          sub="enabled and pointed at an Instantly campaign"
          tone={enabled.length && !ready.length ? 'warning' : undefined} />
        <Stat label="Daily send cap" value={num(data.globals?.daily_push_cap)} sub="across all campaigns" />
        <Stat label="Daily spend cap" value={money(data.globals?.daily_spend_cap_usd)} sub="across all campaigns" />
      </div>

      {!!data.issues?.length && (
        <Note tone="danger" icon={TriangleAlert}>
          <div className="font-medium mb-1">Config problems in campaigns.json</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {data.issues.map((i, k) => <li key={k}><b>{i.campaign}</b> — {i.issue}</li>)}
          </ul>
        </Note>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Campaigns</CardTitle>
            <p className="mt-0.5 text-xs text-muted">
              Checked in priority order — the first lane whose rules match claims the row, so
              one firm is never in two campaigns.
            </p>
          </div>
          <Button onClick={loadCounts} loading={loadingCounts}>
            <Gauge size={14} /> Load counts
          </Button>
        </CardHeader>

        {list.length === 0 ? (
          <Empty icon={LayoutList} title="No campaigns yet"
            body="Add one to config/campaigns.json and it appears here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10">On</Th>
                <Th>Campaign</Th>
                <Th>Tab</Th>
                <Th right>Priority</Th>
                <Th right>Available</Th>
                <Th right>Per run</Th>
                <Th right>Per day</Th>
                <Th>Target</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.map(c => {
                const cnt = counts?.[c.id]
                const noTarget = !c.instantly_campaign_id
                return (
                  <tr key={c.id} className="hover:bg-surface-2">
                    <Td>
                      <Switch checked={c.enabled} disabled={busy === c.id} label={`Enable ${c.name}`}
                        onChange={v => toggle(c, v)} />
                    </Td>
                    <Td>
                      <div className="font-medium">{c.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-faint">{c.id}</span>
                        {!!c.label_issues?.length &&
                          <Badge tone="danger" dot>{c.label_issues.length} label problem</Badge>}
                      </div>
                    </Td>
                    <Td><Badge>{c.tab}</Badge></Td>
                    <Td right className="text-muted">{c.priority}</Td>
                    <Td right>
                      {cnt ? (
                        <div>
                          <div className="font-medium">{num(cnt.available)}</div>
                          {cnt.blocked_by_ledger > 0 &&
                            <div className="text-[11px] text-faint">{num(cnt.blocked_by_ledger)} done</div>}
                        </div>
                      ) : <span className="text-faint">—</span>}
                    </Td>
                    <Td right className="text-muted">{c.per_run}</Td>
                    <Td right className="text-muted">{c.per_day || '∞'}</Td>
                    <Td>
                      {noTarget
                        ? <Badge tone="warning" dot>no Instantly id</Badge>
                        : <span className="font-mono text-[11px] text-muted">
                            {c.instantly_campaign_id.slice(0, 8)}…
                          </span>}
                    </Td>
                    <Td right>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => setEditing(c.id)}>
                          <Settings2 size={13} /> Configure
                        </Button>
                        <Button size="sm" variant="soft" disabled={!c.enabled || busy === c.id}
                          onClick={() => setConfirmRun(c)}>
                          <Play size={13} /> Run
                        </Button>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}

        <CardBody className="border-t bg-surface-2 rounded-b-xl py-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted">
            <span><b className="text-foreground">Available</b> = rows matching the rules that the ledger has not already handled.</span>
            <span><b className="text-foreground">Run</b> starts enrichment only — sending is always a separate, confirmed step.</span>
          </div>
        </CardBody>
      </Card>

      <Note tone="warning" icon={AlertTriangle}>
        <b>Enable one pair of lanes at a time.</b> Lanes are claimed in priority order, so
        turning all four on means the size lanes take the rows first and the seniority test
        reads a fraction of its real population.
      </Note>

      <CampaignDrawer id={editing} onClose={() => setEditing(null)}
        onSaved={() => { load(); toast('Campaign saved', 'success') }} />

      <Confirm open={!!confirmRun} onClose={() => setConfirmRun(null)} width="max-w-lg"
        title={`Run "${confirmRun?.name}"?`}
        confirmLabel="Run in test mode"
        secondaryLabel={`Run live (~${money((confirmRun?.per_run || 0) * 2 * 0.00178)})`}
        onSecondary={() => run(confirmRun, false)}
        body={
          <div className="space-y-3">
            <p><b>Test mode</b> makes no API calls at all and costs nothing. It proves the
              rules, the field map and the payload — but the email addresses it produces are
              invented and must never be mailed.</p>
            <p><b>Live</b> calls MillionVerifier for real. Up to <b>{confirmRun?.per_run}</b> leads,
              roughly {money((confirmRun?.per_run || 0) * 2 * 0.00178)} at ~2 checks each.</p>
            <p className="text-xs">Either way nothing is sent — the push to Instantly is a
              separate, confirmed step afterwards.</p>
          </div>}
        onConfirm={() => run(confirmRun, true)} />
    </div>
  )
}
