/**
 * api.js - one thin wrapper over the FastAPI backend.
 *
 * The backend answers 200 with an {error: "..."} body for expected problems (no campaign,
 * unreadable tab, bad field map) rather than an HTTP error, so every caller has to check
 * `.error`. `get`/`post` surface it the same way a network failure would, so a screen only
 * ever has one thing to handle.
 */
const j = async (res) => {
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { error: text.slice(0, 300) } }
  if (!res.ok) throw new Error(body.error || body.detail || `${res.status} ${res.statusText}`)
  return body
}

export const get = (path, params) => {
  const q = params ? '?' + new URLSearchParams(params) : ''
  return fetch(`/api${path}${q}`, { headers: { 'Cache-Control': 'no-cache' } }).then(j)
}

export const post = (path, body) =>
  fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(j)

export const api = {
  config: () => get('/config'),
  saveConfig: (patch) => post('/config', patch),

  campaigns: () => get('/campaigns'),
  campaignDetail: (id) => get('/campaigns/detail', { id }),
  saveCampaign: (patch) => post('/campaigns/save', patch),
  saveGlobals: (patch) => post('/campaigns/globals', patch),

  plan: (all) => get('/plan', all ? { all: 'true' } : undefined),

  fieldmap: (tab) => get('/fieldmap/detail', tab ? { tab } : undefined),
  saveFieldmap: (file, mapping) => post('/fieldmap/save', { file, mapping }),

  runCampaign: (campaign, test_mode) => post('/campaign/run', { campaign, test_mode }),
  runStatus: (run_id, since) => get('/run/status', { run_id: run_id || '', since: since || 0 }),
  cancelRun: () => post('/run/cancel'),

  pushPreview: (run_id) => get('/push/preview', run_id ? { run_id } : undefined),
  startPush: (run_id, test_mode) => post('/push/start', { run_id, test_mode, confirm: true }),

  dashboard: () => get('/dashboard'),
  history: () => get('/history'),
  ledger: () => get('/ledger'),
  clearLedger: () => post('/ledger/clear'),
}

/** Money and counts, formatted the same way everywhere. */
export const money = (n) => '$' + (Number(n) || 0).toFixed(2)
export const num = (n) => (Number(n) || 0).toLocaleString('en-GB')
