"use client";

import Link from "next/link";
import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

/**
 * Route-segment error boundary. Catches rendering failures anywhere below
 * the root layout and offers recovery without losing the shell. The digest
 * (when present) is the only detail shown — messages could contain private
 * server paths, so they are logged instead.
 */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main
      id="main"
      tabIndex={-1}
      className="outline-none mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10"
    >
      <Card className="border-dashed">
        <CardHeader className="items-center gap-3 pb-2 text-center">
          <span
            aria-hidden="true"
            className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <TriangleAlert className="size-7 text-muted-foreground" />
          </span>
          <h1 className="text-xl font-semibold leading-none tracking-tight">
            Something went wrong on this page
          </h1>
          <CardDescription className="max-w-md text-balance">
            scope hit an unexpected problem rendering this view. Your saved creators and cached data
            are untouched. Try again, or head back to your library.
          </CardDescription>
          {error.digest ? (
            <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col justify-center gap-3 pb-6 sm:flex-row">
          <Button size="lg" onClick={() => retry()}>
            Try again
          </Button>
          <Link href="/" className={buttonVariants({ variant: "outline", size: "lg" })}>
            Back to library
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
