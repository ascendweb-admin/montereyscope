import Link from "next/link";
import { Compass } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * App-wide 404 for URLs that match no route. Segment-specific states (like
 * an unknown creator) have their own designed fallbacks; this one covers
 * everything else without leaking internals.
 */
export default function NotFound() {
  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <Card className="border-dashed">
        <CardHeader className="items-center gap-3 pb-2 text-center">
          <span
            aria-hidden="true"
            className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Compass className="size-7 text-muted-foreground" />
          </span>
          <CardTitle className="text-xl">Page not found</CardTitle>
          <CardDescription className="max-w-md text-balance">
            That address does not match anything in scope. It may be a typo, or the page moved after
            a creator was removed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col justify-center gap-3 pb-6 sm:flex-row">
          <Link
            href="/"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
          >
            Back to library
          </Link>
          <Link
            href="/settings"
            className="inline-flex h-10 items-center justify-center rounded-md border border-input px-6 text-sm font-medium shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
          >
            Open Settings
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
