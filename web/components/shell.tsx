"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/icons";

type NavItem = { href: string; label: string; icon: IconName };
type NavGroup = { title: string; icon: IconName; items: NavItem[] };

/* The screens, in the order the work happens: set up the lanes, preview what they would take,
 * run them. Setup is its own group because it is done once per sheet and then left alone. */
export const NAV: NavGroup[] = [
  {
    title: "Pipeline",
    icon: "list-details",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: "list-details" },
      { href: "/plan", label: "Plan preview", icon: "clipboard-check" },
      { href: "/runs", label: "Runs", icon: "activity" },
    ],
  },
  {
    title: "Setup",
    icon: "settings",
    items: [
      { href: "/fieldmap", label: "Field map", icon: "columns-3" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);       // phone strip
  const [panel, setPanel] = useState<number | null>(null);
  const shutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const side = useRef<HTMLElement>(null);
  const tapOpens = useRef(false);

  const show = (i: number) => {
    clearTimeout(shutTimer.current);
    setPanel(i);
  };
  // A moment's grace, so a mouse that slips off the edge does not snap the panel shut.
  const hide = () => {
    clearTimeout(shutTimer.current);
    shutTimer.current = setTimeout(() => setPanel(null), 160);
  };

  // Picking a page closes the menu. Without this the new page loads underneath an open menu
  // and the click looks like it did nothing.
  useEffect(() => {
    setOpen(false);
    setPanel(null);
  }, [pathname]);

  useEffect(() => {
    if (!open && panel === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      setPanel(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!side.current?.contains(e.target as Node)) setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, panel]);

  useEffect(() => () => clearTimeout(shutTimer.current), []);

  const here = NAV.findIndex((g) => g.items.some((it) => isActive(pathname, it.href)));

  const link = (item: NavItem) => {
    const on = isActive(pathname, item.href);
    return (
      <Link key={item.href} href={item.href} className={on ? "on" : undefined}
            aria-current={on ? "page" : undefined}>
        <Icon name={item.icon} size={22} />
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <aside
      ref={side}
      className={open ? "side open" : "side"}
      onMouseEnter={() => clearTimeout(shutTimer.current)}
      onMouseLeave={hide}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPanel(null);
      }}
    >
      <Link className="brand" href="/campaigns" aria-label="Lead Gen Engine, Campaigns">
        <i aria-hidden="true">LG</i>
        <span>Lead Gen Engine</span>
      </Link>
      <button
        type="button"
        className="menu-btn"
        aria-expanded={open}
        aria-controls="side-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "✕" : "☰"}
      </button>

      <nav className="rail" aria-label="Sections">
        {NAV.map((group, i) => (
          <Fragment key={group.title}>
            <Link
              href={group.items[0].href}
              aria-label={group.title}
              className={`rail-btn${i === here ? " here" : ""}${i === panel ? " hot" : ""}`}
              onMouseEnter={() => show(i)}
              onFocus={() => show(i)}
              // No hover on a touch screen: the first tap opens the panel so the group's other
              // pages can be reached, a second tap follows the link.
              onPointerDown={(e) => {
                tapOpens.current = e.pointerType !== "mouse" && panel !== i;
              }}
              onClick={(e) => {
                if (!tapOpens.current) return;
                tapOpens.current = false;
                e.preventDefault();
                show(i);
              }}
            >
              <Icon name={group.icon} size={26} />
            </Link>
            {panel === i ? (
              <div className="panel" role="group" aria-label={group.title}>
                <div className="panel-title">{group.title}</div>
                <div className="panel-links">{group.items.map(link)}</div>
              </div>
            ) : null}
          </Fragment>
        ))}
      </nav>

      <nav id="side-nav" className="phone-nav">
        {NAV.map((group) => (
          <div key={group.title} className="phone-grp">
            <div className="grp lbl">{group.title}</div>
            {group.items.map(link)}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** The bar at the top of every page: what this screen is, and anything it needs on the right.
 *  The link to the V1 interface stays on every page, as it did in V2's header: it is the
 *  fallback if anything here misbehaves. */
export function TopBar({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub ? <span className="sub">{sub}</span> : null}
      </div>
      <div className="right">
        {right}
        <a className="ctl" href="/legacy" title="The original V1 interface, kept as a fallback">
          Old interface
        </a>
      </div>
    </div>
  );
}
