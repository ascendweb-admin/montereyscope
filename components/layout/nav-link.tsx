"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "@/components/layout/nav-items";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const baseLinkClass =
  "flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none";

export function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();

  if (item.inert) {
    return (
      <span
        aria-disabled="true"
        title="Planned for a later stage"
        className={cn(baseLinkClass, "cursor-not-allowed text-muted-foreground opacity-70")}
      >
        <item.icon className={cn("size-4 shrink-0", item.iconClassName)} aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        <Badge variant="secondary">Soon</Badge>
      </span>
    );
  }

  const isActive = pathname === item.href;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        baseLinkClass,
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <item.icon className={cn("size-4 shrink-0", item.iconClassName)} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

/**
 * Renders the full navigation. Server components render <NavLinks /> so the
 * icon components never cross the server/client boundary as props.
 */
export function NavLinks() {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}
    </>
  );
}
