import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';

export class MediaServiceNotConfiguredError extends Error {
  public readonly arrName: string;

  constructor(arrName: string) {
    super(`No ${arrName} server configured to delete media files`);
    this.name = 'MediaServiceNotConfiguredError';
    this.arrName = arrName;
  }
}

/**
 * Removes a media item, along with its files, from the Radarr/Sonarr server
 * that manages it.
 *
 * Throws a MediaServiceNotConfiguredError if we are unable to determine which
 * server the item belongs to.
 */
const deleteMediaFile = async (media: Media, is4k = false): Promise<void> => {
  const settings = getSettings();
  const isMovie = media.mediaType === MediaType.MOVIE;
  const specificServiceId = is4k ? media.serviceId4k : media.serviceId;
  const hasSpecificServiceId =
    specificServiceId != null && specificServiceId >= 0;

  if (isMovie) {
    let serviceSettings = settings.radarr.find(
      (radarr) => radarr.isDefault && radarr.is4k === is4k
    );

    if (hasSpecificServiceId && serviceSettings?.id !== specificServiceId) {
      serviceSettings = settings.radarr.find(
        (radarr) => radarr.id === specificServiceId
      );
    }

    if (!serviceSettings) {
      throw new MediaServiceNotConfiguredError(`${is4k ? '4K ' : ''}Radarr`);
    }

    const radarr = new RadarrAPI({
      apiKey: serviceSettings.apiKey,
      url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
    });

    await radarr.removeMovie(media.tmdbId);
    return;
  }

  let serviceSettings = settings.sonarr.find(
    (sonarr) => sonarr.isDefault && sonarr.is4k === is4k
  );

  if (hasSpecificServiceId && serviceSettings?.id !== specificServiceId) {
    serviceSettings = settings.sonarr.find(
      (sonarr) => sonarr.id === specificServiceId
    );
  }

  if (!serviceSettings) {
    throw new MediaServiceNotConfiguredError(`${is4k ? '4K ' : ''}Sonarr`);
  }

  const sonarr = new SonarrAPI({
    apiKey: serviceSettings.apiKey,
    url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
  });

  const tmdb = new TheMovieDb();
  const series = await tmdb.getTvShow({ tvId: media.tmdbId });
  const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;

  if (!tvdbId) {
    throw new Error('TVDB ID not found');
  }

  await sonarr.removeSeries(tvdbId);
};

export default deleteMediaFile;
