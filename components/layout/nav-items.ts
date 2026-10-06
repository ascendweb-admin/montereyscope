import { FileText, MessagesSquare, Newspaper, Settings, Telescope, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Inert entries are rendered as non-interactive placeholders for later stages. */
  inert?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/feed", label: "Feed", icon: Newspaper },
  { href: "/", label: "Creator library", icon: Users },
  { href: "/research", label: "AI Research", icon: Telescope },
  { href: "/x-research", label: "X Research", icon: Telescope },
  { href: "/chat", label: "AI Chat", icon: MessagesSquare },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];
