import Image from "next/image";

import { cn } from "@/lib/utils";

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Image
        src="/scope-logo.png"
        alt=""
        width={32}
        height={32}
        aria-hidden="true"
        className="size-8 shrink-0 object-contain"
        preload
        unoptimized
      />
      <span className="text-base font-semibold tracking-tight">scope</span>
    </span>
  );
}
