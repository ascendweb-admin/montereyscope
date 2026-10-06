// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XConnectionCard } from "@/app/settings/x-connection-card";
import type { XConnectionStatus } from "@/lib/x/model";

const requestXConnection = vi.fn();

vi.mock("@/lib/x/connection-client", () => ({
  requestXConnection: (operation: string) => requestXConnection(operation),
  xLoginPending: (status: XConnectionStatus) =>
    ["opening", "awaiting_login", "verifying"].includes(status.phase ?? ""),
}));

afterEach(() => {
  cleanup();
  requestXConnection.mockReset();
});

function status(overrides: Partial<XConnectionStatus> = {}): XConnectionStatus {
  return {
    capability: "disconnected",
    providerId: "desktop",
    user: null,
    errorCode: null,
    sessionOnly: false,
    storage: { state: "not_saved", reason: "missing_file", backend: "gnome_libsecret" },
    ...overrides,
  };
}

const READER = { userId: "123", handle: "reader", displayName: "Reader", avatarUrl: null };

describe("X connection card storage states", () => {
  it("claims a saved login only in the saved state", () => {
    render(
      <XConnectionCard
        initialStatus={status({
          capability: "connected",
          user: READER,
          storage: { state: "saved", reason: null, backend: "gnome_libsecret" },
        })}
        cachedTweetCount={3}
      />,
    );
    expect(screen.getByText("Your X login is saved on this device.")).toBeTruthy();
    expect(screen.queryByText(/isn't saved yet/)).toBeNull();
    expect(screen.getByText(/Secure storage diagnostics/)).toBeTruthy();
  });

  it("keeps the connection and offers a retry when saving fails", async () => {
    requestXConnection.mockResolvedValue(
      status({
        capability: "connected",
        user: READER,
        storage: { state: "saved", reason: null, backend: "gnome_libsecret" },
      }),
    );
    render(
      <XConnectionCard
        initialStatus={status({
          capability: "connected",
          user: READER,
          storage: { state: "save_failed", reason: "write_failed", backend: "gnome_libsecret" },
        })}
        cachedTweetCount={0}
      />,
    );
    expect(screen.getByText(/Connected, but your login isn't saved yet/)).toBeTruthy();
    expect(screen.getByText("Reader")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry saving login/ }));
    await waitFor(() => expect(requestXConnection).toHaveBeenCalledWith("retry-storage"));
    await waitFor(() =>
      expect(screen.getAllByText("Your X login is saved on this device.").length).toBeGreaterThan(
        0,
      ),
    );
  });

  it("explains secure-storage setup when no protected backend is available", () => {
    render(
      <XConnectionCard
        initialStatus={status({
          storage: { state: "unavailable", reason: "no_secure_backend", backend: "basic_text" },
        })}
        cachedTweetCount={0}
      />,
    );
    expect(screen.getByText(/system keyring/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry secure storage/ })).toBeTruthy();
    expect(screen.queryByText(/Your X login is saved on this device/)).toBeNull();
  });

  it("shows restore progress instead of a sign-in prompt while restoring", () => {
    render(
      <XConnectionCard
        initialStatus={status({ phase: "verifying", restoring: true })}
        cachedTweetCount={0}
      />,
    );
    expect(screen.getByText("Restoring your saved X login…")).toBeTruthy();
    expect(screen.queryByText(/Finish signing in/)).toBeNull();
    expect(screen.getByText("Restoring")).toBeTruthy();
  });

  it("requests an expired session to sign in again", () => {
    render(
      <XConnectionCard
        initialStatus={status({ phase: "expired", errorCode: "session_expired" })}
        cachedTweetCount={7}
      />,
    );
    expect(screen.getByText(/previous session expired/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect X/ })).toBeTruthy();
  });

  it("reports the session-only fallback for providers without desktop storage", () => {
    render(
      <XConnectionCard
        initialStatus={status({
          capability: "connected",
          user: READER,
          storage: null,
          sessionOnly: true,
        })}
        cachedTweetCount={0}
      />,
    );
    expect(screen.getByText(/Session-only connection/)).toBeTruthy();
  });
});

it("retries offline restoration without starting a new X login", async () => {
  requestXConnection.mockResolvedValue(
    status({
      capability: "connected",
      phase: "connected",
      user: READER,
      storage: { state: "saved", reason: null, backend: "gnome_libsecret" },
    }),
  );
  render(
    <XConnectionCard
      initialStatus={status({
        phase: "error",
        errorCode: "network",
        storage: { state: "saved", reason: null, backend: "gnome_libsecret" },
      })}
      cachedTweetCount={1}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  await waitFor(() => expect(requestXConnection).toHaveBeenCalledWith("retry-storage"));
  expect(requestXConnection).not.toHaveBeenCalledWith("connect");
  await waitFor(() => expect(screen.getByText("Reader")).toBeTruthy());
});

it("retries failed credential removal through Disconnect, not restoration", async () => {
  requestXConnection.mockResolvedValue(status());
  render(
    <XConnectionCard
      initialStatus={status({
        storage: { state: "delete_failed", reason: "delete_failed", backend: "gnome_libsecret" },
      })}
      cachedTweetCount={1}
    />,
  );
  expect(screen.getByText(/otherwise it may reconnect next time/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry removing saved login" }));
  await waitFor(() => expect(requestXConnection).toHaveBeenCalledWith("disconnect"));
  expect(requestXConnection).not.toHaveBeenCalledWith("retry-storage");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry removing saved login" })).toBeNull(),
  );
});
