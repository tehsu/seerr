import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import type { User } from '@server/entity/User';
import type {
  LoginServerSettings,
  LoginServersSettings,
  MainSettings,
} from '@server/lib/settings';

export type LoginServerType = MediaServerType.JELLYFIN | MediaServerType.EMBY;

export interface LoginServer extends LoginServerSettings {
  type: LoginServerType;
}

export const isLoginServerType = (type: unknown): type is LoginServerType =>
  type === MediaServerType.JELLYFIN || type === MediaServerType.EMBY;

export const getLoginServerKey = (
  type: LoginServerType
): keyof LoginServersSettings =>
  type === MediaServerType.JELLYFIN ? 'jellyfin' : 'emby';

export const getLoginServerUserType = (type: LoginServerType): UserType =>
  type === MediaServerType.JELLYFIN ? UserType.JELLYFIN : UserType.EMBY;

/**
 * Returns the additional login server of the given media server type.
 *
 * Returns `undefined` when the server is disabled, has no hostname configured,
 * is the primary media server itself, or the primary media server has not been
 * configured yet (additional servers are only available after initial setup).
 */
export const getLoginServer = (
  main: MainSettings,
  type?: number
): LoginServer | undefined => {
  if (
    !isLoginServerType(type) ||
    type === main.mediaServerType ||
    main.mediaServerType === MediaServerType.NOT_CONFIGURED
  ) {
    return undefined;
  }

  const server = main.loginServers?.[getLoginServerKey(type)];

  if (!server?.enabled || !server.ip) {
    return undefined;
  }

  return { ...server, type };
};

/**
 * Returns the additional login server a user belongs to, based on the type of
 * their account. A user whose type matches the primary media server (or an
 * additional server that has since been disabled) belongs to the primary
 * media server instead, and `undefined` is returned.
 */
export const getUserLoginServer = (
  main: MainSettings,
  user: Pick<User, 'userType'>
): LoginServer | undefined => {
  const type =
    user.userType === UserType.JELLYFIN
      ? MediaServerType.JELLYFIN
      : user.userType === UserType.EMBY
        ? MediaServerType.EMBY
        : undefined;

  return getLoginServer(main, type);
};

export const getLoginServerHostname = (server: LoginServerSettings): string =>
  `${server.useSsl ? 'https' : 'http'}://${server.ip}:${server.port}${
    server.urlBase ?? ''
  }`;

/**
 * Whether the connection details of a login server differ between two
 * versions of its settings (used to decide if the connection should be
 * re-verified before saving).
 */
export const hasLoginServerConnectionChanged = (
  current: LoginServerSettings,
  incoming: LoginServerSettings
): boolean =>
  !current.enabled ||
  current.ip !== incoming.ip ||
  current.port !== incoming.port ||
  !!current.useSsl !== !!incoming.useSsl ||
  (current.urlBase ?? '') !== (incoming.urlBase ?? '');
