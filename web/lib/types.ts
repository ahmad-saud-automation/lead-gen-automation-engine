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
};

export type PlanReport = {
  campaigns: PlanLane[];
  total_take: number;
  globals?: { daily_push_cap?: number };
  warnings?: string[];
  config_issues?: { campaign: string; issue: string }[];
  fieldmaps?: Record<string, FieldmapCheck>;
  /** Where each tab was read from. `live: false` means a local snapshot, not the sheet. */
  sources?: Record<string, { live: boolean; path?: string }>;
};
