import type { QueueItem, QueueStatusMessage } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}
export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  status: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  timeLeft: string;
  estimatedCompletionTime?: Date;
  startedAt?: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
  protocol?: string;
  downloadClient?: string;
  indexer?: string;
  quality?: string;
  statusMessages?: QueueStatusMessage[];
  errorMessage?: string;
  /** Bytes per second, averaged across the gap between the last two polls. */
  downloadRate?: number;
}

/** What a queue record looked like the last time it was polled. */
interface ProgressSample {
  sizeLeft: number;
  sampledAt: number;
}

/**
 * One release shows up once per episode when a season pack is grabbed, so the
 * queue record id is what keeps those rows apart between polls.
 */
const sampleKey = (item: Pick<QueueItem, 'downloadId' | 'id'>): string =>
  `${item.downloadId}:${item.id}`;

/**
 * Neither Radarr nor Sonarr reports a transfer rate, so it is measured here by
 * comparing each record against the same record on the previous poll.
 */
const measureRates = (
  previousSamples: Map<string, ProgressSample>,
  queueItems: QueueItem[],
  sampledAt: number
): { rates: Map<string, number>; samples: Map<string, ProgressSample> } => {
  const rates = new Map<string, number>();
  // Built from scratch each poll so records that left the queue drop out with
  // it rather than accumulating forever.
  const samples = new Map<string, ProgressSample>();

  for (const item of queueItems) {
    const key = sampleKey(item);
    samples.set(key, { sizeLeft: item.sizeleft, sampledAt });

    const previous = previousSamples.get(key);

    if (!previous) {
      continue;
    }

    const elapsed = (sampledAt - previous.sampledAt) / 1000;
    const downloaded = previous.sizeLeft - item.sizeleft;

    // Going backwards means the release was swapped out underneath us, not
    // that it lost data, so there is no rate worth reporting for it.
    if (elapsed <= 0 || downloaded < 0) {
      continue;
    }

    rates.set(key, Math.round(downloaded / elapsed));
  }

  return { rates, samples };
};

/** The parts of a queue record that look the same for movies and series. */
const mapQueueItem = (
  item: QueueItem,
  rates: Map<string, number>
): Omit<DownloadingItem, 'mediaType' | 'externalId'> => ({
  estimatedCompletionTime: item.estimatedCompletionTime
    ? new Date(item.estimatedCompletionTime)
    : undefined,
  startedAt: item.added ? new Date(item.added) : undefined,
  size: item.size,
  sizeLeft: item.sizeleft,
  status: item.status,
  trackedDownloadStatus: item.trackedDownloadStatus,
  trackedDownloadState: item.trackedDownloadState,
  timeLeft: item.timeleft,
  title: item.title,
  downloadId: item.downloadId,
  protocol: item.protocol,
  downloadClient: item.downloadClient,
  indexer: item.indexer,
  quality: item.quality?.quality?.name,
  statusMessages: item.statusMessages,
  errorMessage: item.errorMessage,
  downloadRate: rates.get(sampleKey(item)),
});

class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};
  private radarrSamples: Record<number, Map<string, ProgressSample>> = {};
  private sonarrSamples: Record<number, Map<string, ProgressSample>> = {};

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.radarrServers[serverId]) {
      return [];
    }

    return this.radarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.sonarrServers[serverId]) {
      return [];
    }

    return this.sonarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
    this.radarrSamples = {};
    this.sonarrSamples = {};
  }

  public async updateDownloads(): Promise<void> {
    await Promise.all([
      this.updateRadarrDownloads(),
      this.updateSonarrDownloads(),
    ]);
  }

  private async updateRadarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.radarr, (radarrA, radarrB) => {
      return (
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
      );
    });

    // Load downloads from Radarr servers
    await Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          try {
            const radarr = new RadarrAPI({
              apiKey: server.apiKey,
              url: RadarrAPI.buildUrl(server, '/api/v3'),
            });

            await radarr.refreshMonitoredDownloads();
            const queueItems = await radarr.getQueue();

            const { rates, samples } = measureRates(
              this.radarrSamples[server.id] ?? new Map(),
              queueItems,
              Date.now()
            );
            this.radarrSamples[server.id] = samples;

            this.radarrServers[server.id] = queueItems.map((item) => ({
              ...mapQueueItem(item, rates),
              externalId: item.movieId,
              mediaType: MediaType.MOVIE,
            }));

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get queue from Radarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.radarr.filter(
            (rs) =>
              rs.hostname === server.hostname &&
              rs.port === server.port &&
              rs.baseUrl === server.baseUrl &&
              rs.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Radarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.radarrServers[ms.id] = this.radarrServers[server.id];
            }
          });
        }
      })
    );
  }

  private async updateSonarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
      return (
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
      );
    });

    // Load downloads from Sonarr servers
    await Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          try {
            const sonarr = new SonarrAPI({
              apiKey: server.apiKey,
              url: SonarrAPI.buildUrl(server, '/api/v3'),
            });

            await sonarr.refreshMonitoredDownloads();
            const queueItems = await sonarr.getQueue();

            const { rates, samples } = measureRates(
              this.sonarrSamples[server.id] ?? new Map(),
              queueItems,
              Date.now()
            );
            this.sonarrSamples[server.id] = samples;

            this.sonarrServers[server.id] = queueItems.map((item) => ({
              ...mapQueueItem(item, rates),
              externalId: item.seriesId,
              mediaType: MediaType.TV,
              episode: item.episode,
            }));

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Sonarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get queue from Sonarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              ss.hostname === server.hostname &&
              ss.port === server.port &&
              ss.baseUrl === server.baseUrl &&
              ss.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.sonarrServers[ms.id] = this.sonarrServers[server.id];
            }
          });
        }
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
