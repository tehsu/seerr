import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import restartMediaSearch from '@server/lib/mediaSearchRestart';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

interface RecordedSend {
  id: number;
  status: MediaRequestStatus;
  seasons: number[];
}

let radarrSends: RecordedSend[] = [];
let sonarrSends: RecordedSend[] = [];

// Requests are handed to both senders and each one picks out the type it
// handles. Their state is recorded as they come in, since the request itself
// keeps being written to afterwards.
const recordSend = (request: MediaRequest): RecordedSend => ({
  id: request.id,
  status: request.status,
  seasons: (request.seasons ?? []).map((season) => season.seasonNumber),
});

mock.method(
  MediaRequestSubscriber.prototype,
  'sendToRadarr',
  async (request: MediaRequest) => {
    if (request.type === MediaType.MOVIE) {
      radarrSends.push(recordSend(request));
    }
  }
);

mock.method(
  MediaRequestSubscriber.prototype,
  'sendToSonarr',
  async (request: MediaRequest) => {
    if (request.type === MediaType.TV) {
      sonarrSends.push(recordSend(request));
    }
  }
);

setupTestDb();

// Seeding requests trips the subscriber too, so the recorded sends are cleared
// once everything is in place.
function clearSends() {
  radarrSends = [];
  sonarrSends = [];
}

beforeEach(() => {
  sendNotificationMock.resetCalls();
  clearSends();
});

/**
 * The requests handed to the *arr subscriber while they were approved: those
 * are the ones it passes on to Radarr/Sonarr.
 */
function approvedSends(sends: RecordedSend[]) {
  return sends.filter((send) => send.status === MediaRequestStatus.APPROVED);
}

async function admin(): Promise<User> {
  return getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
}

async function seedMovie(fields: Partial<Media> = {}): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      serviceId: 0,
      externalServiceId: 7,
      externalServiceSlug: 'some-movie',
      ratingKey: '1234',
      ...fields,
    })
  );
}

async function seedSeries(seasonNumbers: number[]): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 67890,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      serviceId: 0,
      externalServiceId: 7,
      seasons: seasonNumbers.map(
        (seasonNumber) =>
          new Season({
            seasonNumber,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
      ),
    })
  );
}

async function seedRequest(
  media: Media,
  fields: Partial<MediaRequest> = {}
): Promise<MediaRequest> {
  const requestedBy = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: media.mediaType,
      media,
      requestedBy,
      status: MediaRequestStatus.COMPLETED,
      is4k: false,
      seasons: [],
      ...fields,
    })
  );
}

