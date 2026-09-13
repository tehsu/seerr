import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type { PlexDevice } from '@server/interfaces/api/plexInterfaces';
import * as jobSchedule from '@server/job/schedule';
import { Permission } from '@server/lib/permissions';
import Settings, { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import settingsRoutes from '.';

// Keep the tests from writing the settings file
mock.method(Settings.prototype, 'save', async () => undefined);

// Rescheduling the jobs would leave real timers behind
const restartJobsMock = mock.method(
  jobSchedule,
  'restartJobs',
  () => undefined
);

const defaultLoginResponse = {
  User: {
    Id: 'jf-admin-001',
    Name: 'jellyfinadmin',
    ServerId: 'jf-server-001',
    Policy: { IsAdministrator: true },
  },
  AccessToken: 'fake-access-token',
};

const loginMock = mock.method(JellyfinAPI.prototype, 'login', async () => ({
  ...defaultLoginResponse,
}));

const createApiTokenMock = mock.method(
  JellyfinAPI.prototype,
  'createApiToken',
  async () => 'fake-api-key'
);

mock.method(JellyfinAPI.prototype, 'getServerName', async () => 'My Jellyfin');

const defaultPlexAccount = {
  id: 4321,
  uuid: 'plex-uuid',
  email: 'admin@seerr.dev',
  joined_at: '2020-01-01',
  username: 'plexadmin',
  title: 'plexadmin',
  thumb: 'https://plex.tv/avatar.png',
  hasPassword: true,
  authToken: 'fake-plex-token',
  subscription: {
    active: true,
    status: 'Active',
    plan: 'lifetime',
    features: [],
  },
  roles: { roles: [] },
  entitlements: [],
};

const plexUserMock = mock.method(PlexTvAPI.prototype, 'getUser', async () => ({
  ...defaultPlexAccount,
}));

const plexServer: PlexDevice = {
  name: 'My Plex Server',
  product: 'Plex Media Server',
  productVersion: '1.0',
  platform: 'Linux',
  platformVersion: '1.0',
  device: 'PC',
  clientIdentifier: 'plex-machine-001',
  createdAt: new Date(),
  lastSeenAt: new Date(),
  provides: ['server'],
  owned: true,
  connection: [],
};

const plexDevicesMock = mock.method(
  PlexTvAPI.prototype,
  'getDevices',
  async () => [{ ...plexServer }]
);

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

const disabledLoginServer = {
  enabled: false,
  ip: '',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: '',
  forgotPasswordUrl: '',
};

/** Configure Plex as the primary media server */
function configurePlex() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.localLogin = true;
  settings.main.loginServers.jellyfin = { ...disabledLoginServer };
  settings.main.loginServers.emby = { ...disabledLoginServer };
  settings.plex = {
    name: 'My Plex Server',
    machineId: 'plex-machine-001',
    ip: 'plex.local',
    port: 32400,
    useSsl: false,
    libraries: [{ id: '1', name: 'Movies', enabled: true, type: 'movie' }],
  };
}

/** Configure Jellyfin as the primary media server */
function configureJellyfin() {
  const settings = getSettings();
  configurePlex();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin = {
    name: 'Old Jellyfin',
    ip: 'old-jellyfin.local',
    port: 8096,
    useSsl: false,
    urlBase: '',
    externalHostname: 'https://jellyfin.example.com',
    jellyfinForgotPasswordUrl: 'https://jellyfin.example.com/forgot',
    libraries: [{ id: '1', name: 'Movies', enabled: true, type: 'movie' }],
    serverId: 'old-server',
    apiKey: 'old-api-key',
  };
}

async function loginAs(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

/** Create a media item carrying identifiers from both media server types */
async function createMedia() {
  const mediaRepository = getRepository(Media);

  return mediaRepository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 4011,
      status: MediaStatus.AVAILABLE,
      ratingKey: 'plex-rating-key',
      jellyfinMediaId: 'jellyfin-media-id',
    })
  );
}

