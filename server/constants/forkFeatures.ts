/**
 * Capabilities this fork adds on top of upstream Seerr. Reported on `GET /status` so a
 * client can feature-detect one rather than assuming every server it talks to is this
 * fork at this revision.
 */
export const FORK_FEATURES = ['episode-requests'] as const;
