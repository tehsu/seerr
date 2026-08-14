import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { IssueStatus, IssueType } from '@server/constants/issue';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import * as mediaDeletion from '@server/lib/mediaDeletion';
import * as mediaReleaseSearch from '@server/lib/mediaReleaseSearch';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import issueRoutes from './issue';

const sendIssueNotificationMock = mock.method(
  IssueSubscriber.prototype as unknown as {
    sendIssueNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueNotification',
  async () => undefined
).mock;

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

// Talking to Radarr/Sonarr is covered by the media deletion tests, so the
// deletion itself is stubbed out here unless a test asks for the real thing.
const deleteMediaFile = mediaDeletion.default;
let deleteMediaFileImpl: typeof deleteMediaFile = async () => undefined;

const deleteMediaFileMock = mock.method(
  mediaDeletion,
  'default',
  (media: Media, is4k?: boolean) => deleteMediaFileImpl(media, is4k)
).mock;

// Which Radarr/Sonarr command a search turns into is covered by the release
// search tests, so it is stubbed out here unless a test asks for the real thing.
const searchMediaRelease = mediaReleaseSearch.default;
let searchMediaReleaseImpl: typeof searchMediaRelease = async () => undefined;

const searchMediaReleaseMock = mock.method(
  mediaReleaseSearch,
  'default',
  (
    media: Media,
    is4k?: boolean,
    target?: mediaReleaseSearch.ReleaseSearchTarget
  ) => searchMediaReleaseImpl(media, is4k, target)
).mock;

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
  app.use('/issue', issueRoutes);
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

beforeEach(() => {
  sendIssueNotificationMock.resetCalls();
  sendNotificationMock.resetCalls();
  deleteMediaFileMock.resetCalls();
  deleteMediaFileImpl = async () => undefined;
  searchMediaReleaseMock.resetCalls();
  searchMediaReleaseImpl = async () => undefined;
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedMedia(fields: Partial<Media> = {}) {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      ...fields,
    })
  );
}

async function seedIssue(media: Media, fields: Partial<Issue> = {}) {
  const createdBy = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  return getRepository(Issue).save(
    new Issue({
      issueType: IssueType.VIDEO,
      media,
      createdBy,
      deletionRequested: true,
      ...fields,
    })
  );
}

async function seedRequest(media: Media, is4k = false) {
  const requestedBy = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: media.mediaType,
      media,
      requestedBy,
      status: MediaRequestStatus.COMPLETED,
      is4k,
      seasons: [],
    })
  );
}

describe('POST /issue', () => {
  it('creates an issue on behalf of the supplied userId', async () => {
    const issueRepo = getRepository(Issue);
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Playback stutters near the end.',
      mediaId: media.id,
      problemSeason: 0,
      problemEpisode: 0,
      userId: friend.id,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.createdBy.email, 'friend@seerr.dev');
    assert.strictEqual(res.body.comments[0].user.email, 'friend@seerr.dev');

    const persisted = await issueRepo.findOneOrFail({
      where: { id: res.body.id },
    });

    assert.strictEqual(persisted.createdBy.id, friend.id);
    assert.strictEqual(persisted.comments[0].user.id, friend.id);
  });

  it('defaults to the authenticated user when userId is omitted', async () => {
    const media = await seedMedia();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.AUDIO,
      message: 'Audio is out of sync.',
      mediaId: media.id,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.createdBy.email, 'admin@seerr.dev');
    assert.strictEqual(res.body.comments[0].user.email, 'admin@seerr.dev');
  });

  it('allows creators to supply their own userId', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.SUBTITLES,
      message: 'Subtitles are missing.',
      mediaId: media.id,
      userId: friend.id,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.createdBy.email, 'friend@seerr.dev');
    assert.strictEqual(res.body.comments[0].user.email, 'friend@seerr.dev');
  });

  it('prevents non-managers from supplying another userId', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.OTHER,
      message: 'Something else is wrong.',
      mediaId: media.id,
      userId: admin.id,
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(
      res.body.message,
      'You do not have permission to create an issue on behalf of another user.'
    );
  });

  it('returns 404 when the supplied userId does not exist', async () => {
    const media = await seedMedia();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.OTHER,
      message: 'Something else is wrong.',
      mediaId: media.id,
      userId: 999999,
    });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.message, 'Issue user not found');
  });

  it('stores a requested deletion', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Wrong movie entirely, please remove it.',
      mediaId: media.id,
      deletionRequested: true,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.deletionRequested, true);

    const persisted = await getRepository(Issue).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(persisted.deletionRequested, true);
  });

  it('does not request deletion by default', async () => {
    const media = await seedMedia();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Audio is out of sync.',
      mediaId: media.id,
    });

    assert.strictEqual(res.status, 201);

    const persisted = await getRepository(Issue).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(persisted.deletionRequested, false);
  });
});

