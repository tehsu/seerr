import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import downloadTracker from '@server/lib/downloadtracker';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import {
  filterDownloadStatus,
  redactDownloadStatus,
  restrictDownloadingItem,
} from '@server/middleware/downloadStatus';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const downloadingItem: DownloadingItem = {
  mediaType: MediaType.MOVIE,
  externalId: 4,
  size: 1000,
  sizeLeft: 250,
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importBlocked',
  timeLeft: '00:00:00',
  estimatedCompletionTime: new Date('2026-09-30T12:00:00Z'),
  startedAt: new Date('2026-09-30T11:00:00Z'),
  title: 'Some.Movie.2026.1080p.WEBRip.x265-GROUP',
  downloadId: 'SABnzbd_nzo_abcdef',
  protocol: 'usenet',
  downloadClient: 'NZBGet',
  indexer: 'nzblife',
  quality: 'WEBRip-1080p',
  statusMessages: [
    {
      title: 'Some.Movie.2026.1080p.WEBRip.x265-GROUP.mkv',
      messages: ['Not an upgrade for existing movie file'],
    },
  ],
  errorMessage: 'Import failed',
  downloadRate: 1024,
};

const RESTRICTED_KEYS = [
  'downloadId',
  'episode',
  'estimatedCompletionTime',
  'externalId',
  'mediaType',
  'size',
  'sizeLeft',
  'startedAt',
  'status',
  'timeLeft',
  'trackedDownloadState',
  'trackedDownloadStatus',
];

describe('redactDownloadStatus', () => {
  it('keeps only progress, time left and status for restricted users', () => {
    const redacted = redactDownloadStatus(
      { mediaInfo: { downloadStatus: [downloadingItem] } },
      'restricted'
    ) as { mediaInfo: { downloadStatus: Record<string, unknown>[] } };

    const [item] = redacted.mediaInfo.downloadStatus;
    assert.deepStrictEqual(
      Object.keys(item)
        .filter((key) => item[key] !== undefined)
        .sort(),
      RESTRICTED_KEYS.filter((key) => key !== 'episode')
    );
    assert.strictEqual(item.sizeLeft, 250);
    assert.strictEqual(item.trackedDownloadState, 'importBlocked');
    assert.ok(!JSON.stringify(redacted).includes('GROUP'));
    assert.ok(!JSON.stringify(redacted).includes('nzblife'));
  });

  it('keeps season pack episodes grouped under an opaque download id', () => {
    const first = restrictDownloadingItem(downloadingItem);
    const second = restrictDownloadingItem({
      ...downloadingItem,
      episode: { seasonNumber: 1, episodeNumber: 2 },
    } as DownloadingItem);

    assert.notStrictEqual(first.downloadId, downloadingItem.downloadId);
    assert.strictEqual(first.downloadId, second.downloadId);
  });

  it('removes downloads entirely for users without the permission', () => {
    const redacted = redactDownloadStatus(
      {
        results: [
          {
            mediaInfo: {
              downloadStatus: [downloadingItem],
              downloadStatus4k: [downloadingItem],
            },
          },
        ],
      },
      'none'
    );

    assert.deepStrictEqual(redacted, {
      results: [{ mediaInfo: { downloadStatus: [], downloadStatus4k: [] } }],
    });
  });

  it('leaves the rest of the payload alone', () => {
    const body = {
      id: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      nested: [{ title: 'kept', downloadStatus: 'not a list' }],
    };

    assert.deepStrictEqual(redactDownloadStatus(body, 'none'), body);
  });
});

describe('filterDownloadStatus', () => {
  let app: Express;

  mock.method(downloadTracker, 'getMovieProgress', () => [downloadingItem]);

  before(() => {
    app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use(checkUser);
    app.use(filterDownloadStatus);
    app.use('/auth', authRoutes);
    app.get('/media/:id', async (req, res) => {
      const media = await getRepository(Media).findOneOrFail({
        where: { id: Number(req.params.id) },
      });
      res.status(200).json({ mediaInfo: media });
    });
  });

  setupTestDb();

  let mediaId: number;

  beforeEach(async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 4,
      })
    );
    mediaId = media.id;
  });

  async function loginAs(email: string, permissions?: number) {
    if (permissions !== undefined) {
      const userRepo = getRepository(User);
      const user = await userRepo.findOneOrFail({ where: { email } });
      user.permissions = permissions;
      await userRepo.save(user);
    }

    const settings = getSettings();
    const priorLocalLogin = settings.main.localLogin;
    settings.main.localLogin = true;

    try {
      const agent = request.agent(app);
      const res = await agent
        .post('/auth/local')
        .send({ email, password: 'test1234' });
      assert.strictEqual(res.status, 200);
      return agent;
    } finally {
      settings.main.localLogin = priorLocalLogin;
    }
  }

  it('shows admins everything', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get(`/media/${mediaId}`);

    assert.strictEqual(res.status, 200);
    const [item] = res.body.mediaInfo.downloadStatus;
    assert.strictEqual(item.title, downloadingItem.title);
    assert.strictEqual(item.indexer, downloadingItem.indexer);
    assert.strictEqual(item.downloadId, downloadingItem.downloadId);
  });

  it('shows users with View Downloads only the progress and status', async () => {
    const agent = await loginAs(
      'demo@seerr.dev',
      Permission.REQUEST | Permission.VIEW_DOWNLOADS
    );
    const res = await agent.get(`/media/${mediaId}`);

    assert.strictEqual(res.status, 200);
    const [item] = res.body.mediaInfo.downloadStatus;
    assert.deepStrictEqual(
      Object.keys(item).sort(),
      RESTRICTED_KEYS.filter((key) => key !== 'episode')
    );
    assert.strictEqual(item.sizeLeft, 250);
    assert.strictEqual(item.status, 'completed');
  });

  it('shows users without View Downloads no downloads at all', async () => {
    const agent = await loginAs('demo@seerr.dev', Permission.REQUEST);
    const res = await agent.get(`/media/${mediaId}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.mediaInfo.downloadStatus, []);
    assert.strictEqual(res.body.mediaInfo.tmdbId, 12345);
  });

  it('shows signed out requests no downloads', async () => {
    const res = await request(app).get(`/media/${mediaId}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.mediaInfo.downloadStatus, []);
  });
});
