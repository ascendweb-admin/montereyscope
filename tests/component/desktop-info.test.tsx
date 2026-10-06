// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopInfoSection } from "@/app/settings/desktop-info";

const appInfo = {
  ok: true,
  data: {
    version: "0.1.0",
    platform: "linux",
    arch: "x64",
    packaged: true,
    logsPath: "/tmp/scope/logs",
  },
};

const pendingIntegration = {
  ok: true,
  data: {
    supported: true,
    runningFromAppImage: true,
    appImagePath: "/home/alice/Downloads/scope-0.1.0-linux-x64.AppImage",
    integrated: false,
    managedExecutablePath: "/data/scope/app/scope.AppImage",
    desktopEntryPath: "/data/applications/scope.desktop",
    desktopEntryState: "absent",
    iconPath: "/data/icons/scope.png",
  },
};

const installedIntegration = {
  ok: true,
  data: { ...pendingIntegration.data, integrated: true, desktopEntryState: "managed" },
};

afterEach(() => {
  cleanup();
  delete window.scopeApp;
  vi.unstubAllGlobals();
});

describe("DesktopInfoSection", () => {
  it("shows the app version and platform and opens the logs folder", async () => {
    const openLogs = vi.fn().mockResolvedValue({ ok: true, data: { opened: true } });
    window.scopeApp = {
      info: vi.fn().mockResolvedValue(appInfo),
      openLogs,
    } as unknown as Window["scopeApp"];

    render(<DesktopInfoSection />);

    await waitFor(() => expect(screen.getByText(/Scope 0\.1\.0 for Linux \(x64\)/)).toBeTruthy());
    expect(screen.getByText(/never include provider tokens/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open logs folder" }));
    await waitFor(() => expect(openLogs).toHaveBeenCalledTimes(1));
  });

  it("renders nothing without the desktop bridge", () => {
    render(<DesktopInfoSection />);
    expect(screen.queryByRole("heading", { name: "Desktop app" })).toBeNull();
  });

  it("hides the menu section when the host has no integration channel", async () => {
    window.scopeApp = {
      info: vi.fn().mockResolvedValue(appInfo),
      openLogs: vi.fn(),
    } as unknown as Window["scopeApp"];

    render(<DesktopInfoSection />);

    await waitFor(() => expect(screen.getByText(/Scope 0\.1\.0 for Linux/)).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Application menu" })).toBeNull();
  });

  it("adds, updates through the visible action, and removes the menu copy", async () => {
    const integrationStatus = vi
      .fn()
      .mockResolvedValueOnce(pendingIntegration)
      .mockResolvedValue(installedIntegration);
    const installMenuEntry = vi.fn().mockResolvedValue(installedIntegration);
    const removeMenuEntry = vi.fn().mockResolvedValue({
      ...pendingIntegration,
      data: { ...pendingIntegration.data, removedEntry: true },
    });
    window.scopeApp = {
      info: vi.fn().mockResolvedValue(appInfo),
      openLogs: vi.fn(),
      integrationStatus,
      installMenuEntry,
      removeMenuEntry,
    } as unknown as Window["scopeApp"];

    render(<DesktopInfoSection />);

    const addButton = await screen.findByRole("button", { name: "Add to application menu" });
    expect(screen.getByText(/copies the running AppImage/)).toBeTruthy();
    fireEvent.click(addButton);
    await waitFor(() => expect(installMenuEntry).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/managed copy at/)).toBeTruthy();
    expect(screen.getByText("/data/scope/app/scope.AppImage")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Update application-menu copy" }));
    await waitFor(() => expect(installMenuEntry).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/application-menu copy was updated/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove from application menu" }));
    await waitFor(() => expect(removeMenuEntry).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Add to application menu" })).toBeTruthy();
  });

  it("surfaces an install failure without claiming success", async () => {
    const installMenuEntry = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "entry_conflict", message: "An existing entry was not created by this app." },
    });
    window.scopeApp = {
      info: vi.fn().mockResolvedValue(appInfo),
      openLogs: vi.fn(),
      integrationStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: { ...pendingIntegration.data, desktopEntryState: "foreign" },
      }),
      installMenuEntry,
      removeMenuEntry: vi.fn(),
    } as unknown as Window["scopeApp"];

    render(<DesktopInfoSection />);

    expect(await screen.findByText(/was not created by this app/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to application menu" }));
    await waitFor(() => expect(installMenuEntry).toHaveBeenCalledTimes(1));
    expect(screen.getByText("An existing entry was not created by this app.")).toBeTruthy();
  });
});
