import { useEffect, useState } from 'react'
import { Save, KeyRound, Sheet, SlidersHorizontal, Database, AlertTriangle, Info, Trash2 } from 'lucide-react'
import { api, num } from '../api.js'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Badge, Input, Select, Switch, Field,
  Spinner, Note, Confirm, Table, Th, Td, useToast,
} from '../components/ui.jsx'

const TOGGLES = [
  ['use_endole', 'Use the email already on the row', 'if Found Email has an address, use that instead of guessing. By far the cheapest source — leave this ON'],
  ['verify_endole_with_mf', 'Re-verify an email that is already on the row', 'OFF = trust it and skip MillionVerifier entirely. ON costs ~$0.0018 per lead and protects your domains from bouncing on an old address'],
  ['use_patterns', 'Guess address patterns', 'first.last@, f.last@ and so on — only used when the row has no email of its own'],
  ['use_icypeas', 'Use Icypeas', 'searches by name and company, so it works with no website'],
  ['use_anymailfinder', 'Use Anymailfinder', 'second fallback finder'],
  ['use_icebreaker', 'Write ice breakers', 'the personalisation line sent to Instantly'],
  ['accept_catchall', 'Accept catch-all domains', '⚠️ on means "verified" no longer guarantees deliverable'],
  ['block_security_gateways', 'Hold Mimecast / Proofpoint firms', 'those bounce cold email hard'],
  ['strict_status', 'Blank Status means "not done"', 'anything written in Status makes the engine skip that row'],
  ['use_ledger', 'Never redo a lead', 'records every finished lead so the next run starts where this one stopped'],
  ['retry_not_found', 'Retry "email not found"', 'turn on after adding a finder or a new key'],
  ['sheet_writeback', 'Write results back to the sheet', 'needs a service-account file below'],
]

