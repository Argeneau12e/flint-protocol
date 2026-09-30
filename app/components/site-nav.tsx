/**
 * The header navigation (the part of the chrome that has to be a client
 * component: it highlights the current route and holds the mobile menu open).
 *
 * Five destinations, one tap each, and nothing else in the bar. Everything the
 * app used to explain on the landing page lives under Docs; the nav's job is
 * only to answer "where do I go next", so it stays under six words per item and
 * never grows a submenu.
 *
 * The mobile menu closes on navigation on purpose: a menu left open behind a
 * newly rendered page looks like the page is broken, and it is one more tap than
 * nobody wants.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/agreement/new", label: "Create" },
  { href: "/agent", label: "Agent" },
  { href: "/verify", label: "Verify" },
  { href: "/docs", label: "Docs" },
] as const;

/** `/verify/5Qg…` is still the Verify section; `/` is only itself. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        className="flint-nav-toggle"
        aria-expanded={open}
        aria-controls="site-nav"
        aria-label="Toggle menu"
        onClick={() => setOpen((value) => !value)}
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
          <path
            d="M1 4h16M1 9h16M1 14h16"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>

      <nav className="flint-nav" id="site-nav" data-open={open}>
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(pathname, link.href) ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
