// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CreatorTabs } from "@/app/creators/[id]/creator-tabs";
import type { CreatorAccountSummary } from "@/lib/creators/profile-service";
import type { AccountContentCounts } from "@/lib/creators/profiles";

function account(id: number, platform: CreatorAccountSummary["platform"]): CreatorAccountSummary {
  return {
    id,
    platform,
    displayName: "Luke Belmar",
    handle: platform === "x" ? "lukebelmar" : "luke",
    channelUrl: `https://example.invalid/${id}`,
    avatarUrl: null,
    lastRefreshedAt: null,
  };
}

const YOUTUBE = account(1, "youtube");
const X = account(2, "x");

const COUNTS = new Map<number, AccountContentCounts>([
  [1, { videos: 10, livestreams: 2, posts: 0 }],
  [2, { videos: 0, livestreams: 0, posts: 30 }],
]);

afterEach(() => {
  cleanup();
});

function tabs() {
  return within(screen.getByRole("navigation", { name: "Luke Belmar's views" }));
}

describe("CreatorTabs", () => {
  it("has no Other videos tab until the person has some", () => {
    render(
      <CreatorTabs
        profileId={5}
        profileName="Luke Belmar"
        accounts={[YOUTUBE, X]}
        counts={COUNTS}
        activeAccountId={null}
      />,
    );

    expect(tabs().getAllByRole("link").length).toBe(3);
    expect(tabs().queryByRole("link", { name: /Other videos/ })).toBeNull();
    expect(
      tabs()
        .getByRole("link", { name: /Overview/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("adds an Other videos tab after the accounts, with its count and address", () => {
    render(
      <CreatorTabs
        profileId={5}
        profileName="Luke Belmar"
        accounts={[YOUTUBE, X]}
        counts={COUNTS}
        activeAccountId={null}
        otherCount={4}
        otherActive
      />,
    );

    const links = tabs().getAllByRole("link");
    expect(links).toHaveLength(4);
    const other = links[3];
    expect(other.textContent).toContain("Other videos");
    expect(other.textContent).toContain("4");
    expect(other.getAttribute("href")).toBe("/creators/5?view=other");
    expect(other.getAttribute("aria-current")).toBe("page");
    // Only one tab is current: the Overview steps aside.
    expect(links[0].getAttribute("aria-current")).toBeNull();
  });

  it("counts attributed videos in the Overview, but only those not already on the accounts", () => {
    render(
      <CreatorTabs
        profileId={5}
        profileName="Luke Belmar"
        accounts={[YOUTUBE, X]}
        counts={COUNTS}
        activeAccountId={1}
        otherCount={4}
        extraOverviewCount={3}
      />,
    );

    // 10 videos + 2 livestreams + 30 posts + 3 appearances on other channels.
    expect(tabs().getByRole("link", { name: /Overview/ }).textContent).toContain("45");
    expect(tabs().getByRole("link", { name: /Other videos/ }).textContent).toContain("4");
  });

  it("gives a person with one account Overview | account | Other videos", () => {
    render(
      <CreatorTabs
        profileId={5}
        profileName="Luke Belmar"
        accounts={[YOUTUBE]}
        counts={COUNTS}
        activeAccountId={1}
        otherCount={2}
        overviewHref="/creators/5?view=overview"
      />,
    );

    const links = tabs().getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/creators/5?view=overview",
      "/creators/5?account=1",
      "/creators/5?view=other",
    ]);
    // The account stays current, as the person's page lands on it.
    expect(links[1].getAttribute("aria-current")).toBe("page");
    expect(links[0].getAttribute("aria-current")).toBeNull();
  });
});