export default function Settings() {
  const toast = useToast()
  const [cfg, setCfg] = useState(null)
  const [globals, setGlobals] = useState(null)
  const [saving, setSaving] = useState(false)
  const [ledger, setLedger] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = async () => {
    const [c, camps] = await Promise.all([api.config(), api.campaigns()])
    setCfg(c); setGlobals(camps.globals || {})
    api.ledger().then(setLedger).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      await api.saveConfig(cfg)
      await api.saveGlobals({
        daily_push_cap: Number(globals.daily_push_cap) || 0,
        daily_spend_cap_usd: Number(globals.daily_spend_cap_usd) || 0,
      })
      toast('Settings saved', 'success')
      await load()
    } catch (e) { toast(e.message, 'danger') }
    setSaving(false)
  }

  const clearLedger = async () => {
    setConfirmClear(false)
    try { await api.clearLedger(); toast('Ledger cleared', 'success'); load() }
    catch (e) { toast(e.message, 'danger') }
  }

  if (!cfg) return <div className="flex justify-center py-20"><Spinner size={22} /></div>

  const keyField = (name, label, hint) => (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input type="password" className="font-mono" placeholder={cfg.keys_set?.[name] ? 'saved' : 'not set'}
          value={cfg[name] || ''} onChange={e => set(name, e.target.value)} />
        {cfg.keys_set?.[name] && <Badge tone="success" dot>set</Badge>}
      </div>
    </Field>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button variant="primary" onClick={save} loading={saving}><Save size={14} /> Save settings</Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Sheet size={15} /> Google Sheet</CardTitle></CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Sheet URL" hint="paste the whole spreadsheet URL">
              <Input value={cfg.sheet_url || ''} onChange={e => set('sheet_url', e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Service-account JSON file"
              hint="⛔ keep it OUTSIDE this folder — the project syncs to Drive. Needed to read a tab by name and to write results back.">
              <Input className="font-mono" value={cfg.sheet_service_account_file || ''}
                onChange={e => set('sheet_service_account_file', e.target.value)}
                placeholder="C:\ClaudeDeps\eco-google-service-account.json" />
            </Field>
          </div>
          {!cfg.sheet_service_account_file && (
            <div className="sm:col-span-2">
              <Note tone="warning" icon={AlertTriangle}>
                Without a service account the engine can only read the single tab the URL points at,
                and cannot write anything back.
              </Note>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound size={15} /> API keys</CardTitle></CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {keyField('millionverifier_api_key', 'MillionVerifier', 'the one key the engine really needs')}
          {keyField('instantly_api_key', 'Instantly', 'must be a V2 key — a V1 key returns 401')}
          {keyField('icypeas_api_key', 'Icypeas', 'optional finder')}
          {keyField('anymailfinder_api_key', 'Anymailfinder', 'optional finder')}
          <div className="sm:col-span-2">
            <Note tone="primary" icon={Info}>
              Keys are stored in <span className="font-mono">data/config.json</span>, which is
              gitignored. The browser only ever sees a masked value.
            </Note>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><SlidersHorizontal size={15} /> Limits and cost</CardTitle></CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Daily send cap" hint="across every campaign — the mailbox limit">
            <Input type="number" value={globals?.daily_push_cap ?? 0}
              onChange={e => setGlobals(g => ({ ...g, daily_push_cap: e.target.value }))} />
          </Field>
          <Field label="Daily spend cap ($)" hint="across every campaign">
            <Input type="number" step="0.5" value={globals?.daily_spend_cap_usd ?? 0}
              onChange={e => setGlobals(g => ({ ...g, daily_spend_cap_usd: e.target.value }))} />
          </Field>
          <Field label="Cost per verification ($)" hint="MillionVerifier charges per check, hit or miss">
            <Input type="number" step="0.0001" value={cfg.mv_per_verification_usd ?? 0}
              onChange={e => set('mv_per_verification_usd', Number(e.target.value))} />
          </Field>
          <Field label="Pattern mode" hint="lean tries fewer guesses, so it costs less per lead">
            <Select value={cfg.pattern_mode || 'lean'} onChange={e => set('pattern_mode', e.target.value)}>
              <option value="lean">lean</option><option value="full">full</option>
            </Select>
          </Field>
          <Field label="Seconds between pushes"><Input type="number" value={cfg.push_delay_seconds ?? 3}
            onChange={e => set('push_delay_seconds', Number(e.target.value))} /></Field>
          <Field label="API retries" hint="a timeout or 429 is retried, a bad key is not">
            <Input type="number" value={cfg.api_tries ?? 3}
              onChange={e => set('api_tries', Number(e.target.value))} /></Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Pipeline switches</CardTitle></CardHeader>
        <CardBody className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {TOGGLES.map(([k, label, hint]) => (
            <div key={k} className="flex items-start justify-between gap-4 border-b pb-3 last:border-0">
              <div className="min-w-0">
                <div className="text-xs font-medium">{label}</div>
                <div className="mt-0.5 text-[11px] text-faint leading-snug">{hint}</div>
              </div>
              <div className="shrink-0 pt-0.5">
                <Switch checked={!!cfg[k]} onChange={v => set(k, v)} label={label} />
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database size={15} /> Ledger</CardTitle>
          <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)}>
            <Trash2 size={13} /> Clear ledger
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          {ledger ? (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <span>Leads recorded: <b>{num(ledger.total)}</b></span>
                <span>Pushed: <b>{num(ledger.pushed)}</b></span>
                <span>Found but not yet sent: <b className="text-warning">{num(ledger.pending_push)}</b></span>
              </div>
              {!!ledger.recent?.length && (
                <Table>
                  <thead><tr><Th>Company</Th><Th>Status</Th><Th>Email</Th><Th>Sent</Th><Th>When</Th></tr></thead>
                  <tbody>
                    {ledger.recent.slice(0, 10).map((r, i) => (
                      <tr key={i}>
                        <Td className="max-w-xs truncate">{r.company || '—'}</Td>
                        <Td><Badge tone={r.status === 'email_found' ? 'success' : 'neutral'}>{r.status}</Badge></Td>
                        <Td className="font-mono text-[11px] text-muted">{r.email || '—'}</Td>
                        <Td>{r.pushed ? <Badge tone="success" dot>yes</Badge> : <Badge>no</Badge>}</Td>
                        <Td className="text-[11px] text-faint">{r.when}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </>
          ) : <div className="text-xs text-faint">Ledger not loaded.</div>}
          <Note tone="warning" icon={AlertTriangle}>
            After changing anything in the find-or-verify path, <b>clear the ledger</b> — finished
            leads are skipped forever, so the fix would stay invisible.
          </Note>
        </CardBody>
      </Card>

      <Confirm open={confirmClear} onClose={() => setConfirmClear(false)}
        title="Clear the whole ledger?" confirmLabel="Clear it" tone="danger"
        body={<>Every lead becomes eligible again, so the next run may re-verify leads you have
          already paid for. Leads already pushed will also be pushed again.</>}
        onConfirm={clearLedger} />
    </div>
  )
}
