import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import type { LoginServerType } from '@server/utils/loginServers';
import {
  getLoginServerHostname,
  getUserLoginServer,
} from '@server/utils/loginServers';
import axios from 'axios';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { createHash } from 'node:crypto';

const router = Router();

let _avatarImageProxy: ImageProxy | null = null;

function initAvatarImageProxy() {
  if (!_avatarImageProxy) {
    _avatarImageProxy = new ImageProxy('avatar', '');
  }
  return _avatarImageProxy;
}

/** The Jellyfin or Emby server a user's avatar is served from. */
interface AvatarServer {
  type: LoginServerType;
  hostname: string;
}

/**
 * Resolves the server a user's avatar should be fetched from: the additional
 * login server the user signed in with, or the primary media server otherwise.
 */
function getAvatarServer(
  user: Pick<User, 'userType'>
): AvatarServer | undefined {
  const settings = getSettings();
  const loginServer = getUserLoginServer(settings.main, user);

  if (loginServer) {
    return {
      type: loginServer.type,
      hostname: getLoginServerHostname(loginServer),
    };
  }

  const mediaServerType = settings.main.mediaServerType;

  if (
    mediaServerType === MediaServerType.JELLYFIN ||
    mediaServerType === MediaServerType.EMBY
  ) {
    return { type: mediaServerType, hostname: getHostname() };
  }

  return undefined;
}

function getJellyfinAvatarUrl(server: AvatarServer, userId: string) {
  return server.type === MediaServerType.JELLYFIN
    ? `${server.hostname}/UserImage?UserId=${userId}`
    : `${server.hostname}/Users/${userId}/Images/Primary?quality=90`;
}

function computeImageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function checkAvatarChanged(
  user: User
): Promise<{ changed: boolean; etag?: string }> {
  try {
    if (!user || !user.jellyfinUserId) {
      return { changed: false };
    }

    const server = getAvatarServer(user);

    if (!server) {
      return { changed: false };
    }

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(server, user.jellyfinUserId);

    let headResponse;
    try {
      headResponse = await axios.head(jellyfinAvatarUrl);
      if (headResponse.status !== 200) {
        return { changed: false };
      }
    } catch {
      return { changed: false };
    }

    let remoteVersion: string;
    if (server.type === MediaServerType.JELLYFIN) {
      const remoteLastModifiedStr = headResponse.headers['last-modified'] || '';
      remoteVersion = (
        Date.parse(remoteLastModifiedStr) || Date.now()
      ).toString();
    } else {
      remoteVersion =
        headResponse.headers['etag']?.replace(/"/g, '') ||
        Date.now().toString();
    }

    if (user.avatarVersion && user.avatarVersion === remoteVersion) {
      return { changed: false, etag: user.avatarETag ?? undefined };
    }

    const avatarImageCache = initAvatarImageProxy();
    await avatarImageCache.clearCachedImage(jellyfinAvatarUrl);
    const imageData = await avatarImageCache.getImage(
      jellyfinAvatarUrl,
      gravatarUrl(user.email || 'none', { default: 'mm', size: 200 })
    );

    const newHash = computeImageHash(imageData.imageBuffer);

    const hasChanged = user.avatarETag !== newHash;

    user.avatarVersion = remoteVersion;
    if (hasChanged) {
      user.avatarETag = newHash;
    }

    await getRepository(User).save(user);

    return { changed: hasChanged, etag: newHash };
  } catch (error) {
    logger.error('Error checking avatar changes', {
      errorMessage: error.message,
    });
    return { changed: false };
  }
}

router.get('/:jellyfinUserId', async (req, res, next) => {
  if (!req.params.jellyfinUserId.match(/^[a-f0-9]{32}$/)) {
    return next({
      status: 400,
      message: 'Provided URL is not a Jellyfin or Emby avatar.',
    });
  }
  try {
    const avatarImageCache = initAvatarImageProxy();

    const userEtag = req.headers['if-none-match'];

    const versionParam = req.query.v;

    const user = await getRepository(User).findOne({
      where: { jellyfinUserId: req.params.jellyfinUserId },
    });

    const fallbackUrl = gravatarUrl(user?.email || 'none', {
      default: 'mm',
      size: 200,
    });

    const server = user ? getAvatarServer(user) : undefined;

    let imageData;
    if (user?.avatarVersion && server) {
      imageData = await avatarImageCache.getImage(
        getJellyfinAvatarUrl(server, req.params.jellyfinUserId),
        fallbackUrl
      );
      if (imageData.meta.extension === 'json') {
        imageData = await avatarImageCache.getImage(fallbackUrl);
      }
    } else {
      imageData = await avatarImageCache.getImage(fallbackUrl);
    }

    if (userEtag && userEtag === `"${imageData.meta.etag}"` && !versionParam) {
      return res.status(304).end();
    }

    res.writeHead(200, {
      'Content-Type': `image/${imageData.meta.extension}`,
      'Content-Length': imageData.imageBuffer.length,
      'Cache-Control': `public, max-age=${imageData.meta.curRevalidate}`,
      ETag: `"${imageData.meta.etag}"`,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    logger.error('Failed to proxy avatar image', { errorMessage: e.message });
    if (!res.headersSent) {
      return next({
        status: 500,
        message: 'Failed to proxy avatar image.',
      });
    }
    next(e);
  }
});

export default router;
