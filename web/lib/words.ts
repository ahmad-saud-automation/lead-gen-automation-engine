/* The plain words the V5 screens use (docs/UX-REDESIGN.md §5). Engine names stay in the engine;
 * every screen translates through here, so a word is changed in one place. */

/* ── filter operators (core/rules.py OPS) ── */
export const OP_WORDS: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  between: "is between",
  in: "is one of",
  not_in: "is not one of",
  is_blank: "is empty",
  is_not_blank: "is not empty",
  older_than_days: "is older than (days)",
  matches: "matches a pattern (advanced)",
};
/** Most-used first, the advanced one last. */
export const OP_ORDER = [
  "equals", "not_equals", "between", "gte", "lte", "gt", "lt", "in", "not_in", "contains",
  "not_contains", "starts_with", "ends_with", "is_blank", "is_not_blank", "older_than_days", "matches",
];
export const LIST_OPS = new Set(["in", "not_in"]);
export const NUM_OPS = new Set(["gt", "gte", "lt", "lte", "older_than_days"]);

/* ── the engine's 31 fields (core/fieldmap.py FIELDS), in plain words and groups ── */
export type FieldWord = { name: string; hint: string; group: string };
export const FIELD_GROUPS = ["About the company", "About the person", "About the email", "Keeping track"] as const;
export const WRITTEN_GROUP = "Results the app writes";

export const FIELD_WORDS: Record<string, FieldWord> = {
  company_name: { name: "Company name", hint: "Needed", group: "About the company" },
  website: { name: "Website", hint: "Without it the app cannot guess addresses", group: "About the company" },
  reg_number: { name: "Company number", hint: "Optional · spots the same firm twice", group: "About the company" },
  employees: { name: "Staff count", hint: "Optional · for filters", group: "About the company" },
  industry: { name: "Industry", hint: "Optional · for filters", group: "About the company" },
  trading_years: { name: "Years trading", hint: "Optional · for filters", group: "About the company" },
  phone: { name: "Phone", hint: "Optional", group: "About the company" },
  address: { name: "Address", hint: "Optional · the town is taken from it", group: "About the company" },
  region: { name: "Region", hint: "Optional · for filters", group: "About the company" },
  contact_name: { name: "Person to email", hint: "Their full name", group: "About the person" },
  contact_first: { name: "First name", hint: "Worked out from the full name if missing", group: "About the person" },
  contact_last: { name: "Last name", hint: "Worked out from the full name if missing", group: "About the person" },
  job_title: { name: "Job title", hint: "Also sent to Instantly", group: "About the person" },
  seniority_rank: { name: "Seniority", hint: "If set, the app trusts it to pick the best person", group: "About the person" },
  contact_age: { name: "Age", hint: "Breaks ties: the oldest director first", group: "About the person" },
  found_email: { name: "Email already found", hint: "Used first — the cheapest source", group: "About the email" },
  send_gate: { name: "OK to send?", hint: "Must say “yes” before anything is sent", group: "About the email" },
  icebreaker: { name: "Ice breaker", hint: "The line Icebreaker Studio wrote", group: "About the email" },
  reference_email: { name: "Reference email", hint: "Kept for reference, never emailed", group: "About the email" },
  gateway_provider: { name: "Email filter (Mimecast…)", hint: "Lets the app hold firms behind strict filters", group: "About the email" },
  row_key: { name: "Unique ID", hint: "One per row, never repeats", group: "Keeping track" },
  status: { name: "Done / not done", hint: "Blank = not done yet", group: "Keeping track" },
  campaign_tag: { name: "Campaign tag", hint: "Optional · for filters", group: "Keeping track" },
  final_status: { name: "Final result", hint: "", group: WRITTEN_GROUP },
  email_source: { name: "Where the email came from", hint: "", group: WRITTEN_GROUP },
  email_type: { name: "Email type", hint: "", group: WRITTEN_GROUP },
  verification_status: { name: "Check result", hint: "", group: WRITTEN_GROUP },
  mv_date: { name: "Date checked", hint: "", group: WRITTEN_GROUP },
  alternate_emails: { name: "Other addresses found", hint: "", group: WRITTEN_GROUP },
  campaign_type: { name: "Campaign Type", hint: "", group: WRITTEN_GROUP },
  contact_2_email: { name: "Second person's email", hint: "", group: WRITTEN_GROUP },
};

export const fieldName = (f: string): string => FIELD_WORDS[f]?.name ?? f;

/* ── what happened to a lead (core/pipeline.py statuses) ── */
export const RESULT_WORDS: Record<string, { text: string; tone: "good" | "warn" | "bad" | undefined }> = {
  email_found: { text: "Email found", tone: "good" },
  email_not_found: { text: "No email found", tone: undefined },
  no_website: { text: "No website to guess from", tone: undefined },
  hold_security_gateway: { text: "Held — strict email filter", tone: "warn" },
  pushed: { text: "Sent to Instantly", tone: "good" },
};
export const resultWord = (s: string) => RESULT_WORDS[s] ?? { text: s.replace(/_/g, " "), tone: undefined };

/* ── where an email came from (core/pipeline.py: "endole", "pattern_<shape>", a finder name) ── */
export function sourceWord(s: string | undefined): string {
  const v = String(s || "");
  if (!v) return "";
  if (v === "endole") return "already in your sheet";
  if (v.startsWith("pattern_")) return `guessed from the website (${v.slice(8).replace(/_/g, ".")}@)`;
  if (v.includes("icypeas")) return "found by Icypeas";
  if (v.includes("anymail")) return "found by Anymailfinder";
  return v.replace(/_/g, " ");
}

/* ── dates ── */
export function whenWords(ts: string): string {
  // "2026-10-04 17:32:14" -> "Today 17:32" / "Yesterday 17:32" / "Sat 4 Oct 17:32"
  if (!ts) return "";
  const d = new Date(ts.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return ts;
  const hm = ts.slice(11, 16);
  const today = new Date();
  // local calendar days: the engine writes local time, and toISOString() would shift to UTC
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (day(d) === day(today)) return `Today ${hm}`;
  if (day(d) === day(y)) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${hm}`;
}
