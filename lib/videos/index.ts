/**
 * Video feed domain layer (stage 3) — server-only.
 * Never import these modules from client components.
 */
export {
  mapDurationSeconds,
  mapFeedEntry,
  mapLiveStatus,
  mapPublishedAt,
  mergeFeedResults,
  parseChannelFeedPayload,
  pickThumbnailUrl,
  videoIdFromWatchUrl,
} from "./mapper";
export type { FeedParseError, FeedParseResult, VideoDraft } from "./mapper";
export {
  countCachedVideos,
  getVideoForCreator,
  listCachedVideos,
  mergeCreatorFeed,
} from "./repository";
export type {
  FeedTab,
  LiveStatus,
  MergeFeedInput,
  MergeFeedOutcome,
  VideoRecord,
} from "./repository";
export {
  classifyCommandFailure,
  FEED_ERROR_CODE_TO_STATUS,
  getCachedCreatorFeed,
  getCachedVideo,
  listAllVideosWithCreator,
  refreshCreatorFeeds,
  resetInFlightRefreshes,
} from "./service";
export type {
  CreatorCachedFeed,
  FeedErrorCode,
  FeedServiceError,
  RefreshOutcome,
  VideoWithCreator,
} from "./service";
