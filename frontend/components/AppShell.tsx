"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import {
  IconCalendarWeek,
  IconHistory,
  IconHome,
  IconMessageCircle,
  IconSettings,
} from "@tabler/icons-react";
import { cx } from "./ui";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; stroke?: number; className?: string; "aria-hidden"?: boolean }>;
  match: (pathname: string) => boolean;
};

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: IconHome, match: (p) => p === "/" },
  { href: "/plan", label: "Plan", icon: IconCalendarWeek, match: (p) => p === "/plan" },
  {
    href: "/chat",
    label: "Coach Cade",
    icon: IconMessageCircle,
    match: (p) => p === "/chat" || p === "/thread",
  },
  {
    href: "/weeks",
    label: "History",
    icon: IconHistory,
    match: (p) => p === "/weeks" || p === "/review",
  },
];

// The current page is ink text with a 2px accent rule; every other item stays quiet.
// Volt is kept for the page's one primary action, never the nav.
//
// On a phone the nav is a tab bar fixed to the bottom of the screen, icon over label,
// with the rule along its top edge. From `sm` up it sits in the header as text links
// with the rule underneath. The heights here are the ones --shell-top and
// --shell-bottom in globals.css reserve.
const linkBase = cx(
  "flex h-16 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 text-[0.8125rem] font-semibold no-underline",
  "sm:h-auto sm:flex-none sm:flex-row sm:border-t-0 sm:border-b-2 sm:px-3 sm:py-1.5 sm:text-base",
);
const linkIdle = "border-transparent text-muted hover:text-ink";
const linkActive = "border-accent text-ink";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";
  // On a phone the Coach Cade page brings its own slim header, so the top bar steps
  // aside there and only the tab bar is left of the shell (see globals.css).
  const chat = pathname === "/chat";

  return (
    <div
      className="flex min-h-dvh flex-col pb-(--shell-bottom)"
      data-shell-page={chat ? "chat" : undefined}
    >
      <header
        className={cx(
          "sticky top-0 z-10 border-b border-border bg-raised pt-[env(safe-area-inset-top)]",
          chat && "max-sm:border-b-0 max-sm:pt-0",
        )}
      >
        <div
          className={cx(
            "mx-auto flex h-14 max-w-3xl items-center gap-6 px-4 sm:h-16 sm:px-6",
            chat && "max-sm:h-0",
          )}
        >
          <Link
            href="/"
            className={cx("text-lg font-semibold text-ink no-underline", chat && "max-sm:hidden")}
          >
            Cadence
          </Link>
          <nav
            aria-label="Main"
            className={cx(
              "fixed inset-x-0 bottom-0 flex border-t border-border bg-raised pb-[env(safe-area-inset-bottom)]",
              "sm:static sm:flex-1 sm:items-center sm:gap-1 sm:border-t-0 sm:bg-transparent sm:pb-0",
            )}
          >
            {NAV.map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(linkBase, active ? linkActive : linkIdle)}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={24} stroke={1.75} className="sm:hidden" aria-hidden />
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
              "ml-auto inline-flex h-11 w-11 items-center justify-center border-b-2",
              settingsActive ? linkActive : linkIdle,
              chat && "max-sm:hidden",
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
