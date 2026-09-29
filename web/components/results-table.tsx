"use client";

import { Fragment, useState } from "react";

import { Chip } from "@/components/ui";
import type { RunResult } from "@/lib/types";

const DIRECTORS = ["Oldest Director Name", "Youngest Director Name", "Director 1 Name", "Director 2 Name", "Director 3 Name"];

/** Only an outcome is coloured: found green, held amber, nothing found red. */
function statusTone(r: RunResult): "up" | "warn" | "down" | undefined {
  if (r.status === "email_found") return "up";
  if (r.status === "hold_security_gateway") return "warn";
  return r.found_email ? undefined : "down";
}

/** Every lead in a run. Click a row for what was tried: the pattern candidates and how each
 *  verified, the directors on the record, and the full ice breaker. */
export function ResultsTable({ rows, simulated }: { rows: RunResult[]; simulated?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!rows.length) return <div className="empty">No leads in this run yet.</div>;

  return (
    <div className="scroll-x">
      <table className="stat compact results">
        <thead>
          <tr>
            <th className="l">Company</th>
            <th className="l">Director</th>
            <th className="l">Email</th>
            <th className="l">Source</th>
            <th className="l">Verified</th>
            <th className="l">Ice breaker</th>
            <th className="l">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const directors = DIRECTORS.map((k) => r[k]).filter((v): v is string => typeof v === "string" && v !== "");
            return (
              <Fragment key={i}>
                <tr
                  className={open === i ? "rowlink open" : "rowlink"}
                  onClick={() => setOpen(open === i ? null : i)}
                  aria-expanded={open === i}
                >
                  <td className="l"><b>{r.company || "—"}</b></td>
                  <td className="l">{r.selected_director || <span className="faint">—</span>}</td>
                  <td className="l mono">{r.found_email || <span className="faint">—</span>}</td>
                  <td className="l">{r.email_source || <span className="faint">—</span>}</td>
                  <td className="l">{r.verification || <span className="faint">—</span>}</td>
                  <td className="l cell-clip" title={r.icebreaker || ""}>
                    {r.icebreaker ? <>{r.ice_style ? <span className="faint">{r.ice_style} · </span> : null}{r.icebreaker}</> : <span className="faint">—</span>}
                  </td>
                  <td className="l"><Chip tone={statusTone(r)}>{r.status}</Chip></td>
                </tr>
                {open === i ? (
                  <tr className="result-detail">
                    <td className="l" colSpan={7}>
                      <dl className="kv">
                        <dt>Directors</dt>
                        <dd>{directors.length ? [...new Set(directors)].join(" · ") : "—"}</dd>
                        <dt>Mail gateway</dt>
                        <dd>{r.gateway_provider || "none"}</dd>
                        <dt>Patterns tried</dt>
                        <dd>
                          {r.tries?.length ? (
                            <ul className="tries">
                              {r.tries.map((t, k) => (
                                <li key={k}>
                                  <span className={t.accepted ? "pos" : "faint"}>{t.accepted ? "✓" : "·"}</span>{" "}
                                  <span className="mono">{t.email}</span> → {t.verification || "—"}
                                  {t.pattern ? <span className="faint"> ({t.pattern})</span> : null}
                                </li>
                              ))}
                            </ul>
                          ) : "no pattern candidates"}
                        </dd>
                        <dt>Ice breaker</dt>
                        <dd>{r.icebreaker ? <>{r.ice_style ? <b>[{r.ice_style}] </b> : null}{r.icebreaker}</> : "—"}</dd>
                      </dl>
                      {simulated ? <p className="muted">Test run: these addresses were generated from a name pattern and never checked. Never mail them.</p> : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
