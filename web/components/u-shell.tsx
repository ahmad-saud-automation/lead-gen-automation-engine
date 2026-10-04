"use client";

/* The V5 menu: five places, each with its name next to its icon — no hover panels to discover.
 * On a phone it becomes a bottom bar, like a native app. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon, type IconName } from "@/components/icons";
import { THEME_KEY } from "@/components/shell";
import { money } from "@/lib/format";
import type { CampaignsView, HistoryRow } from "@/lib/types";

type Place = { href: string; label: string; icon: IconName; owns: string[] };

/* `owns`: older addresses that now live inside this place, so the menu still lights up
 * correctly while those pages are being replaced. */
export const PLACES: Place[] = [
  { href: "/", label: "Home", icon: "home", owns: [] },
  { href: "/campaigns", label: "Campaigns", icon: "list-details", owns: ["/plan"] },
  { href: "/leads", label: "Leads", icon: "table", owns: ["/import", "/fieldmap"] },
  { href: "/activity", label: "Activity", icon: "activity", owns: ["/runs", "/history", "/log"] },
  { href: "/settings", label: "Settings", icon: "settings", owns: [] },
];

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

function placeOf(path: string): string {
  if (path === "/") return "/";
  const hit = PLACES.find((p) => p.href !== "/" && (under(path, p.href) || p.owns.some((o) => under(path, o))));
  return hit?.href ?? "";
}

export function USidebar() {
  const path = usePathname() ?? "/";
  const [dark, setDark] = useState(false);
  const [canSignOut, setCanSignOut] = useState(false);
  const [needs, setNeeds] = useState(0);
  const [spend, setSpend] = useState<{ today: number; cap: number } | null>(null);

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { required?: boolean; signed_in?: boolean }) => setCanSignOut(Boolean(s.required && s.signed_in)))
      .catch(() => {});
  }, []);

  // refreshed on every page change: the badge and the spend follow what was just done
  useEffect(() => {
    if (path === "/login") return;
    Promise.all([
      fetch("/api/campaigns", { cache: "no-store" }).then((r) => r.json() as Promise<CampaignsView>),
      fetch("/api/history", { cache: "no-store" }).then((r) => r.json() as Promise<{ runs: HistoryRow[] }>),
    ])
      .then(([c, h]) => {
        setNeeds((c.campaigns ?? []).filter((l) => l.enabled && (!l.instantly_campaign_id || l.schedule?.problems?.length)).length);
        const today = new Date();
        const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const spent = (h.runs ?? []).filter((r) => !r.test_mode && String(r.when).startsWith(key))
          .reduce((n, r) => n + (Number(r.spent_usd) || 0), 0);
        setSpend({ today: spent, cap: Number(c.globals?.daily_spend_cap_usd) || 0 });
      })
      .catch(() => {});
  }, [path]);

  if (path === "/login") return null;

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setDark(!dark);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage off: the choice lasts until the page closes
    }
  };
  const signOut = () => {
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {}).finally(() => window.location.assign("/login"));
  };
  const here = placeOf(path);

  return (
    <aside className="u-side">
      <Link className="u-brand" href="/" aria-label="Lead Gen Engine, Home" style={{ textDecoration: "none" }}>
        <i aria-hidden="true">LG</i>Lead Gen Engine
      </Link>
      <nav className="u-nav" aria-label="Main">
        {PLACES.map((p) => (
          <Link key={p.href} href={p.href} className={here === p.href ? "on" : undefined} aria-current={here === p.href ? "page" : undefined}>
            <Icon name={p.icon} size={20} />
            {p.label}
            {p.href === "/campaigns" && needs ? <span className="u-count" title={`${needs} campaign${needs > 1 ? "s" : ""} need you`}>{needs}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="u-side-foot">
        {spend ? (
          <div className="u-spend">
            <b>Spent today</b>
            <br />
            {money(spend.today)}
            {spend.cap ? ` of ${money(spend.cap)} limit` : ""}
          </div>
        ) : null}
        <button type="button" className="u-btn sm" onClick={toggleTheme}>
          <Icon name={dark ? "sun" : "moon"} size={16} />
          {dark ? "Light mode" : "Dark mode"}
        </button>
        {canSignOut ? (
          <button type="button" className="u-btn sm" onClick={signOut}>
            <Icon name="logout" size={16} />
            Sign out
          </button>
        ) : null}
      </div>
    </aside>
  );
}
