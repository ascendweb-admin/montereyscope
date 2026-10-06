import Link from "next/link";
import { UserX } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Designed fallback for unknown or removed creator IDs on channel pages.
 * Keeps navigation intact instead of surfacing a raw error.
 */
export default function ChannelNotFound() {
  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <Card className="border-dashed">
        <CardHeader className="items-center gap-3 pb-2 text-center sm:items-center">
          <span
            aria-hidden="true"
            className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <UserX className="size-7 text-muted-foreground" />
          </span>
          <CardTitle className="text-xl">Creator not in your library</CardTitle>
          <CardDescription className="max-w-md text-balance">
            This channel was never saved, or it has been removed. Head back to your library to add
            it again or pick another creator.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center pb-6">
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 motion-reduce:transition-none"
          >
            Back to library
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
