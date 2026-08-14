import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getRadarrForMedia, getSonarrForMedia } from '@server/lib/mediaService';
import logger from '@server/logger';

export class MediaNotInServiceError extends Error {
  constructor(arrName: string) {
    super(`Seerr does not know which ${arrName} item this media is`);
    this.name = 'MediaNotInServiceError';
  }
}

export interface ReleaseSearchTarget {
  /** Season the problem was reported against; 0 means the whole series. */
  season?: number;
  /** Episode the problem was reported against; 0 means the whole season. */
  episode?: number;
}

/**
 * Asks the Radarr/Sonarr server that manages a media item to go looking for a
 * new release of it.
 *
 * Nothing is deleted: the search is the same one the "Search" button in
 * Radarr/Sonarr runs, so the files already in the library are only replaced if
 * the search turns up a release the quality profile considers an upgrade. That
 * makes this safe to offer for a freshly reported issue, where a better release
 * may well fix the problem and nobody wants to be left with nothing if it does
 * not.
 *
 * Searching an entire series to chase down one bad episode is a lot of work for
 * the indexers, so the report is narrowed to a season or an episode whenever it
 * says which one is affected.
 *
 * Throws a MediaServiceNotConfiguredError if we cannot tell which server the
 * item belongs to, and a MediaNotInServiceError if we know the server but not
 * which item on it this is.
 */
const searchMediaRelease = async (
  media: Media,
  is4k = false,
  target: ReleaseSearchTarget = {}
): Promise<void> => {
  const externalServiceId = is4k
    ? media.externalServiceId4k
    : media.externalServiceId;
  const isMovie = media.mediaType === MediaType.MOVIE;

  if (externalServiceId == null) {
    throw new MediaNotInServiceError(
      `${is4k ? '4K ' : ''}${isMovie ? 'Radarr' : 'Sonarr'}`
    );
  }

  if (isMovie) {
    const radarr = getRadarrForMedia(media, is4k);
    await radarr.searchMovieReleases(externalServiceId);

    logger.info('Searching for a new release of a movie', {
      label: 'Media',
      mediaId: media.id,
      is4k,
    });
    return;
  }

  const sonarr = getSonarrForMedia(media, is4k);
  const season = target.season ?? 0;
  const episode = target.episode ?? 0;

  if (season > 0 && episode > 0) {
    // Sonarr searches episodes by its own episode ID, which we have to look up.
    const episodes = await sonarr.getEpisodes(externalServiceId);
    const match = episodes.find(
      (candidate) =>
        candidate.seasonNumber === season && candidate.episodeNumber === episode
    );

    // Falling back to the season below is better than giving up: the episode
    // being missing from Sonarr does not mean the rest of the season is.
    if (match) {
      await sonarr.searchEpisodeReleases([match.id]);

      logger.info('Searching for a new release of an episode', {
        label: 'Media',
        mediaId: media.id,
        is4k,
        season,
        episode,
      });
      return;
    }
  }

  if (season > 0) {
    await sonarr.searchSeasonReleases(externalServiceId, season);

    logger.info('Searching for new releases of a season', {
      label: 'Media',
      mediaId: media.id,
      is4k,
      season,
    });
    return;
  }

  await sonarr.searchSeriesReleases(externalServiceId);

  logger.info('Searching for new releases of a series', {
    label: 'Media',
    mediaId: media.id,
    is4k,
  });
};

export default searchMediaRelease;
