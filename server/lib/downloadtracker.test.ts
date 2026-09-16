import type { QueueItem } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import downloadTracker from '@server/lib/downloadtracker';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

function configureRadarr(overrides: Partial<RadarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
  settings.sonarr = [];
}

function configureSonarr(overrides: Partial<SonarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
  settings.radarr = [];
}

function fakeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    downloadId: 'ABC123',
    title: 'Test.Movie.2024.1080p.WEB-DL-GROUP',
    size: 1000,
    sizeleft: 400,
    timeleft: '00:05:00',
    estimatedCompletionTime: '2026-01-01T00:05:00Z',
    added: '2026-01-01T00:00:00Z',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    protocol: 'torrent',
    downloadClient: 'qBittorrent',
    indexer: 'Some Indexer',
    quality: { quality: { id: 7, name: 'WEBDL-1080p' } },
    ...overrides,
  };
}

/** Stands in for a Radarr queue, which appends the movie it belongs to. */
function stubRadarrQueue(
  items: (Partial<QueueItem> & { movieId?: number })[]
): void {
  mock.method(
    RadarrAPI.prototype,
    'refreshMonitoredDownloads',
    async () => undefined
  );
  mock.method(RadarrAPI.prototype, 'getQueue', async () =>
    items.map(({ movieId = 11, ...item }) => ({
      ...fakeQueueItem(item),
      movieId,
    }))
  );
}

/** Stands in for a Sonarr queue, which appends the series and episode. */
function stubSonarrQueue(
  items: (Partial<QueueItem> & {
    seriesId?: number;
    episodeId?: number;
    seasonNumber?: number;
    episodeNumber?: number;
  })[]
): void {
  mock.method(
    SonarrAPI.prototype,
    'refreshMonitoredDownloads',
    async () => undefined
  );
  mock.method(SonarrAPI.prototype, 'getQueue', async () =>
    items.map(
      ({
        seriesId = 22,
        episodeId = 1,
        seasonNumber = 1,
        episodeNumber = 1,
        ...item
      }) => ({
        ...fakeQueueItem(item),
        seriesId,
        episodeId,
        episode: {
          id: episodeId,
          seasonNumber,
          episodeNumber,
          absoluteEpisodeNumber: episodeNumber,
        },
      })
    )
  );
}

