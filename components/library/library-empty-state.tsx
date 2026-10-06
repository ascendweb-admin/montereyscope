"use client";

import { useState } from "react";
import { Users } from "lucide-react";

import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { CreatorCard } from "@/components/library/creator-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PREVIEW_CREATORS } from "@/lib/fixtures/preview-creators";
import type { CategorySummary } from "@/lib/categories";

/**
 * First-run state for the creator library. The Add creator action opens the
 * real stage 2 flow; the sample-data toggle still shows the intended
 * populated layout without touching the database.
 */
export function LibraryEmptyState({ categories }: { categories: readonly CategorySummary[] }) {
  const [previewing, setPreviewing] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <Card className="border-dashed">
        <CardHeader className="items-center gap-3 pb-2 text-center sm:items-center">
          <span
            aria-hidden="true"
            className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Users className="size-7 text-muted-foreground" />
          </span>
          <CardTitle className="text-xl">No creators yet</CardTitle>
          <CardDescription className="max-w-md text-balance">
            Paste a YouTube channel or handle URL and scope will keep its recent videos and
            livestreams one click away. Everything is stored locally on this machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <AddCreatorDialog size="lg" categories={categories} />
            <Button
              size="lg"
              variant="outline"
              aria-pressed={previewing}
              onClick={() => setPreviewing((value) => !value)}
            >
              {previewing ? "Hide sample layout" : "Preview with sample data"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {previewing ? (
        <section aria-label="Sample dashboard layout" className="flex flex-col gap-4">
          <div
            role="note"
            className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          >
            <Badge variant="secondary">Preview data</Badge>
            <span>
              Sample creators shown for design review only — nothing is saved to your local
              database.
            </span>
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PREVIEW_CREATORS.map((creator) => (
              <li key={creator.handle}>
                <CreatorCard
                  creator={{
                    displayName: creator.displayName,
                    handle: creator.handle,
                    avatarUrl: null,
                    href: null,
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
