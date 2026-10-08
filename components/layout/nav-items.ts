import { FileText, MessagesSquare, Newspaper, Settings, Telescope, Users } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { XLogo } from "@/components/ui/platform-logos";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /**
   * Extra classes for the icon. Filled brand marks read heavier than the
   * outline lucide icons, so they can be inset within the same 16px slot.
   */
  iconClassName?: string;
  /** Inert entries are rendered as non-interactive placeholders for later stages. */
  inert?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/feed", label: "Feed", icon: Newspaper },
  { href: "/", label: "Creator library", icon: Users },
  { href: "/research", label: "AI Research", icon: Telescope },
  { href: "/x-dashboard", label: "X Dashboard", icon: XLogo, iconClassName: "p-px" },
  { href: "/chat", label: "AI Chat", icon: MessagesSquare },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];
