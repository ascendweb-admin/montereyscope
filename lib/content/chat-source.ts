/** Public display metadata for a chat citation; contains no job paths or source-file names. */
export interface ChatSource {
  id: string;
  kind?: "video" | "tweet";
  platform?: "youtube" | "rumble";
  url?: string;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  title: string;
  creator?: string;
  /**
   * The channel that hosts the video when `creator` is someone who appears in
   * it rather than who owns it ("Luke Belmar" on "PBD Podcast"). Absent for a
   * channel's own videos; producers leave the key out instead of setting it
   * to undefined, so a live source never blanks an archived one.
   */
  channelName?: string;
  creatorAvatarUrl?: string | null;
  thumbnailUrl?: string | null;
}
