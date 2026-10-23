import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop shell ships this minimal Node server beside the Electron
  // executable. Unlike a static export, standalone output retains Server
  // Components, Server Actions, route handlers, SQLite, and child processes.
  output: "standalone",
  // The AI Research page was folded into AI Chat, whose source picker covers
  // the same selection. Query strings pass through, so an old
  // /research?creators=<id> link lands on /chat?creators=<id>.
  async redirects() {
    return [{ source: "/research", destination: "/chat", permanent: true }];
  },
  // The desktop development host sets its own output directory so it can
  // run alongside `npm run dev`; verification can also supply an override.
  distDir: process.env.SCOPE_NEXT_DIST_DIR ?? ".next",
  // The standalone server never reads these: Electron copies the runtime into
  // its own resources directory, and the desktop host always overrides the
  // data paths. Without these excludes the tracer matches dynamic filesystem
  // probes inside desktop build output (including a previous package's copy
  // of this same server, which makes each build grow) and would copy the
  // developer's local data directory into distributed artifacts.
  // The key must match every server trace entry (routes, middleware, and
  // instrumentation), so it is "*" rather than "/*". Turbopack's standalone
  // copy in this version ignores these, so desktop/scripts/prepare-runtime.cjs
  // enforces the same removals; verify-artifacts.cjs fails if either regresses.
  outputFileTracingExcludes: {
    "*": ["./desktop/**/*", "./data/**/*"],
  },
  // Webpack's standalone trace misses files loaded by the Claude adapter and
  // Next's own server router at runtime. Keep both packages complete so the
  // packaged server can start and serve all routes.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@anthropic-ai/claude-agent-sdk/**/*", "./node_modules/next/dist/**/*"],
  },
};

export default nextConfig;
