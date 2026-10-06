import { Brand } from "@/components/layout/brand";
import { NavLinks } from "@/components/layout/nav-link";

/**
 * Mobile header: brand row plus a horizontal nav strip.
 * The desktop sidebar is hidden below the md breakpoint, so navigation
 * lives here instead.
 */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <Brand />
      </div>
      <nav
        aria-label="Main"
        className="flex items-center gap-1 overflow-x-auto px-3 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <NavLinks />
      </nav>
    </header>
  );
}