describe('POST /issue/:issueId/media/search', () => {
  it('lets the reporter search against their own issue', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const issue = await seedIssue(media);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 1);
  });

  it("prevents reporters from searching against someone else's issue", async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const issue = await seedIssue(media, { createdBy: admin });
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 0);
  });

  it("lets a manager search against someone else's issue", async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const issue = await seedIssue(media, { createdBy: admin });
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.MANAGE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 1);
  });

  it('prevents users who cannot report issues from searching', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const issue = await seedIssue(media);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.REQUEST;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 0);
  });

  it('searches for a new release and leaves the issue open', async () => {
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 1);

    const [searchedMedia, is4k] = searchMediaReleaseMock.calls[0].arguments;
    assert.strictEqual(searchedMedia.id, media.id);
    assert.strictEqual(is4k, false);

    // Nothing was deleted, so the media is untouched and the issue stays open
    // until someone confirms the new release actually fixed it.
    const persistedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedMedia.serviceId, 0);
    assert.strictEqual(persistedMedia.externalServiceId, 4);
    assert.strictEqual(persistedMedia.status, MediaStatus.AVAILABLE);

    const persistedIssue = await getRepository(Issue).findOneOrFail({
      where: { id: issue.id },
    });
    assert.strictEqual(persistedIssue.status, IssueStatus.OPEN);
  });

  it('narrows the search to the reported season and episode', async () => {
    const media = await seedMedia({
      mediaType: MediaType.TV,
      serviceId: 0,
      externalServiceId: 4,
    });
    const issue = await seedIssue(media, {
      problemSeason: 2,
      problemEpisode: 5,
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(searchMediaReleaseMock.calls[0].arguments[2], {
      season: 2,
      episode: 5,
    });
  });

  it('searches for both versions of the media', async () => {
    const media = await seedMedia({
      serviceId: 0,
      serviceId4k: 1,
      externalServiceId: 4,
      externalServiceId4k: 5,
      status4k: MediaStatus.AVAILABLE,
    });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(
      searchMediaReleaseMock.calls.map((call) => call.arguments[1]),
      [false, true]
    );
  });

  it('refuses media no Radarr/Sonarr server manages', async () => {
    const media = await seedMedia();
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 0);
  });

  it('refuses blocklisted media', async () => {
    const media = await seedMedia({
      serviceId: 0,
      externalServiceId: 4,
      status: MediaStatus.BLOCKLISTED,
    });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(searchMediaReleaseMock.callCount(), 0);
  });

  it('reports a Radarr/Sonarr server that is not configured', async () => {
    searchMediaReleaseImpl = searchMediaRelease;
    const media = await seedMedia({ serviceId: 1, externalServiceId: 4 });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /Radarr/);
  });

  it('reports a failed search', async () => {
    searchMediaReleaseImpl = async () => {
      throw new Error('Radarr is down');
    };
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post(`/issue/${issue.id}/media/search`);

    assert.strictEqual(res.status, 500);
  });

  it('returns 404 for a non-existent issue', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/issue/99999999/media/search');

    assert.strictEqual(res.status, 404);
  });
});

describe('DELETE /issue/:issueId/media', () => {
  it('prevents users without the required permissions from deleting media', async () => {
    const userRepo = getRepository(User);
    const media = await seedMedia();
    const issue = await seedIssue(media);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    friend.permissions = Permission.CREATE_ISSUES;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 403);
    assert.notStrictEqual(
      await getRepository(Media).findOne({ where: { id: media.id } }),
      null
    );
  });

  it('removes media no Radarr/Sonarr server manages, and the issue along with it', async () => {
    const media = await seedMedia();
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(deleteMediaFileMock.callCount(), 0);
    assert.strictEqual(
      await getRepository(Media).findOne({ where: { id: media.id } }),
      null
    );
    assert.strictEqual(
      await getRepository(Issue).findOne({ where: { id: issue.id } }),
      null
    );
  });

  it('deletes the files, searches for the media again and resolves the issue', async () => {
    const media = await seedMedia({ serviceId: 0, externalServiceId: 4 });
    const issue = await seedIssue(media);
    const mediaRequest = await seedRequest(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(deleteMediaFileMock.callCount(), 1);

    const persistedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedMedia.serviceId, null);
    assert.strictEqual(persistedMedia.externalServiceId, null);
    assert.strictEqual(persistedMedia.status, MediaStatus.PROCESSING);

    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.APPROVED);

    const persistedIssue = await getRepository(Issue).findOneOrFail({
      where: { id: issue.id },
    });
    assert.strictEqual(persistedIssue.status, IssueStatus.RESOLVED);
    assert.strictEqual(persistedIssue.modifiedBy?.email, 'admin@seerr.dev');
  });

  it('deletes both versions of the media and searches for each of them', async () => {
    const media = await seedMedia({
      serviceId: 0,
      serviceId4k: 1,
      status4k: MediaStatus.AVAILABLE,
    });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(
      deleteMediaFileMock.calls.map((call) => call.arguments[1]),
      [false, true]
    );

    const requests = await getRepository(MediaRequest).find({
      where: { media: { id: media.id } },
    });
    assert.deepStrictEqual(requests.map((request) => request.is4k).sort(), [
      false,
      true,
    ]);
    requests.forEach((request) => {
      assert.strictEqual(request.status, MediaRequestStatus.APPROVED);
    });
  });

  it('does not search again for blocklisted media', async () => {
    const media = await seedMedia({
      serviceId: 0,
      status: MediaStatus.BLOCKLISTED,
      status4k: MediaStatus.BLOCKLISTED,
    });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(deleteMediaFileMock.callCount(), 1);

    const persistedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedMedia.serviceId, null);
    assert.strictEqual(persistedMedia.status, MediaStatus.BLOCKLISTED);
    assert.strictEqual(
      await getRepository(MediaRequest).count({
        where: { media: { id: media.id } },
      }),
      0
    );
  });

  it('keeps the media when its Radarr/Sonarr server is not configured', async () => {
    deleteMediaFileImpl = deleteMediaFile;
    const media = await seedMedia({ serviceId: 1 });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 409);
    assert.notStrictEqual(
      await getRepository(Media).findOne({ where: { id: media.id } }),
      null
    );
    const persistedIssue = await getRepository(Issue).findOneOrFail({
      where: { id: issue.id },
    });
    assert.strictEqual(persistedIssue.status, IssueStatus.OPEN);
  });

  it('returns 404 for a non-existent issue', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/issue/99999999/media');

    assert.strictEqual(res.status, 404);
  });
});
