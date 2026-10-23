// @vitest-environment happy-dom
/**
 * Appearances on other people's channels are listed under the person they
 * feature, not under the (often hidden) channel that hosts them, and say
 * which channel that is.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatSourcePicker,
  type PickerCreator,
  type PickerVideo,
} from "@/components/ai/chat-source-picker";

afterEach(cleanup);

const CREATORS: PickerCreator[] = [
  { id: 1, profileId: 1, displayName: "Luke Belmar", avatarUrl: null, platform: "youtube" },
  { id: 2, profileId: 2, displayName: "Dana Writer", avatarUrl: null, platform: "youtube" },
];

const OWN: PickerVideo = {
  id: "ownVideo0001",
  creatorId: 1,
  title: "Luke's own upload",
  creatorName: "Luke Belmar",
  categoryIds: [],
  publishedAt: "2026-10-01T00:00:00.000Z",
};

/** On a hidden host (id 99), which the picker has no creator row for. */
const APPEARANCE: PickerVideo = {
  id: "guestVid0001",
  creatorId: 99,
  title: "Luke on the podcast",
  creatorName: "Luke Belmar",
  featuredProfileId: 1,
  featuredName: "Luke Belmar",
  hostName: "PBD Podcast",
  platform: "youtube",
  categoryIds: [],
  publishedAt: "2026-10-02T00:00:00.000Z",
};

const OTHER_PERSON: PickerVideo = {
  id: "danaVideo001",
  creatorId: 2,
  title: "Dana's upload",
  creatorName: "Dana Writer",
  categoryIds: [],
  publishedAt: "2026-10-03T00:00:00.000Z",
};

function renderPicker() {
  const onConfirm = vi.fn();
  render(
    <ChatSourcePicker
      open
      onClose={() => {}}
      videos={[OWN, APPEARANCE, OTHER_PERSON]}
      creators={CREATORS}
      categories={[]}
      selected={new Set()}
      onConfirm={onConfirm}
    />,
  );
  return { picker: screen.getByRole("dialog", { name: "Choose sources" }), onConfirm };
}

describe("ChatSourcePicker — appearances", () => {
  it("groups an appearance under the person it features, with the host named", () => {
    const { picker } = renderPicker();

    const luke = within(picker).getByRole("region", { name: "Luke Belmar" });
    expect(within(luke).getByRole("checkbox", { name: "Select Luke's own upload" })).toBeTruthy();
    expect(within(luke).getByRole("checkbox", { name: "Select Luke on the podcast" })).toBeTruthy();
    expect(within(luke).getByText("on PBD Podcast")).toBeTruthy();
    // No second group for the hosting channel, and nothing under the other person.
    expect(within(picker).queryByRole("region", { name: "PBD Podcast" })).toBeNull();
    const dana = within(picker).getByRole("region", { name: "Dana Writer" });
    expect(within(dana).queryByText("on PBD Podcast")).toBeNull();
    expect(within(dana).queryByRole("checkbox", { name: "Select Luke on the podcast" })).toBeNull();
  });

  it("does not add 'on …' to a channel's own video", () => {
    const { picker } = renderPicker();
    const own = within(picker)
      .getByRole("checkbox", { name: "Select Luke's own upload" })
      .closest("div.group");
    expect(own).not.toBeNull();
    expect(within(own as HTMLElement).queryByText(/^on /)).toBeNull();
  });

  it("finds an appearance by the host's name", () => {
    const { picker } = renderPicker();

    fireEvent.change(within(picker).getByRole("searchbox"), { target: { value: "pbd" } });

    expect(
      within(picker).getByRole("checkbox", { name: "Select Luke on the podcast" }),
    ).toBeTruthy();
    expect(within(picker).queryByRole("checkbox", { name: "Select Luke's own upload" })).toBeNull();
    expect(within(picker).queryByRole("checkbox", { name: "Select Dana's upload" })).toBeNull();
  });

  it("hands back the real video, whichever channel hosts it", () => {
    const { picker, onConfirm } = renderPicker();

    fireEvent.click(within(picker).getByRole("checkbox", { name: "Select Luke on the podcast" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Use 1 source" }));

    expect(onConfirm).toHaveBeenCalledWith([{ kind: "video", id: "guestVid0001" }]);
  });
});
