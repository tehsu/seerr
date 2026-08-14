import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getRadarrForMedia, getSonarrForMedia } from '@server/lib/mediaService';

export { MediaServiceNotConfiguredError } from '@server/lib/mediaService';

/**
 * Removes a media item, along with its files, from the Radarr/Sonarr server
 * that manages it.
 *
 * Throws a MediaServiceNotConfiguredError if we are unable to determine which
 * server the item belongs to.
 */
const deleteMediaFile = async (media: Media, is4k = false): Promise<void> => {
  if (media.mediaType === MediaType.MOVIE) {
    const radarr = getRadarrForMedia(media, is4k);

    await radarr.removeMovie(media.tmdbId);
    return;
  }

  const sonarr = getSonarrForMedia(media, is4k);

  const tmdb = new TheMovieDb();
  const series = await tmdb.getTvShow({ tvId: media.tmdbId });
  const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;

  if (!tvdbId) {
    throw new Error('TVDB ID not found');
  }

  await sonarr.removeSeries(tvdbId);
};

export default deleteMediaFile;