describe('restartMediaSearch', () => {
  it('re-approves the request for a deleted movie and clears its service data', async () => {
    const media = await seedMovie();
    const request = await seedRequest(media);
    const user = await admin();
    clearSends();

    const restarted = await restartMediaSearch(media, false, user);

    assert.deepStrictEqual(
      restarted.map((restartedRequest) => restartedRequest.id),
      [request.id]
    );

    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { modifiedBy: true, requestedBy: true },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persistedRequest.modifiedBy?.id, user.id);
    // the original requester keeps ownership of the request
    assert.strictEqual(persistedRequest.requestedBy.email, 'friend@seerr.dev');

    const persistedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedMedia.serviceId, null);
    assert.strictEqual(persistedMedia.externalServiceId, null);
    assert.strictEqual(persistedMedia.externalServiceSlug, null);
    assert.strictEqual(persistedMedia.ratingKey, null);
    // the approved request puts the media back into the download queue
    assert.strictEqual(persistedMedia.status, MediaStatus.PROCESSING);

    const sends = approvedSends(radarrSends);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].id, request.id);
  });

  it('sends a request that is still approved to Radarr again', async () => {
    // A request that comes out of the restart looking exactly like it went in
    // still has to reach Radarr.
    const media = await seedMovie({ status: MediaStatus.DELETED });
    const user = await admin();
    const request = await seedRequest(media, {
      status: MediaRequestStatus.APPROVED,
      modifiedBy: user,
    });
    clearSends();

    await restartMediaSearch(media, false, user);

    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.APPROVED);

    const sends = approvedSends(radarrSends);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].id, request.id);
  });

  it('leaves the 4k version alone when only the standard one was deleted', async () => {
    const media = await seedMovie({
      status4k: MediaStatus.AVAILABLE,
      serviceId4k: 1,
      externalServiceId4k: 9,
      ratingKey4k: '5678',
    });
    await seedRequest(media);
    const request4k = await seedRequest(media, { is4k: true });
    const user = await admin();
    clearSends();

    await restartMediaSearch(media, false, user);

    const persisted4kRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request4k.id },
    });
    assert.strictEqual(persisted4kRequest.status, MediaRequestStatus.COMPLETED);

    const persistedMedia = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedMedia.serviceId4k, 1);
    assert.strictEqual(persistedMedia.externalServiceId4k, 9);
    assert.strictEqual(persistedMedia.ratingKey4k, '5678');
    assert.strictEqual(persistedMedia.status4k, MediaStatus.AVAILABLE);
  });

  it('requests media that was never requested through Seerr', async () => {
    const media = await seedMovie();
    const user = await admin();
    clearSends();

    const restarted = await restartMediaSearch(media, false, user);

    assert.strictEqual(restarted.length, 1);

    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
      relations: { requestedBy: true },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persistedRequest.is4k, false);
    assert.strictEqual(persistedRequest.type, MediaType.MOVIE);
    assert.strictEqual(persistedRequest.requestedBy.id, user.id);

    const sends = approvedSends(radarrSends);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].id, persistedRequest.id);
  });

  it('restarts every request of a series so all of its seasons come back', async () => {
    const media = await seedSeries([1, 2]);
    const firstRequest = await seedRequest(media, {
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.COMPLETED,
        }),
      ],
    });
    const secondRequest = await seedRequest(media, {
      seasons: [
        new SeasonRequest({
          seasonNumber: 2,
          status: MediaRequestStatus.COMPLETED,
        }),
      ],
    });

    const user = await admin();
    clearSends();

    const restarted = await restartMediaSearch(media, false, user);

    assert.deepStrictEqual(
      restarted.map((request) => request.id).sort(),
      [firstRequest.id, secondRequest.id].sort()
    );

    const sends = approvedSends(sonarrSends);
    assert.deepStrictEqual(
      sends.map((send) => send.id).sort(),
      [firstRequest.id, secondRequest.id].sort()
    );
    assert.deepStrictEqual(
      sends.flatMap((send) => send.seasons).sort(),
      [1, 2]
    );

    const persistedSeasons = await getRepository(Season).find({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(persistedSeasons.length, 2);
    persistedSeasons.forEach((season) => {
      assert.strictEqual(season.status, MediaStatus.DELETED);
    });
  });

  it('requests the seasons a series had when it was never requested through Seerr', async () => {
    const media = await seedSeries([1, 2]);
    const user = await admin();
    clearSends();

    await restartMediaSearch(media, false, user);

    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(persistedRequest.type, MediaType.TV);
    assert.deepStrictEqual(
      persistedRequest.seasons.map((season) => season.seasonNumber).sort(),
      [1, 2]
    );
    assert.strictEqual(approvedSends(sonarrSends).length, 1);
  });

  it('leaves requests that never reached Radarr as they are', async () => {
    const media = await seedMovie();
    const declined = await seedRequest(media, {
      status: MediaRequestStatus.DECLINED,
    });
    const pending = await seedRequest(media, {
      status: MediaRequestStatus.PENDING,
    });
    const user = await admin();
    clearSends();

    const restarted = await restartMediaSearch(media, false, user);

    // neither of them downloaded the media, so a new request is made for it
    assert.strictEqual(restarted.length, 1);
    assert.ok(![declined.id, pending.id].includes(restarted[0].id));

    const requestRepository = getRepository(MediaRequest);
    const persistedDeclined = await requestRepository.findOneOrFail({
      where: { id: declined.id },
    });
    assert.strictEqual(persistedDeclined.status, MediaRequestStatus.DECLINED);

    const persistedPending = await requestRepository.findOneOrFail({
      where: { id: pending.id },
    });
    assert.strictEqual(persistedPending.status, MediaRequestStatus.PENDING);
  });
});
