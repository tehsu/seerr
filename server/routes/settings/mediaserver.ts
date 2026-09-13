import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { restartJobs } from '@server/job/schedule';
import type { JellyfinSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { getHostname } from '@server/utils/getHostname';
import type { LoginServerType } from '@server/utils/loginServers';
import {
  getLoginServerKey,
  isLoginServerType,
} from '@server/utils/loginServers';
import { Router } from 'express';
import net from 'net';
import { z } from 'zod';

const mediaServerRoutes = Router();

/** Jellyfin/Emby always identify the Seerr admin account with this device id. */
const ADMIN_DEVICE_ID = 'BOT_seerr';

const primaryServerSchema = z.object({
  type: z.union([
    z.literal(MediaServerType.PLEX),
    z.literal(MediaServerType.JELLYFIN),
    z.literal(MediaServerType.EMBY),
  ]),
  // Jellyfin/Emby connection details and admin credentials
  hostname: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  useSsl: z.boolean().optional(),
  urlBase: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  // Plex authentication token, obtained from plex.tv
  authToken: z.string().optional(),
  /**
   * Whether the Jellyfin/Emby server that is being replaced should be kept as
   * an additional sign-in server, so its users can still sign in.
   */
  keepForSignIn: z.boolean().optional(),
});

type PrimaryServerRequest = z.infer<typeof primaryServerSchema>;

const getServerName = (type: MediaServerType): string => {
  switch (type) {
    case MediaServerType.PLEX:
      return 'Plex';
    case MediaServerType.JELLYFIN:
      return 'Jellyfin';
    case MediaServerType.EMBY:
      return 'Emby';
    default:
      return 'Not configured';
  }
};

const getClientIp = (ip?: string): string | undefined => {
  if (!ip) {
    return undefined;
  }

  if (net.isIPv4(ip)) {
    return ip;
  }

  if (net.isIPv6(ip)) {
    return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  }

  return undefined;
};

/**
 * Points Seerr at a new Jellyfin or Emby server.
 *
 * The server is verified with the given admin credentials before anything is
 * changed, and the admin account it is verified with becomes the media server
 * account of the Seerr owner, so they can still sign in afterwards.
 */
const switchToJellyfin = async (
  type: LoginServerType,
  body: PrimaryServerRequest,
  owner: User,
  clientIp?: string
): Promise<void> => {
  const settings = getSettings();
  const userRepository = getRepository(User);

  if (!body.hostname) {
    throw new ApiError(400, ApiErrorCode.InvalidUrl);
  }

  if (!body.username) {
    throw new ApiError(400, ApiErrorCode.InvalidCredentials);
  }

  const port = body.port ?? 8096;
  const useSsl = body.useSsl ?? false;
  const urlBase = body.urlBase ?? '';
  const hostname = getHostname({
    useSsl,
    ip: body.hostname,
    port,
    urlBase,
  });

  const server = new JellyfinAPI(hostname, undefined, ADMIN_DEVICE_ID, type);
  const account = await server.login(body.username, body.password, clientIp);

  if (!account.User.Policy.IsAdministrator) {
    throw new ApiError(403, ApiErrorCode.NotAdmin);
  }

  const linkedUser = await userRepository.findOne({
    select: { id: true },
    where: { jellyfinUserId: account.User.Id },
  });

  if (linkedUser && linkedUser.id !== owner.id) {
    throw new ApiError(422, ApiErrorCode.AccountAlreadyLinked);
  }

  const apiKey = await new JellyfinAPI(
    hostname,
    account.AccessToken,
    ADMIN_DEVICE_ID,
    type
  ).createApiToken('Seerr');

  const serverName = await server.getServerName();

  // An additional sign-in server of the same type as the new primary media
  // server is never used, so the one being promoted is turned off. Its
  // external URLs are carried over when it is the very same server.
  const loginServer = settings.main.loginServers[getLoginServerKey(type)];
  const isPromotedLoginServer =
    loginServer.ip === body.hostname &&
    loginServer.port === port &&
    !!loginServer.useSsl === useSsl &&
    (loginServer.urlBase ?? '') === urlBase;

  loginServer.enabled = false;

  settings.jellyfin = {
    name: serverName,
    serverId: account.User.ServerId,
    ip: body.hostname,
    port,
    useSsl,
    urlBase,
    externalHostname: isPromotedLoginServer ? loginServer.externalHostname : '',
    jellyfinForgotPasswordUrl: isPromotedLoginServer
      ? loginServer.forgotPasswordUrl
      : '',
    // The libraries of the previous media server do not exist on this one
    libraries: [],
    apiKey,
  };

  owner.userType =
    type === MediaServerType.JELLYFIN ? UserType.JELLYFIN : UserType.EMBY;
  owner.jellyfinUserId = account.User.Id;
  owner.jellyfinUsername = account.User.Name;
  owner.jellyfinAuthToken = account.AccessToken;
  owner.jellyfinDeviceId = ADMIN_DEVICE_ID;
  owner.avatar = `/avatarproxy/${account.User.Id}?v=${owner.avatarVersion}`;

  await userRepository.save(owner);
};

/**
 * Points Seerr at Plex.
 *
 * The Plex account the token belongs to becomes the media server account of
 * the Seerr owner; its token is what Seerr uses to talk to plex.tv. The server
 * itself is only kept when the account still owns the one that was previously
 * configured, otherwise it has to be selected in the Plex settings.
 */
const switchToPlex = async (
  body: PrimaryServerRequest,
  owner: User
): Promise<void> => {
  const settings = getSettings();
  const userRepository = getRepository(User);

  if (!body.authToken) {
    throw new ApiError(400, ApiErrorCode.InvalidAuthToken);
  }

  const plexTvClient = new PlexTvAPI(body.authToken);
  const account = await plexTvClient.getUser();

  const ownedServers = (await plexTvClient.getDevices()).filter(
    (device) => device.provides.includes('server') && device.owned
  );

  if (!ownedServers.length) {
    throw new ApiError(400, ApiErrorCode.NoServersFound);
  }

  const linkedUser = await userRepository.findOne({
    select: { id: true },
    where: { plexId: account.id },
  });

  if (linkedUser && linkedUser.id !== owner.id) {
    throw new ApiError(422, ApiErrorCode.AccountAlreadyLinked);
  }

  // Unless the previously configured Plex server is still owned by this
  // account, its connection details and libraries are of no use
  const keepsPreviousServer =
    !!settings.plex.machineId &&
    ownedServers.some(
      (server) => server.clientIdentifier === settings.plex.machineId
    );

  if (!keepsPreviousServer) {
    settings.plex = {
      name: '',
      ip: '',
      port: 32400,
      useSsl: false,
      libraries: [],
    };
  }

  owner.userType = UserType.PLEX;
  owner.plexId = account.id;
  owner.plexUsername = account.username;
  owner.plexToken = account.authToken;
  owner.avatar = account.thumb;

  await userRepository.save(owner);
};

/**
 * Keeps the Jellyfin/Emby server that is being replaced available for sign-in,
 * so that its users do not lose access to Seerr.
 */
const keepAsLoginServer = (
  type: LoginServerType,
  server: JellyfinSettings
): void => {
  const settings = getSettings();

  settings.main.loginServers[getLoginServerKey(type)] = {
    enabled: true,
    ip: server.ip,
    port: server.port,
    useSsl: server.useSsl ?? false,
    urlBase: server.urlBase ?? '',
    externalHostname: server.externalHostname ?? '',
    forgotPasswordUrl: server.jellyfinForgotPasswordUrl ?? '',
  };
};

/**
 * Drops the media identifiers of the media server that is no longer primary.
 * They only mean something on the server they were scanned from, and leaving
 * them behind makes Seerr link to media on a server it no longer uses. The
 * availability of every item is picked up again by the next library scan.
 */
const clearMediaServerIds = async (
  previousType: MediaServerType
): Promise<void> => {
  const mediaRepository = getRepository(Media);

  const columns =
    previousType === MediaServerType.PLEX
      ? { ratingKey: null, ratingKey4k: null }
      : { jellyfinMediaId: null, jellyfinMediaId4k: null };

  await mediaRepository
    .createQueryBuilder()
    .update(Media)
    .set(columns)
    .execute();
};

mediaServerRoutes.post('/', async (req, res, next) => {
  const settings = getSettings();
  const result = primaryServerSchema.safeParse(req.body);

  if (!result.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const body = result.data;

  if (!req.user) {
    return next({ status: 401, message: ApiErrorCode.Unauthorized });
  }

  // Seerr talks to the media server with the credentials of the owner account,
  // so only they can point it at a different one
  if (req.user.id !== 1) {
    return next({
      status: 403,
      message: 'Only the primary administrator can change the media server.',
    });
  }

  const previousType = settings.main.mediaServerType;

  if (body.type === previousType) {
    return next({
      status: 400,
      message: `${getServerName(body.type)} is already the primary media server.`,
    });
  }

  const userRepository = getRepository(User);
  const owner = await userRepository.findOne({ where: { id: req.user.id } });

  if (!owner) {
    return next({ status: 500, message: 'Unable to find the owner account.' });
  }

  // The settings of the media server being replaced, which are overwritten
  // once the new one has been verified
  const previousJellyfin = { ...settings.jellyfin };

  try {
    if (body.type === MediaServerType.PLEX) {
      await switchToPlex(body, owner);
    } else {
      await switchToJellyfin(body.type, body, owner, getClientIp(req.ip));
    }
  } catch (e) {
    logger.error('Something went wrong changing the primary media server', {
      label: 'Settings',
      status: e.statusCode,
      errorMessage: e.errorCode ?? e.message,
    });

    return next({
      status: e.statusCode ?? 500,
      message: e.errorCode ?? ApiErrorCode.Unknown,
    });
  }

  if (body.keepForSignIn && isLoginServerType(previousType)) {
    keepAsLoginServer(previousType, previousJellyfin);
  }

  settings.main.mediaServerType = body.type;
  await settings.save();

  if (previousType !== MediaServerType.NOT_CONFIGURED) {
    await clearMediaServerIds(previousType);
  }

  // The scheduled library scans are specific to the media server type
  restartJobs();

  logger.info(
    `Primary media server changed from ${getServerName(
      previousType
    )} to ${getServerName(body.type)}`,
    { label: 'Settings', userId: req.user.id }
  );

  return res.status(200).json(settings.main);
});

export default mediaServerRoutes;
