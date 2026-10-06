import { beforeEach, describe, expect, it, vi } from "vitest";
const { content, feeds, transcript, tweets, selected } = vi.hoisted(() => ({
  content: vi.fn(),
  feeds: vi.fn(),
  transcript: vi.fn(),
  tweets: vi.fn(),
  selected: vi.fn(),
}));
vi.mock("@/app/actions/feeds", () => ({
  refreshCreatorContentAction: content,
  refreshCreatorFeedsAction: feeds,
}));
vi.mock("@/app/actions/transcripts", () => ({ getTranscriptAction: transcript }));
vi.mock("@/app/actions/x", () => ({
  refreshCreatorTweetsAction: tweets,
  fetchTweetsAction: selected,
}));
import { POST } from "@/app/api/background/route";
const request = (body: unknown) =>
  new Request("http://localhost/api/background", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => vi.resetAllMocks());
describe("background operation requests", () => {
  it("rejects invalid requests before starting work", async () => {
    for (const body of [
      null,
      [],
      { creatorId: 0 },
      { creatorId: 1, operation: "unknown" },
      { creatorId: 1, operation: "tweets", mode: "recent", limit: 1000 },
      { creatorId: 1, operation: "selected-tweets", tweetIds: [5] },
    ]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(content).not.toHaveBeenCalled();
    expect(tweets).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });
  it("preserves transcript language choices and service failures", async () => {
    const failure = {
      ok: false,
      errorCode: "language_choice",
      message: "Choose a language",
      availableManualLanguages: ["nl"],
    };
    transcript.mockResolvedValue(failure);
    const response = await POST(
      request({ creatorId: 1, operation: "transcript", videoId: "vid0000001", intent: "get" }),
    );
    expect(await response.json()).toEqual(failure);
    expect(transcript).toHaveBeenCalledWith(1, "vid0000001", "get", undefined);
    transcript.mockResolvedValue({ ok: true });
    const selection = { language: "nl", kind: "manual" };
    await POST(
      request({
        creatorId: 1,
        operation: "transcript",
        videoId: "vid0000001",
        intent: "select",
        selection,
      }),
    );
    expect(transcript).toHaveBeenLastCalledWith(1, "vid0000001", "select", selection);
  });
  it("routes creator and X work without coupling it to the router", async () => {
    content.mockResolvedValue({ ok: true });
    feeds.mockResolvedValue({ ok: true });
    tweets.mockResolvedValue({ ok: true });
    selected.mockResolvedValue({ ok: true });
    for (const operation of ["content", "feeds", "tweets", "selected-tweets"]) {
      expect(
        (await POST(request({ creatorId: 2, operation, mode: "older", tweetIds: ["123"] }))).status,
      ).toBe(200);
    }
    expect(content).toHaveBeenCalledWith(2);
    expect(feeds).toHaveBeenCalledWith(2);
    expect(tweets).toHaveBeenCalledWith(2, "older", undefined);
    expect(selected).toHaveBeenCalledWith(2, ["123"]);
  });
});
