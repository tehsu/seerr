import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';

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

// Creating an issue notifies admins, which means fetching metadata from TMDB.
// That is not what these tests are exercising.
mock.method(IssueSubscriber.prototype, 'afterInsert', () => undefined);

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

async function grantPermissions(email: string, permissions: number) {
  const userRepository = getRepository(User);
  const user = await userRepository.findOneOrFail({ where: { email } });
  user.permissions = permissions;
  await userRepository.save(user);
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
  const issueRepository = getRepository(Issue);
  const user = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  return issueRepository.save(
    new Issue({
      issueType: IssueType.VIDEO,
      media,
      createdBy: user,
      deletionRequested: true,
    })
  );
}

describe('POST /issue', () => {
  it('stores a requested deletion', async () => {
    const media = await seedMedia();
    await grantPermissions('friend@seerr.dev', Permission.CREATE_ISSUES);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Wrong movie entirely, please remove it',
      mediaId: media.id,
      deletionRequested: true,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.deletionRequested, true);

    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(issue.deletionRequested, true);
  });

  it('does not request deletion by default', async () => {
    const media = await seedMedia();
    await grantPermissions('friend@seerr.dev', Permission.CREATE_ISSUES);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/issue').send({
      issueType: IssueType.VIDEO,
      message: 'Audio is out of sync',
      mediaId: media.id,
    });

    assert.strictEqual(res.status, 200);

    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(issue.deletionRequested, false);
  });
});

describe('DELETE /issue/:issueId/media', () => {
  it('prevents users without the required permissions from deleting media', async () => {
    const media = await seedMedia();
    const issue = await seedIssue(media);
    await grantPermissions('friend@seerr.dev', Permission.CREATE_ISSUES);

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

    assert.strictEqual(res.status, 400);
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