describe('POST /settings/mediaserver', () => {
  beforeEach(() => {
    restartJobsMock.mock.resetCalls();
    loginMock.mock.resetCalls();
    loginMock.mock.mockImplementation(async () => ({
      ...defaultLoginResponse,
    }));
    createApiTokenMock.mock.resetCalls();
    plexUserMock.mock.resetCalls();
    plexUserMock.mock.mockImplementation(async () => ({
      ...defaultPlexAccount,
    }));
    plexDevicesMock.mock.resetCalls();
    plexDevicesMock.mock.mockImplementation(async () => [{ ...plexServer }]);
    configurePlex();
  });

  it('points the primary media server at a Jellyfin server', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const media = await createMedia();

    const res = await agent.post('/settings/mediaserver').send({
      type: MediaServerType.JELLYFIN,
      hostname: 'jellyfin.local',
      port: 8097,
      useSsl: true,
      urlBase: '/jellyfin',
      username: 'jellyfinadmin',
      password: 'password',
    });

    assert.strictEqual(res.status, 200);

    const settings = getSettings();
    assert.strictEqual(settings.main.mediaServerType, MediaServerType.JELLYFIN);
    assert.strictEqual(settings.jellyfin.ip, 'jellyfin.local');
    assert.strictEqual(settings.jellyfin.port, 8097);
    assert.strictEqual(settings.jellyfin.useSsl, true);
    assert.strictEqual(settings.jellyfin.urlBase, '/jellyfin');
    assert.strictEqual(settings.jellyfin.apiKey, 'fake-api-key');
    assert.strictEqual(settings.jellyfin.name, 'My Jellyfin');
    assert.strictEqual(settings.jellyfin.serverId, 'jf-server-001');
    assert.deepStrictEqual(settings.jellyfin.libraries, []);

    // The owner can sign in with the account the server was verified with
    const owner = await getRepository(User).findOneOrFail({ where: { id: 1 } });
    assert.strictEqual(owner.userType, UserType.JELLYFIN);
    assert.strictEqual(owner.jellyfinUserId, 'jf-admin-001');
    assert.strictEqual(owner.jellyfinUsername, 'jellyfinadmin');

    // Plex identifiers do not mean anything on the new server
    const updatedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updatedMedia.ratingKey, null);
    assert.strictEqual(updatedMedia.jellyfinMediaId, 'jellyfin-media-id');

    assert.strictEqual(restartJobsMock.mock.callCount(), 1);
  });

  it('turns off the additional sign-in server that is promoted', async () => {
    const settings = getSettings();
    settings.main.loginServers.jellyfin = {
      enabled: true,
      ip: 'jellyfin.local',
      port: 8096,
      useSsl: false,
      urlBase: '',
      externalHostname: 'https://jellyfin.example.com',
      forgotPasswordUrl: 'https://jellyfin.example.com/forgot',
    };

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent.post('/settings/mediaserver').send({
      type: MediaServerType.JELLYFIN,
      hostname: 'jellyfin.local',
      port: 8096,
      username: 'jellyfinadmin',
      password: 'password',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(settings.main.loginServers.jellyfin.enabled, false);
    // The promoted server keeps the URLs its users already know
    assert.strictEqual(
      settings.jellyfin.externalHostname,
      'https://jellyfin.example.com'
    );
    assert.strictEqual(
      settings.jellyfin.jellyfinForgotPasswordUrl,
      'https://jellyfin.example.com/forgot'
    );
  });

  it('keeps the replaced Jellyfin server for sign-in when asked', async () => {
    configureJellyfin();
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const media = await createMedia();

    const res = await agent.post('/settings/mediaserver').send({
      type: MediaServerType.EMBY,
      hostname: 'emby.local',
      port: 8096,
      username: 'embyadmin',
      password: 'password',
      keepForSignIn: true,
    });

    assert.strictEqual(res.status, 200);

    const settings = getSettings();
    assert.strictEqual(settings.main.mediaServerType, MediaServerType.EMBY);
    assert.deepStrictEqual(settings.main.loginServers.jellyfin, {
      enabled: true,
      ip: 'old-jellyfin.local',
      port: 8096,
      useSsl: false,
      urlBase: '',
      externalHostname: 'https://jellyfin.example.com',
      forgotPasswordUrl: 'https://jellyfin.example.com/forgot',
    });

    const owner = await getRepository(User).findOneOrFail({ where: { id: 1 } });
    assert.strictEqual(owner.userType, UserType.EMBY);

    const updatedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updatedMedia.jellyfinMediaId, null);
    assert.strictEqual(updatedMedia.ratingKey, 'plex-rating-key');
  });

  it('returns 403 when the media server account is not an administrator', async () => {
    loginMock.mock.mockImplementation(async () => ({
      ...defaultLoginResponse,
      User: {
        ...defaultLoginResponse.User,
        Policy: { IsAdministrator: false },
      },
    }));

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent.post('/settings/mediaserver').send({
      type: MediaServerType.JELLYFIN,
      hostname: 'jellyfin.local',
      username: 'jellyfinuser',
      password: 'password',
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, ApiErrorCode.NotAdmin);
    assert.strictEqual(
      getSettings().main.mediaServerType,
      MediaServerType.PLEX
    );
    assert.strictEqual(restartJobsMock.mock.callCount(), 0);
  });

  it('returns 422 when the media server account belongs to another user', async () => {
    const userRepository = getRepository(User);
    const otherUser = await userRepository.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    otherUser.jellyfinUserId = 'jf-admin-001';
    await userRepository.save(otherUser);

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent.post('/settings/mediaserver').send({
      type: MediaServerType.JELLYFIN,
      hostname: 'jellyfin.local',
      username: 'jellyfinadmin',
      password: 'password',
    });

    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.message, ApiErrorCode.AccountAlreadyLinked);
    assert.strictEqual(
      getSettings().main.mediaServerType,
      MediaServerType.PLEX
    );
  });

  it('returns 400 when no hostname is given for a Jellyfin server', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent
      .post('/settings/mediaserver')
      .send({ type: MediaServerType.JELLYFIN, username: 'jellyfinadmin' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.message, ApiErrorCode.InvalidUrl);
    assert.strictEqual(loginMock.mock.callCount(), 0);
  });

  it('points the primary media server at Plex', async () => {
    configureJellyfin();
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const media = await createMedia();

    const res = await agent
      .post('/settings/mediaserver')
      .send({ type: MediaServerType.PLEX, authToken: 'fake-plex-token' });

    assert.strictEqual(res.status, 200);

    const settings = getSettings();
    assert.strictEqual(settings.main.mediaServerType, MediaServerType.PLEX);
    // The account still owns the configured server, so it is kept
    assert.strictEqual(settings.plex.ip, 'plex.local');
    assert.strictEqual(settings.plex.libraries.length, 1);

    const owner = await getRepository(User).findOneOrFail({ where: { id: 1 } });
    assert.strictEqual(owner.userType, UserType.PLEX);
    assert.strictEqual(owner.plexId, 4321);
    assert.strictEqual(owner.plexUsername, 'plexadmin');

    const updatedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updatedMedia.jellyfinMediaId, null);

    assert.strictEqual(restartJobsMock.mock.callCount(), 1);
  });

  it('clears the Plex server when the account no longer owns it', async () => {
    configureJellyfin();
    plexDevicesMock.mock.mockImplementation(async () => [
      { ...plexServer, clientIdentifier: 'another-machine' },
    ]);

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent
      .post('/settings/mediaserver')
      .send({ type: MediaServerType.PLEX, authToken: 'fake-plex-token' });

    assert.strictEqual(res.status, 200);

    const settings = getSettings();
    assert.strictEqual(settings.plex.ip, '');
    assert.deepStrictEqual(settings.plex.libraries, []);
  });

  it('returns 400 when the Plex account does not own a server', async () => {
    configureJellyfin();
    plexDevicesMock.mock.mockImplementation(async () => [
      { ...plexServer, owned: false },
    ]);

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent
      .post('/settings/mediaserver')
      .send({ type: MediaServerType.PLEX, authToken: 'fake-plex-token' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.message, ApiErrorCode.NoServersFound);
    assert.strictEqual(
      getSettings().main.mediaServerType,
      MediaServerType.JELLYFIN
    );
  });

  it('returns 400 when the requested media server is already primary', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent
      .post('/settings/mediaserver')
      .send({ type: MediaServerType.PLEX, authToken: 'fake-plex-token' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(plexUserMock.mock.callCount(), 0);
  });

  it('returns 403 for an administrator that is not the owner', async () => {
    const userRepository = getRepository(User);
    const otherAdmin = await userRepository.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    otherAdmin.permissions = Permission.ADMIN;
    await userRepository.save(otherAdmin);

    const { agent } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.post('/settings/mediaserver').send({
      type: MediaServerType.JELLYFIN,
      hostname: 'jellyfin.local',
      username: 'jellyfinadmin',
      password: 'password',
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(loginMock.mock.callCount(), 0);
    assert.strictEqual(
      getSettings().main.mediaServerType,
      MediaServerType.PLEX
    );
  });
});
