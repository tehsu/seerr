import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import type { User } from '@server/entity/User';
import logger from '@server/logger';
import { In, Not } from 'typeorm';

/**
 * Hands a media item that was just deleted back to Radarr/Sonarr so a fresh
 * copy gets downloaded.
 *
 * The media row itself is kept, so its issues and request history survive. We
 * clear the service data pointing at the files that are now gone, mark the
 * version as deleted, and move the requests for it back to APPROVED. Approving
 * is what actually starts the search: MediaRequestSubscriber sends approved
 * requests to Radarr/Sonarr, which is the same path the request retry endpoint
 * takes.
 *
 * Media that was never requested through Seerr (e.g. it was only ever scanned
 * in from the media server) has nothing to re-approve, so a request is created
 * on behalf of `user` instead.
 */
const restartMediaSearch = async (
  media: Media,
  is4k: boolean,
  user: User
): Promise<MediaRequest[]> => {
  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);
  const statusKey = is4k ? 'status4k' : 'status';

  // Work off a fresh copy: deleting the other version of the same media may
  // have moved its status along already, and this one is loaded without the
  // requests relation, so saving it cannot cascade into the requests we are
  // about to re-approve.
  const currentMedia = await mediaRepository.findOneOrFail({
    where: { id: media.id },
  });
  const seasons = currentMedia.seasons ?? [];

  // Grabbed before the statuses below are wiped, so we still know which
  // seasons were in the library if we have to build a request from scratch.
  const deletedSeasons = seasons
    .filter((season) => season[statusKey] !== MediaStatus.UNKNOWN)
    .map((season) => season.seasonNumber);

  currentMedia.resetServiceData(is4k);
  currentMedia[statusKey] = MediaStatus.DELETED;
  seasons.forEach((season) => {
    season[statusKey] = MediaStatus.DELETED;
  });
  await mediaRepository.save(currentMedia);

  // Requests that were never handed to Radarr/Sonarr are left alone: they did
  // not put anything in the library, so there is nothing of theirs to replace,
  // and a request still waiting for approval should keep waiting.
  const requests = await requestRepository.find({
    where: {
      media: { id: currentMedia.id },
      is4k,
      status: Not(
        In([MediaRequestStatus.PENDING, MediaRequestStatus.DECLINED])
      ),
    },
    order: { id: 'DESC' },
    relations: { media: true, requestedBy: true, modifiedBy: true },
  });

  // A movie is covered by its most recent request, but the seasons of a series
  // can be spread across several requests, and the delete took the entire
  // series out of Sonarr.
  const requestsToRestart =
    currentMedia.mediaType === MediaType.MOVIE
      ? requests.slice(0, 1)
      : requests;

  if (!requestsToRestart.length) {
    const request = new MediaRequest({
      type: currentMedia.mediaType,
      media: currentMedia,
      requestedBy: user,
      modifiedBy: user,
      status: MediaRequestStatus.APPROVED,
      is4k,
      seasons: deletedSeasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.APPROVED,
          })
      ),
    });

    await requestRepository.save(request);

    logger.info('Requested deleted media again to start a new search', {
      label: 'Media',
      mediaId: currentMedia.id,
      is4k,
      requestId: request.id,
    });

    return [request];
  }

  for (const request of requestsToRestart) {
    // Only a real status change makes the subscriber send the request to
    // Radarr/Sonarr again, so a request already sitting in APPROVED has to be
    // moved out of the way first.
    if (request.status === MediaRequestStatus.APPROVED) {
      request.status = MediaRequestStatus.PENDING;
      await requestRepository.save(request);
    }

    request.status = MediaRequestStatus.APPROVED;
    request.modifiedBy = user;
    await requestRepository.save(request);
  }

  logger.info('Restarted the search for deleted media', {
    label: 'Media',
    mediaId: currentMedia.id,
    is4k,
    requestIds: requestsToRestart.map((request) => request.id),
  });

  return requestsToRestart;
};

export default restartMediaSearch;
