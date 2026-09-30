import type { DownloadingItem } from '@server/lib/downloadtracker';
import { Permission } from '@server/lib/permissions';
import { createHash } from 'node:crypto';

/**
 * What a user with View Downloads but without Admin gets to see of a download:
 * enough to draw a progress bar, an ETA and a status, and nothing that names
 * the release or the client, indexer or quality it came through.
 */
export type RestrictedDownloadingItem = Pick<
  DownloadingItem,
  | 'mediaType'
  | 'externalId'
  | 'size'
  | 'sizeLeft'
  | 'status'
  | 'trackedDownloadStatus'
  | 'trackedDownloadState'
  | 'timeLeft'
  | 'estimatedCompletionTime'
  | 'startedAt'
  | 'downloadId'
  | 'episode'
>;

const DOWNLOAD_STATUS_KEYS = new Set(['downloadStatus', 'downloadStatus4k']);

/**
 * The download client id is only used to tell whether several episodes belong
 * to the same season pack, but it can be a torrent info hash that identifies
 * the release, so it is swapped for an opaque value that still groups alike.
 */
const obscureDownloadId = (downloadId: string): string =>
  downloadId
    ? createHash('sha256').update(downloadId).digest('hex').slice(0, 16)
    : downloadId;

export const restrictDownloadingItem = (
  item: DownloadingItem
): RestrictedDownloadingItem => ({
  mediaType: item.mediaType,
  externalId: item.externalId,
  size: item.size,
  sizeLeft: item.sizeLeft,
  status: item.status,
  trackedDownloadStatus: item.trackedDownloadStatus,
  trackedDownloadState: item.trackedDownloadState,
  timeLeft: item.timeLeft,
  estimatedCompletionTime: item.estimatedCompletionTime,
  startedAt: item.startedAt,
  downloadId: obscureDownloadId(item.downloadId),
  episode: item.episode,
});

export type DownloadVisibility = 'full' | 'restricted' | 'none';

export const getDownloadVisibility = (user?: {
  hasPermission: (permissions: Permission) => boolean;
}): DownloadVisibility => {
  if (!user) {
    return 'none';
  }

  if (user.hasPermission(Permission.ADMIN)) {
    return 'full';
  }

  return user.hasPermission(Permission.VIEW_DOWNLOADS) ? 'restricted' : 'none';
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  // Entities are class instances, so anything that is not a Date, Buffer or
  // similar built-in is walked.
  return !(
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    prototype === Map.prototype ||
    prototype === Set.prototype
  );
};

/**
 * Returns a copy of a response body with every download status list trimmed
 * down to what the given visibility allows. Media turns up in almost every
 * response (details, requests, discover, search, collections), so this runs
 * over whole payloads rather than being left to each route.
 */
export const redactDownloadStatus = (
  body: unknown,
  visibility: Exclude<DownloadVisibility, 'full'>,
  seen = new WeakMap<object, unknown>()
): unknown => {
  if (Array.isArray(body)) {
    if (seen.has(body)) {
      return seen.get(body);
    }
    const copy: unknown[] = [];
    seen.set(body, copy);
    body.forEach((value) =>
      copy.push(redactDownloadStatus(value, visibility, seen))
    );
    return copy;
  }

  if (!isPlainObject(body)) {
    return body;
  }

  if (seen.has(body)) {
    return seen.get(body);
  }

  // Respect toJSON so what gets walked is what would have been serialised.
  if (typeof (body as { toJSON?: unknown }).toJSON === 'function') {
    return redactDownloadStatus(
      (body as { toJSON: () => unknown }).toJSON(),
      visibility,
      seen
    );
  }

  const copy: Record<string, unknown> = {};
  seen.set(body, copy);

  for (const [key, value] of Object.entries(body)) {
    if (DOWNLOAD_STATUS_KEYS.has(key) && Array.isArray(value)) {
      copy[key] =
        visibility === 'restricted'
          ? (value as DownloadingItem[]).map(restrictDownloadingItem)
          : [];
    } else {
      copy[key] = redactDownloadStatus(value, visibility, seen);
    }
  }

  return copy;
};

/**
 * Trims download status out of every JSON response for users who are not
 * allowed to see all of it. Needs checkUser to have run first.
 */
export const filterDownloadStatus: Middleware = (req, res, next) => {
  const json = res.json.bind(res);

  res.json = (body?: unknown) => {
    const visibility = getDownloadVisibility(req.user);

    return json(
      visibility === 'full' ? body : redactDownloadStatus(body, visibility)
    );
  };

  next();
};
