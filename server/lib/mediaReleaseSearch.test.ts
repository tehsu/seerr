import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import searchMediaRelease, {
  MediaNotInServiceError,
} from '@server/lib/mediaReleaseSearch';
import { MediaServiceNotConfiguredError } from '@server/lib/mediaService';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const searchMovieReleasesMock = mock.method(
  RadarrAPI.prototype,
  'searchMovieReleases',
  async () => undefined
).mock;

const searchSeriesReleasesMock = mock.method(
  SonarrAPI.prototype,
  'searchSeriesReleases',
  async () => undefined
).mock;

const searchSeasonReleasesMock = mock.method(
  SonarrAPI.prototype,
  'searchSeasonReleases',
  async () => undefined
).mock;

const searchEpisodeReleasesMock = mock.method(
  SonarrAPI.prototype,
  'searchEpisodeReleases',
  async () => undefined
).mock;

type SonarrEpisode = Awaited<ReturnType<SonarrAPI['getEpisodes']>>[number];

let episodes: SonarrEpisode[] = [];

const getEpisodesMock = mock.method(
  SonarrAPI.prototype,
  'getEpisodes',
  async () => episodes
).mock;

const dvrDefaults = {
  hostname: 'localhost',
  apiKey: 'test-api-key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'HD',
  activeDirectory: '/media',
  tags: [],
  syncEnabled: false,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
};

const radarrServer = (
  id: number,
  is4k: boolean,
  isDefault: boolean
): RadarrSettings => ({
  ...dvrDefaults,
  id,
  name: `Radarr ${id}`,
  port: 7878,
  is4k,
  isDefault,
  minimumAvailability: 'released',
});

const sonarrServer = (
  id: number,
  is4k: boolean,
  isDefault: boolean
): SonarrSettings => ({
  ...dvrDefaults,
  id,
  name: `Sonarr ${id}`,
  port: 8989,
  is4k,
  isDefault,
  seriesType: 'standard',
  animeSeriesType: 'standard',
  enableSeasonFolders: true,
  monitorNewItems: 'all',
});

const settings = getSettings();

beforeEach(() => {
  searchMovieReleasesMock.resetCalls();
  searchSeriesReleasesMock.resetCalls();
  searchSeasonReleasesMock.resetCalls();
  searchEpisodeReleasesMock.resetCalls();
  getEpisodesMock.resetCalls();

  episodes = [];
  settings.radarr = [radarrServer(0, false, true), radarrServer(1, true, true)];
  settings.sonarr = [sonarrServer(0, false, true), sonarrServer(1, true, true)];
});

const movie = (fields: Partial<Media> = {}) =>
  new Media({
    id: 1,
    mediaType: MediaType.MOVIE,
    tmdbId: 12345,
    serviceId: 0,
    externalServiceId: 42,
    ...fields,
  });

const series = (fields: Partial<Media> = {}) =>
  new Media({
    id: 2,
    mediaType: MediaType.TV,
    tmdbId: 54321,
    serviceId: 0,
    externalServiceId: 7,
    ...fields,
  });

const episode = (
  seasonNumber: number,
  episodeNumber: number,
  id: number
): SonarrEpisode => ({ seasonNumber, episodeNumber, id }) as SonarrEpisode;

describe('searchMediaRelease', () => {
  it('searches Radarr for a new release of a movie', async () => {
    await searchMediaRelease(movie());

    assert.deepStrictEqual(
      searchMovieReleasesMock.calls.map((call) => call.arguments),
      [[42]]
    );
  });

  it('searches the 4K server for the 4K version of a movie', async () => {
    await searchMediaRelease(
      movie({ serviceId4k: 1, externalServiceId4k: 99 }),
      true
    );

    assert.deepStrictEqual(
      searchMovieReleasesMock.calls.map((call) => call.arguments),
      [[99]]
    );
  });

  it('searches the whole series when no season was reported', async () => {
    await searchMediaRelease(series());

    assert.deepStrictEqual(
      searchSeriesReleasesMock.calls.map((call) => call.arguments),
      [[7]]
    );
    assert.strictEqual(searchSeasonReleasesMock.callCount(), 0);
    assert.strictEqual(searchEpisodeReleasesMock.callCount(), 0);
  });

  it('searches a single season when only a season was reported', async () => {
    await searchMediaRelease(series(), false, { season: 3 });

    assert.deepStrictEqual(
      searchSeasonReleasesMock.calls.map((call) => call.arguments),
      [[7, 3]]
    );
    assert.strictEqual(searchSeriesReleasesMock.callCount(), 0);
  });

  it('searches a single episode when one was reported', async () => {
    episodes = [episode(3, 1, 100), episode(3, 2, 101), episode(4, 2, 102)];

    await searchMediaRelease(series(), false, { season: 3, episode: 2 });

    assert.deepStrictEqual(
      searchEpisodeReleasesMock.calls.map((call) => call.arguments),
      [[[101]]]
    );
    assert.strictEqual(searchSeasonReleasesMock.callCount(), 0);
    assert.strictEqual(searchSeriesReleasesMock.callCount(), 0);
  });

  it('falls back to the season when Sonarr does not have the episode', async () => {
    episodes = [episode(3, 1, 100)];

    await searchMediaRelease(series(), false, { season: 3, episode: 2 });

    assert.strictEqual(searchEpisodeReleasesMock.callCount(), 0);
    assert.deepStrictEqual(
      searchSeasonReleasesMock.calls.map((call) => call.arguments),
      [[7, 3]]
    );
  });

  it('searches the whole series for an episode reported against all seasons', async () => {
    await searchMediaRelease(series(), false, { season: 0, episode: 2 });

    assert.deepStrictEqual(
      searchSeriesReleasesMock.calls.map((call) => call.arguments),
      [[7]]
    );
    assert.strictEqual(getEpisodesMock.callCount(), 0);
  });

  it('uses the server the media was sent to over the default one', async () => {
    settings.radarr = [
      radarrServer(0, false, true),
      radarrServer(5, false, false),
    ];

    const buildUrl = mock.method(RadarrAPI, 'buildUrl');

    await searchMediaRelease(movie({ serviceId: 5 }));

    assert.strictEqual(
      (buildUrl.mock.calls[0].arguments[0] as RadarrSettings).id,
      5
    );

    buildUrl.mock.restore();
  });

  it('throws when no Radarr server is configured', async () => {
    settings.radarr = [];

    await assert.rejects(
      searchMediaRelease(movie()),
      MediaServiceNotConfiguredError
    );
    assert.strictEqual(searchMovieReleasesMock.callCount(), 0);
  });

  it('throws when no Sonarr server is configured', async () => {
    settings.sonarr = [];

    await assert.rejects(
      searchMediaRelease(series()),
      MediaServiceNotConfiguredError
    );
    assert.strictEqual(searchSeriesReleasesMock.callCount(), 0);
  });

  it('throws when the media has no counterpart in Radarr/Sonarr', async () => {
    await assert.rejects(
      searchMediaRelease(movie({ externalServiceId: null })),
      MediaNotInServiceError
    );
    assert.strictEqual(searchMovieReleasesMock.callCount(), 0);
  });

  it('lets a failed search command through to the caller', async () => {
    searchMovieReleasesMock.mockImplementationOnce(async () => {
      throw new Error('Radarr is down');
    });

    await assert.rejects(searchMediaRelease(movie()), {
      message: 'Radarr is down',
    });
  });
});
