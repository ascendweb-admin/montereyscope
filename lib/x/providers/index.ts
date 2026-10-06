/**
 * X provider selection. Exactly one provider is active per process:
 *
 * - `worker`: the default. Uses the configured/bundled X read worker; when
 *   no worker is present the provider reports `unsupported_runtime`, and the
 *   UI offers cached content only.
 * - `fake`: deterministic offline provider, only selectable with
 *   SCOPE_X_FAKE_PROVIDER=1 outside a production runtime. Development and
 *   tests use it; packaged builds can never select it.
 */
import type { XProvider } from "../model";
import { getSharedFakeXProvider } from "./fake";
import { createWorkerXProvider, xWorkerExecutablePath } from "./worker";

let sharedWorkerProvider: XProvider | null = null;

/** True when the fake provider may be selected in this runtime. */
export function fakeProviderAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function getXProvider(): XProvider {
  if (process.env.SCOPE_X_FAKE_PROVIDER === "1" && fakeProviderAllowed()) {
    return getSharedFakeXProvider();
  }
  if (sharedWorkerProvider === null) {
    sharedWorkerProvider = createWorkerXProvider();
  }
  return sharedWorkerProvider;
}

/** Test seam: drop the cached worker provider between tests. */
export function resetXProvider(): void {
  sharedWorkerProvider = null;
}

/** Whether a worker executable is configured for this process. */
export function hasWorkerConfigured(): boolean {
  return xWorkerExecutablePath() !== null;
}
