import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import type { AddSeriesOptions } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

function addSeriesOptions(
  overrides: Partial<AddSeriesOptions> = {}
): AddSeriesOptions {
  return {
    tvdbid: 1234,
    title: 'Test Series',
    profileId: 1,
    seasons: [],
    seasonFolder: true,
    rootFolderPath: '/tv',
    seriesType: 'standard',
    monitored: true,
    ...overrides,
  };
}

describe('SonarrAPI removeSeries', () => {
  afterEach(() => mock.restoreAll());

  it('removes the series when it exists in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeSeries(1234);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/series/9');
  });

  it('does nothing when the series is not in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 0, title: 'Breaking Bad' }],
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tvdbId is unknown to the lookup', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(() => sonarr.removeSeries(1234), /Series not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the series was already removed in Sonarr', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
  });

  it('rethrows errors other than 404', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => sonarr.removeSeries(1234));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(
      () => sonarr.removeSeries(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('SonarrAPI getSeriesByTvdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => sonarr.getSeriesByTvdbId(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Series not found" when the lookup returns no results', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => sonarr.getSeriesByTvdbId(1234), {
      message: 'Series not found',
    });
  });
});

describe('SonarrAPI addSeries individually requested episodes', () => {
  afterEach(() => mock.restoreAll());

  it('monitors and searches only the matched episodes on a brand-new series', async () => {
    const sonarr = buildSonarr();
    const axios = getAxios(sonarr);

    mock.method(axios, 'get', async (url: string) => {
      if (url === '/series/lookup') {
        return {
          data: [
            {
              seasons: [
                { seasonNumber: 1, monitored: false },
                { seasonNumber: 2, monitored: false },
              ],
            },
          ],
        };
      }
      if (url === '/episode') {
        return {
          data: [
            { id: 501, seasonNumber: 2, episodeNumber: 5 },
            { id: 502, seasonNumber: 2, episodeNumber: 6 },
          ],
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = mock.method(axios, 'post', async (url: string) => {
      if (url === '/series') {
        return { data: { id: 99, seasons: [] } };
      }
      return { data: {} };
    });
    const put = mock.method(axios, 'put', async () => ({ data: {} }));

    await sonarr.addSeries(
      addSeriesOptions({
        episodes: [{ seasonNumber: 2, episodeNumbers: [5] }],
        searchNow: true,
      })
    );

    const monitorCall = put.mock.calls.find(
      (c) => c.arguments[0] === '/episode/monitor'
    );
    assert.ok(monitorCall, 'expected a call to /episode/monitor');
    assert.deepStrictEqual(monitorCall?.arguments[1], {
      episodeIds: [501],
      monitored: true,
    });

    const searchCall = post.mock.calls.find(
      (c) => c.arguments[0] === '/command'
    );
    assert.ok(searchCall, 'expected a call to /command');
    assert.deepStrictEqual(searchCall?.arguments[1], {
      name: 'EpisodeSearch',
      episodeIds: [501],
    });
  });

  it('monitors and searches the matched episodes on a series already in Sonarr', async () => {
    const sonarr = buildSonarr();
    const axios = getAxios(sonarr);

    mock.method(axios, 'get', async (url: string) => {
      if (url === '/series/lookup') {
        return {
          data: [
            {
              id: 42,
              tags: [],
              seasons: [{ seasonNumber: 2, monitored: true }],
            },
          ],
        };
      }
      if (url === '/episode') {
        return {
          data: [
            { id: 700, seasonNumber: 3, episodeNumber: 1, monitored: false },
          ],
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const put = mock.method(axios, 'put', async (url: string) => {
      if (url === '/series') {
        return {
          data: { id: 42, seasons: [{ seasonNumber: 2, monitored: true }] },
        };
      }
      return { data: {} };
    });
    const post = mock.method(axios, 'post', async () => ({ data: {} }));

    await sonarr.addSeries(
      addSeriesOptions({
        seasons: [2],
        episodes: [{ seasonNumber: 3, episodeNumbers: [1] }],
        searchNow: false,
      })
    );

    const monitorCall = put.mock.calls.find(
      (c) => c.arguments[0] === '/episode/monitor'
    );
    assert.ok(monitorCall, 'expected a call to /episode/monitor');
    assert.deepStrictEqual(monitorCall?.arguments[1], {
      episodeIds: [700],
      monitored: true,
    });

    // searchNow is false, so no EpisodeSearch command should have run.
    assert.strictEqual(
      post.mock.calls.some((c) => c.arguments[0] === '/command'),
      false
    );
  });

  it('does not fail the add when none of the requested episodes are known to Sonarr yet', async () => {
    const sonarr = buildSonarr();
    const axios = getAxios(sonarr);

    mock.method(axios, 'get', async (url: string) => {
      if (url === '/series/lookup') {
        return { data: [{ seasons: [{ seasonNumber: 1, monitored: false }] }] };
      }
      if (url === '/episode') {
        return { data: [] };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mock.method(axios, 'post', async (url: string) =>
      url === '/series' ? { data: { id: 7, seasons: [] } } : { data: {} }
    );
    const put = mock.method(axios, 'put', async () => ({ data: {} }));

    await assert.doesNotReject(() =>
      sonarr.addSeries(
        addSeriesOptions({
          episodes: [{ seasonNumber: 1, episodeNumbers: [1] }],
          searchNow: true,
        })
      )
    );

    assert.strictEqual(
      put.mock.calls.some((c) => c.arguments[0] === '/episode/monitor'),
      false
    );
  });
});
