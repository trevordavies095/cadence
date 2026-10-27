"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconSettings } from "@tabler/icons-react";
import { cx } from "./ui";

type NavItem = {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
};

const NAV: NavItem[] = [
  { href: "/", label: "Home", match: (p) => p === "/" },
  { href: "/plan", label: "Plan", match: (p) => p === "/plan" },
  {
    href: "/chat",
    label: "Coach Cade",
    match: (p) => p === "/chat" || p === "/thread",
  },
  {
    href: "/weeks",
    label: "History",
    match: (p) => p === "/weeks" || p === "/review",
  },
];

// The current page is ink text over a 2px accent underline; every other item
// stays quiet. Volt is kept for the page's one primary action, never the header.
const linkBase =
  "inline-flex items-center border-b-2 px-3 py-1.5 text-base font-semibold";
const linkIdle = "border-transparent text-muted hover:text-ink";
const linkActive = "border-accent text-ink";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-raised">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="text-lg font-semibold text-ink no-underline">
            Cadence
          </Link>
          <nav aria-label="Main" className="flex flex-1 items-center gap-1">
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(linkBase, active ? linkActive : linkIdle)}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            aria-current={settingsActive ? "page" : undefined}
            className={cx(
              "inline-flex h-10 w-10 items-center justify-center border-b-2",
              settingsActive ? linkActive : linkIdle,
            )}
          >
            <IconSettings size={22} stroke={1.75} aria-hidden />
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
