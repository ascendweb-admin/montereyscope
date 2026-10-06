"use client";

import { useCallback, useState } from "react";
import { Sparkles } from "lucide-react";

import { ChatPanel } from "@/components/ai/chat-panel";
import type { ChatSource } from "@/components/ai/citation";
import { Button } from "@/components/ui/button";

interface AskAiButtonProps {
  /** Video ids the conversation is grounded in (this video, a channel, …). */
  scope: readonly string[];
  /**
   * Display metadata for the (single) scope video, so transcript citations
   * in answers render as titled source chips instead of file paths.
   */
  source?: ChatSource;
  /** One-line scope description shown under the panel heading. */
  description?: string;
}

/**
 * The "Ask AI" entry point: the button plus the side panel it opens. The
 * panel stays mounted after the first open, so a turn that is still
 * streaming keeps running in the background while the panel is closed.
 */
export function AskAiButton({ scope, source, description }: AskAiButtonProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Sparkles aria-hidden="true" />
        Ask AI
      </Button>
      <ChatPanel
        open={open}
        onClose={close}
        scope={scope}
        sources={source ? [source] : undefined}
        description={description}
      />
    </>
  );
}
