/**
 * Creator library domain layer — server-only.
 * Never import these modules from client components.
 */
export { resolveCreatorFromUrl, buildResolutionArgs, pickAvatarUrl } from "./resolver";
export type {
  ResolvedCreator,
  CreatorResolutionError,
  CreatorResolutionErrorCode,
  CreatorResolutionResult,
} from "./resolver";
export { resolveRumbleCreatorPreview } from "./rumble-resolver";
export type { CreatorPreviewError, CreatorPreviewErrorCode } from "./rumble-resolver";
export {
  addCreatorFromUrl,
  getCreatorById,
  httpStatusForServiceError,
  removeCreatorById,
  resolveCreatorFromAnyUrl,
  saveResolvedCreator,
  saveRumbleCreatorPayload,
  saveXCreatorPayload,
  toCreatorSummary,
} from "./service";
export type { CreatorPreviewModel, CreatorServiceError, CreatorSummary } from "./service";
export {
  addCreator,
  findDuplicateCreator,
  getCreator,
  listCreators,
  removeCreator,
} from "./repository";
export type {
  AddCreatorResult,
  CreatorPlatform,
  CreatorRecord,
  NewCreatorInput,
} from "./repository";
