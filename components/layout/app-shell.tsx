import { ResearchActivity } from "@/components/background/research-activity";
import type { ReactNode } from "react";
import { BackgroundChatProvider } from "@/components/ai/background-chat";
import { BackgroundActivity } from "@/components/background/activity";

import { ModelCatalogProvider } from "@/components/ai/model-catalog-provider";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppHeader } from "@/components/layout/app-header";

/**
 * Responsive application shell: persistent sidebar on laptop/desktop,
 * header + horizontal nav on mobile. `children` is the page content area.
 * The model catalog controller lives here so every page shares one refresh
 * loop and the picker sees results without its own polling.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ModelCatalogProvider>
      <BackgroundChatProvider>
        <ResearchActivity />
        <div className="flex min-h-dvh">
          <AppSidebar activity={<BackgroundActivity />} />
          <div className="flex min-w-0 flex-1 flex-col">
            <AppHeader />
            {children}
          </div>
        </div>
      </BackgroundChatProvider>
    </ModelCatalogProvider>
  );
}
