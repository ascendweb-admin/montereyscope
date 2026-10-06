import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";

export function LocalOnlyBadge() {
  return (
    <Badge variant="outline" className="gap-1.5 border-border bg-card text-muted-foreground">
      <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      Local only
    </Badge>
  );
}
