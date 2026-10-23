import { notFound, redirect } from "next/navigation";

import { getCreatorById } from "@/lib/creators/service";
import { getDb } from "@/lib/db/connection";

// Account → creator lookups read SQLite at request time.
export const dynamic = "force-dynamic";

interface ChannelPageProps {
  params: Promise<{ id: string }>;
}

function parseCreatorId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/**
 * Legacy per-account channel URL. A channel is now one platform account of a
 * creator, so this forwards to that creator's page with the account's tab
 * open. Unknown or removed IDs, source-only hosts, and anything that is not a
 * plain numeric ID fall through to the designed not-found state for this segment.
 */
export default async function ChannelPage({ params }: ChannelPageProps) {
  const { id: rawId } = await params;
  const creatorId = parseCreatorId(rawId);
  if (creatorId === null) {
    notFound();
  }
  const creator = getCreatorById(getDb(), creatorId);
  // A source-only host has no page of its own; only its videos are reachable.
  if (!creator?.followed) {
    notFound();
  }
  redirect(`/creators/${creator.profileId}?account=${creator.id}`);
}
