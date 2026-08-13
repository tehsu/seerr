import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
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

async function seedIssue(media: Media) {
  const createdBy = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  return getRepository(Issue).save(
    new Issue({
      issueType: IssueType.VIDEO,
      media,
      createdBy,
      deletionRequested: true,
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

  it('removes the media, and the issue along with it', async () => {
    const media = await seedMedia();
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(
      await getRepository(Media).findOne({ where: { id: media.id } }),
      null
    );
    assert.strictEqual(
      await getRepository(Issue).findOne({ where: { id: issue.id } }),
      null
    );
  });

  it('keeps the media when its Radarr/Sonarr server is not configured', async () => {
    const media = await seedMedia({ serviceId: 1 });
    const issue = await seedIssue(media);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/issue/${issue.id}/media`);

    assert.strictEqual(res.status, 409);
    assert.notStrictEqual(
      await getRepository(Media).findOne({ where: { id: media.id } }),
      null
    );
  });

  it('returns 404 for a non-existent issue', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/issue/99999999/media');

    assert.strictEqual(res.status, 404);
  });
});
