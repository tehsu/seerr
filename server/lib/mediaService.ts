import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type Media from '@server/entity/Media';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

export class MediaServiceNotConfiguredError extends Error {
  public readonly arrName: string;

  constructor(arrName: string) {
    super(`No ${arrName} server is configured for this media`);
    this.name = 'MediaServiceNotConfiguredError';
    this.arrName = arrName;
  }
}

/**
 * Picks the server a media item belongs to out of the configured ones.
 *
 * Media records the server it was sent to, but that server may since have been
 * removed from the settings, so the default for the requested version is used
 * as a fallback.
 */
const findServiceSettings = <T extends DVRSettings>(
  services: T[],
  specificServiceId: number | null | undefined,
  is4k: boolean
): T | undefined => {
  const serviceSettings = services.find(
    (service) => service.isDefault && service.is4k === is4k
  );

  if (
    specificServiceId != null &&
    specificServiceId >= 0 &&
    serviceSettings?.id !== specificServiceId
  ) {
    return services.find((service) => service.id === specificServiceId);
  }

  return serviceSettings;
};

/**
 * Builds a client for the Radarr server that manages a movie.
 *
 * Throws a MediaServiceNotConfiguredError if we are unable to determine which
 * server the item belongs to.
 */
export const getRadarrForMedia = (media: Media, is4k = false): RadarrAPI => {
  const settings = getSettings();
  const serviceSettings = findServiceSettings(
    settings.radarr,
    is4k ? media.serviceId4k : media.serviceId,
    is4k
  );

  if (!serviceSettings) {
    throw new MediaServiceNotConfiguredError(`${is4k ? '4K ' : ''}Radarr`);
  }

  return new RadarrAPI({
    apiKey: serviceSettings.apiKey,
    url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
  });
};

/**
 * Builds a client for the Sonarr server that manages a series.
 *
 * Throws a MediaServiceNotConfiguredError if we are unable to determine which
 * server the item belongs to.
 */
export const getSonarrForMedia = (media: Media, is4k = false): SonarrAPI => {
  const settings = getSettings();
  const serviceSettings = findServiceSettings(
    settings.sonarr,
    is4k ? media.serviceId4k : media.serviceId,
    is4k
  );

  if (!serviceSettings) {
    throw new MediaServiceNotConfiguredError(`${is4k ? '4K ' : ''}Sonarr`);
  }

  return new SonarrAPI({
    apiKey: serviceSettings.apiKey,
    url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
  });
};
