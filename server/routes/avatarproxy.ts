import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion } from '@server/utils/appVersion';
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

/** The Jellyfin or Emby server a user's avatar is served from. */
interface AvatarServer {
  type: LoginServerType;
  hostname: string;
  /** Whether this is the primary media server, whose API key Seerr holds. */
  primary: boolean;
}

const avatarImageProxies = new Map<string, ImageProxy>();

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
      primary: false,
    };
  }

  const mediaServerType = settings.main.mediaServerType;

  if (
    mediaServerType === MediaServerType.JELLYFIN ||
    mediaServerType === MediaServerType.EMBY
  ) {
    return { type: mediaServerType, hostname: getHostname(), primary: true };
  }

  return undefined;
}

async function getAvatarImageProxy(server?: AvatarServer) {
  const key = !server
    ? 'fallback'
    : server.primary
      ? 'primary'
      : `login-server-${server.type}`;

  let imageProxy = avatarImageProxies.get(key);

  if (!imageProxy) {
    const headers: Record<string, string> = {};

    if (server) {
      let deviceId = 'BOT_seerr';
      let authToken: string | undefined;

      // Only the primary media server can be queried with Seerr's API key;
      // additional login servers are queried anonymously.
      if (server.primary) {
        const userRepository = getRepository(User);
        const admin = await userRepository.findOne({
          where: { id: 1 },
          select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
          order: { id: 'ASC' },
        });
        deviceId = admin?.jellyfinDeviceId || deviceId;
        authToken = getSettings().jellyfin.apiKey;
      }

      const version =
        server.type === MediaServerType.EMBY ? '1.0.0' : getAppVersion();

      headers['X-Emby-Authorization'] =
        `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${deviceId}", Version="${version}"` +
        (authToken ? `, Token="${authToken}"` : '');
    }

    imageProxy = new ImageProxy('avatar', '', { headers });
    avatarImageProxies.set(key, imageProxy);
  }

  return imageProxy;
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

    const avatarImageCache = await getAvatarImageProxy(server);
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

router.get('/:jellyfinUserId', async (req, res) => {
  try {
    if (!req.params.jellyfinUserId.match(/^[a-f0-9]{32}$/)) {
      throw new Error('Provided URL is not a Jellyfin or Emby avatar.');
    }

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
    const avatarImageCache = await getAvatarImageProxy(server);

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
    logger.error('Failed to proxy avatar image', {
      errorMessage: e.message,
    });
  }
});

export default router;
