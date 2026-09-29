/* Shapes the engine sends back, one per endpoint, named after webapp/server.py.
 * Only the fields a screen reads are listed; the engine may send more. */

/** GET /api/plan — build_plan() in server.py, campaigns.plan() underneath. */
export type PlanLane = {
  campaign: string;
  name: string;
  tab: string;
  matched: number;
  blocked_by_ledger: number;
  available: number;
  take_this_run: number;
  per_run: number;
  estimated_spend_usd: number;
  warnings?: string[];
};

export type FieldmapCheck = {
  ok: boolean;
  blocking?: string[];
  missing_recommended?: string[];
  resolved?: Record<string, string>;
};

/** Where a tab was read from. `live: false` means a local snapshot, not the sheet. */
export type TabSource = { live: boolean; path?: string };

/** GET /api/fieldmap/detail — fieldmap_detail() in server.py. */
export type FieldmapField = {
  field: string;
  direction: "read" | "write" | "both";
  required: boolean;
  recommended: boolean;
  note: string;
  mapped: string;
  suggested: string;
  resolved: string;
};

export type FieldmapDetail = {
  error?: string;
  tab: string;
  file: string;
  rows: number;
  source?: TabSource;
  headers: { name: string; fill: number; used: boolean }[];
  fields: FieldmapField[];
  check: FieldmapCheck;
  preview: Record<string, string>[];
};

/** GET /api/config — data/config.json, API keys masked as "******abcd". Loose on purpose: the
 *  engine owns the list of settings, and save_config() ignores any key it does not know. */
export type Config = {
  [key: string]: unknown;
  keys_set?: Record<string, boolean>;
  has_api_key?: boolean;
};

/** GET /api/campaigns — campaigns_view() in server.py. */
export type Globals = {
  daily_push_cap?: number;
  daily_spend_cap_usd?: number;
  [key: string]: unknown;
};

export type CampaignSummary = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  tab: string;
  fieldmap: string;
  per_run: number;
  per_day: number;
  max_spend_usd: number;
  instantly_campaign_id: string;
  labels: number;
  auto_push: boolean;
  label_issues: string[];
};

export type ConfigIssue = { campaign: string; issue: string };

export type CampaignsView = {
  globals: Globals;
  issues: ConfigIssue[];
  campaigns: CampaignSummary[];
};

/** Every write to config/campaigns.json. A file that would fail validation is never written. */
export type CampaignsSaved = { ok: boolean; issues?: ConfigIssue[]; campaign?: string; campaigns?: number };

/** One campaign exactly as config/campaigns.json holds it — what the editor loads and saves.
 *  The engine keeps any key it does not know, so unknown keys must survive a round trip. */
export type RuleBlock = "all" | "any" | "none";
export type Clause = { field?: string; op?: string; value?: unknown };
export type SortKey = { field?: string; dir?: "asc" | "desc"; order?: string[] };
export type LabelSpec = {
  send_as?: string;
  type?: string;
  source?: string | string[];
  value?: unknown;
  fallback?: string;
  omit_if_blank?: boolean;
};

export type CampaignRaw = {
  [key: string]: unknown;
  id: string;
  name?: string;
  note?: string;
  enabled?: boolean;
  priority?: number;
  tab?: string;
  fieldmap?: string;
  auto_push?: boolean;
  limits?: { per_run?: number; per_day?: number; max_spend_usd?: number };
  writeback?: { enabled?: boolean; campaign_type?: string };
  rules?: Partial<Record<RuleBlock, Clause[]>>;
  order?: SortKey[];
  labels?: LabelSpec[];
  instantly?: {
    campaign_id?: string;
    blocklist_id?: string;
    list_id?: string;
    skip_if_in_workspace?: boolean;
    skip_if_in_campaign?: boolean;
    skip_if_in_list?: boolean;
  };
};

/** GET /api/campaigns/detail */
export type CampaignDetail = {
  error?: string;
  campaign: CampaignRaw;
  issues: ConfigIssue[];
  label_issues: string[];
  operators: string[];
  value_less: string[];
  derived: string[];
  label_types: string[];
};

/** POST /api/campaign/run — the run's first snapshot, or {error}. */
export type RunStarted = { error?: string; run_id?: string };

/** GET /api/run/status — _snapshot() in server.py, with only the events newer than `since`.
 *  A push is a job of its own (`kind: "push"`) pointing back at the run it sends. */
export type RunEvent = {
  seq: number;
  ts?: string;
  company?: string;
  stage?: string;
  status?: string;
  detail?: string;
};

export type RunSnapshot = {
  run_id?: string;
  status: "running" | "finished" | "cancelled" | "error" | "none" | string;
  kind?: "run" | "push";
  source_run?: string | null;
  test_mode?: boolean;
  stage?: string;
  total?: number;
  processed?: number;
  started?: string;
  finished?: string | null;
  campaign?: string;
  campaign_name?: string;
  counters?: {
    found?: number; held?: number; no_website?: number; not_found?: number; verifs?: number;
    pushed?: number; push_failed?: number; push_skipped?: number;
  };
  credits?: { total_usd?: number; total_credits?: number };
  selection?: { matched: number; blocked_by_ledger: number; available: number; day_remaining: number; selected: number } | null;
  events?: RunEvent[];
};

/** GET /api/push/preview — exactly what a push would send, before anything goes. */
export type PushPreview = {
  status?: string;
  ready: number;
  held_not_send_ready?: number;
  delay?: number;
  has_key?: boolean;
  campaign_id?: string;
  campaign_name?: string;
  leads?: ({ company_name?: string; email?: string } & Record<string, unknown>)[];
};

/** GET /api/ledger — Ledger.stats() plus the 25 most recent leads. */
export type LedgerView = {
  total: number;
  pushed: number;
  pending_push: number;
  recent?: { company?: string; status: string; email?: string; pushed?: boolean; when?: string }[];
};

/** POST /api/fieldmap/save */
export type FieldmapSaved = { ok: boolean; error?: string; file?: string; mapped?: number };

export type PlanReport = {
  campaigns: PlanLane[];
  total_take: number;
  globals?: { daily_push_cap?: number };
  warnings?: string[];
  config_issues?: { campaign: string; issue: string }[];
  fieldmaps?: Record<string, FieldmapCheck>;
  sources?: Record<string, TabSource>;
};
