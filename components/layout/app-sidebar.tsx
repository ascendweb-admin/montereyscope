import type { ReactNode } from "react";

import { Brand } from "@/components/layout/brand";
import { NavLinks } from "@/components/layout/nav-link";
import { Separator } from "@/components/ui/separator";

/**
 * Desktop sidebar with the scope identity and library navigation.
 * On mobile only the activity utility remains, positioned in AppHeader.
 */
export function AppSidebar({ activity }: { activity: ReactNode }) {
  return (
    <aside className="contents md:sticky md:top-0 md:z-20 md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col md:border-r md:bg-card">
      <div className="hidden px-4 py-5 md:block">
        <Brand />
      </div>
      <nav aria-label="Main" className="hidden flex-col gap-1 px-3 md:flex">
        <NavLinks />
      </nav>
      <div className="fixed right-4 top-3 z-30 md:static md:mt-auto md:px-3 md:pb-3">
        {activity}
      </div>
      <div className="hidden px-4 pb-5 md:block">
        <Separator className="mb-4" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Runs on your machine at 127.0.0.1. Data never leaves this device.
        </p>
      </div>
    </aside>
  );
}