describe('DownloadTracker', () => {
  beforeEach(async () => {
    await downloadTracker.resetDownloadTracker();
  });

  afterEach(() => mock.restoreAll());

  it('carries the Radarr queue detail through to the tracked item', async () => {
    configureRadarr();
    stubRadarrQueue([{ movieId: 11 }]);

    await downloadTracker.updateDownloads();

    const [item] = downloadTracker.getMovieProgress(0, 11);

    assert.equal(item.mediaType, MediaType.MOVIE);
    assert.equal(item.externalId, 11);
    assert.equal(item.size, 1000);
    assert.equal(item.sizeLeft, 400);
    assert.equal(item.status, 'downloading');
    assert.equal(item.trackedDownloadStatus, 'ok');
    assert.equal(item.trackedDownloadState, 'downloading');
    assert.equal(item.protocol, 'torrent');
    assert.equal(item.downloadClient, 'qBittorrent');
    assert.equal(item.indexer, 'Some Indexer');
    assert.equal(item.quality, 'WEBDL-1080p');
    assert.deepEqual(item.startedAt, new Date('2026-01-01T00:00:00Z'));
    assert.deepEqual(
      item.estimatedCompletionTime,
      new Date('2026-01-01T00:05:00Z')
    );
  });

  it('carries the Sonarr queue detail, including the episode, through', async () => {
    configureSonarr();
    stubSonarrQueue([{ seriesId: 22, seasonNumber: 2, episodeNumber: 5 }]);

    await downloadTracker.updateDownloads();

    const [item] = downloadTracker.getSeriesProgress(0, 22);

    assert.equal(item.mediaType, MediaType.TV);
    assert.equal(item.externalId, 22);
    assert.equal(item.episode?.seasonNumber, 2);
    assert.equal(item.episode?.episodeNumber, 5);
    assert.equal(item.downloadClient, 'qBittorrent');
    assert.equal(item.quality, 'WEBDL-1080p');
  });

  it('passes on the messages behind a stalled or blocked download', async () => {
    configureRadarr();
    stubRadarrQueue([
      {
        status: 'warning',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'importBlocked',
        errorMessage: 'The download is stalled with no connections',
        statusMessages: [
          { title: 'Test.Movie', messages: ['Not an upgrade for existing'] },
        ],
      },
    ]);

    await downloadTracker.updateDownloads();

    const [item] = downloadTracker.getMovieProgress(0, 11);

    assert.equal(item.trackedDownloadStatus, 'warning');
    assert.equal(item.trackedDownloadState, 'importBlocked');
    assert.equal(
      item.errorMessage,
      'The download is stalled with no connections'
    );
    assert.deepEqual(item.statusMessages, [
      { title: 'Test.Movie', messages: ['Not an upgrade for existing'] },
    ]);
  });

  it('leaves optional timestamps unset when the queue omits them', async () => {
    configureRadarr();
    stubRadarrQueue([
      {
        estimatedCompletionTime: undefined,
        added: undefined,
      } as Partial<QueueItem>,
    ]);

    await downloadTracker.updateDownloads();

    const [item] = downloadTracker.getMovieProgress(0, 11);

    assert.equal(item.estimatedCompletionTime, undefined);
    assert.equal(item.startedAt, undefined);
  });

  it('reports no rate on the first poll of a download', async () => {
    configureRadarr();
    stubRadarrQueue([{ sizeleft: 400 }]);

    await downloadTracker.updateDownloads();

    assert.equal(
      downloadTracker.getMovieProgress(0, 11)[0].downloadRate,
      undefined
    );
  });

  it('measures the rate from how far the download moved between polls', async () => {
    configureRadarr();
    const clock = mock.timers;
    clock.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

    try {
      stubRadarrQueue([{ sizeleft: 1000 }]);
      await downloadTracker.updateDownloads();

      clock.tick(10_000);
      mock.restoreAll();
      stubRadarrQueue([{ sizeleft: 400 }]);
      await downloadTracker.updateDownloads();

      // 600 bytes over ten seconds.
      assert.equal(downloadTracker.getMovieProgress(0, 11)[0].downloadRate, 60);
    } finally {
      clock.reset();
    }
  });

  it('reports a stalled download as zero rather than dropping the rate', async () => {
    configureRadarr();
    const clock = mock.timers;
    clock.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

    try {
      stubRadarrQueue([{ sizeleft: 400 }]);
      await downloadTracker.updateDownloads();

      clock.tick(10_000);
      mock.restoreAll();
      stubRadarrQueue([{ sizeleft: 400 }]);
      await downloadTracker.updateDownloads();

      assert.equal(downloadTracker.getMovieProgress(0, 11)[0].downloadRate, 0);
    } finally {
      clock.reset();
    }
  });

  it('skips the rate when the release was swapped for a larger one', async () => {
    configureRadarr();
    const clock = mock.timers;
    clock.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

    try {
      stubRadarrQueue([{ sizeleft: 400 }]);
      await downloadTracker.updateDownloads();

      clock.tick(10_000);
      mock.restoreAll();
      stubRadarrQueue([{ sizeleft: 900 }]);
      await downloadTracker.updateDownloads();

      assert.equal(
        downloadTracker.getMovieProgress(0, 11)[0].downloadRate,
        undefined
      );
    } finally {
      clock.reset();
    }
  });

  it('measures each episode of a season pack against its own record', async () => {
    configureSonarr();
    const clock = mock.timers;
    clock.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

    try {
      stubSonarrQueue([
        { id: 1, episodeId: 1, episodeNumber: 1, sizeleft: 1000 },
        { id: 2, episodeId: 2, episodeNumber: 2, sizeleft: 1000 },
      ]);
      await downloadTracker.updateDownloads();

      clock.tick(10_000);
      mock.restoreAll();
      stubSonarrQueue([
        { id: 1, episodeId: 1, episodeNumber: 1, sizeleft: 500 },
        { id: 2, episodeId: 2, episodeNumber: 2, sizeleft: 800 },
      ]);
      await downloadTracker.updateDownloads();

      const items = downloadTracker.getSeriesProgress(0, 22);

      assert.equal(items[0].downloadRate, 50);
      assert.equal(items[1].downloadRate, 20);
    } finally {
      clock.reset();
    }
  });

  it('drops the samples of downloads that left the queue', async () => {
    configureRadarr();
    const clock = mock.timers;
    clock.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });

    try {
      stubRadarrQueue([{ sizeleft: 1000 }]);
      await downloadTracker.updateDownloads();

      // The download finishes and leaves the queue entirely...
      clock.tick(10_000);
      mock.restoreAll();
      stubRadarrQueue([]);
      await downloadTracker.updateDownloads();

      // ...so a later grab of the same release starts measuring afresh.
      clock.tick(10_000);
      mock.restoreAll();
      stubRadarrQueue([{ sizeleft: 400 }]);
      await downloadTracker.updateDownloads();

      assert.equal(
        downloadTracker.getMovieProgress(0, 11)[0].downloadRate,
        undefined
      );
    } finally {
      clock.reset();
    }
  });

  it('shares one server’s queue with the servers that mirror it', async () => {
    configureRadarr([{}, { is4k: true }]);
    stubRadarrQueue([{ movieId: 11 }]);

    await downloadTracker.updateDownloads();

    assert.equal(downloadTracker.getMovieProgress(1, 11).length, 1);
  });

  it('keeps the last known queue when a server cannot be reached', async () => {
    configureRadarr();
    stubRadarrQueue([{ movieId: 11 }]);
    await downloadTracker.updateDownloads();

    mock.restoreAll();
    mock.method(
      RadarrAPI.prototype,
      'refreshMonitoredDownloads',
      async () => undefined
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () => {
      throw new Error('unreachable');
    });

    await assert.doesNotReject(() => downloadTracker.updateDownloads());
    assert.equal(downloadTracker.getMovieProgress(0, 11).length, 1);
  });

  it('forgets everything it tracked when it is reset', async () => {
    configureRadarr();
    stubRadarrQueue([{ movieId: 11 }]);
    await downloadTracker.updateDownloads();

    await downloadTracker.resetDownloadTracker();

    assert.deepEqual(downloadTracker.getMovieProgress(0, 11), []);
  });
});
