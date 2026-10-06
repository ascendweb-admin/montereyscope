/**
 * Design-preview fixtures for the stage 1 shell. These are hard-coded,
 * clearly labeled sample values rendered only when the user opens the
 * "Preview with sample data" view. They are never written to SQLite and
 * never fetched from the network.
 */
export interface PreviewCreator {
  displayName: string;
  handle: string;
  videoCount: number;
  livestreamCount: number;
  lastRefreshedLabel: string;
  liveNow: boolean;
}

export const PREVIEW_CREATORS: readonly PreviewCreator[] = [
  {
    displayName: "Veritasium",
    handle: "@veritasium",
    videoCount: 412,
    livestreamCount: 3,
    lastRefreshedLabel: "Refreshed 12 minutes ago",
    liveNow: false,
  },
  {
    displayName: "Kurzgesagt – In a Nutshell",
    handle: "@kurzgesagt",
    videoCount: 208,
    livestreamCount: 1,
    lastRefreshedLabel: "Refreshed 2 hours ago",
    liveNow: false,
  },
  {
    displayName: "NASA",
    handle: "@NASA",
    videoCount: 5106,
    livestreamCount: 214,
    lastRefreshedLabel: "Refreshed just now",
    liveNow: true,
  },
  {
    displayName: "Fireship",
    handle: "@Fireship",
    videoCount: 689,
    livestreamCount: 7,
    lastRefreshedLabel: "Refreshed yesterday",
    liveNow: false,
  },
];
