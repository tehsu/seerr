import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type {
  IssueRequestBody,
  IssueResultsResponse,
} from '@server/interfaces/api/issueInterfaces';
import deleteMediaFile, {
  MediaServiceNotConfiguredError,
} from '@server/lib/mediaDeletion';
import searchMediaRelease, {
  MediaNotInServiceError,
} from '@server/lib/mediaReleaseSearch';
import restartMediaSearch from '@server/lib/mediaSearchRestart';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const issueRoutes = Router();

issueRoutes.get<Record<string, string>, IssueResultsResponse>(
  '/',
  isAuthenticated(
    [
      Permission.MANAGE_ISSUES,
      Permission.VIEW_ISSUES,
      Permission.CREATE_ISSUES,
    ],
    { type: 'or' }
  ),
  async (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 10;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const createdBy = req.query.createdBy ? Number(req.query.createdBy) : null;

    let sortFilter: string;

    switch (req.query.sort) {
      case 'modified':
        sortFilter = 'issue.updatedAt';
        break;
      default:
        sortFilter = 'issue.createdAt';
    }

    let statusFilter: IssueStatus[];

    switch (req.query.filter) {
      case 'open':
        statusFilter = [IssueStatus.OPEN];
        break;
      case 'resolved':
        statusFilter = [IssueStatus.RESOLVED];
        break;
      default:
        statusFilter = [IssueStatus.OPEN, IssueStatus.RESOLVED];
    }

    let query = getRepository(Issue)
      .createQueryBuilder('issue')
      .leftJoinAndSelect('issue.createdBy', 'createdBy')
      .leftJoinAndSelect('issue.media', 'media')
      .leftJoinAndSelect('issue.modifiedBy', 'modifiedBy')
      .leftJoinAndSelect('issue.comments', 'comments')
      .where('issue.status IN (:...issueStatus)', {
        issueStatus: statusFilter,
      });

    if (
      !req.user?.hasPermission(
        [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
        { type: 'or' }
      )
    ) {
      if (createdBy && createdBy !== req.user?.id) {
        return next({
          status: 403,
          message:
            'You do not have permission to view issues reported by other users',
        });
      }
      query = query.andWhere('createdBy.id = :id', { id: req.user?.id });
    } else if (createdBy) {
      query = query.andWhere('createdBy.id = :id', { id: createdBy });
    }

    const [issues, issueCount] = await query
      .orderBy(sortFilter, 'DESC')
      .take(pageSize)
      .skip(skip)
      .getManyAndCount();

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(issueCount / pageSize),
        pageSize,
        results: issueCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: issues,
    });
  }
);

issueRoutes.post<Record<string, string>, Issue, IssueRequestBody>(
  '/',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
    type: 'or',
  }),
  async (req, res, next) => {
    // Satisfy typescript here. User is set, we assure you!
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    const issueRepository = getRepository(Issue);
    const mediaRepository = getRepository(Media);
    const userRepository = getRepository(User);

    const media = await mediaRepository.findOne({
      where: { id: req.body.mediaId },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    let createdBy = req.user;

    if (req.body.userId != null && req.body.userId !== req.user.id) {
      if (!req.user.hasPermission(Permission.MANAGE_ISSUES)) {
        return next({
          status: 403,
          message:
            'You do not have permission to create an issue on behalf of another user.',
        });
      }

      const user = await userRepository.findOne({
        where: { id: req.body.userId },
      });

      if (!user) {
        return next({ status: 404, message: 'Issue user not found' });
      }

      createdBy = user;
    }

    const issue = new Issue({
      createdBy,
      issueType: req.body.issueType,
      problemSeason: req.body.problemSeason,
      problemEpisode: req.body.problemEpisode,
      deletionRequested: !!req.body.deletionRequested,
      media,
      comments: [
        new IssueComment({
          user: createdBy,
          message: req.body.message,
        }),
      ],
    });

    const newIssue = await issueRepository.save(issue);

    return res.status(201).json(newIssue);
  }
);

issueRoutes.get('/count', async (req, res, next) => {
  const issueRepository = getRepository(Issue);

  try {
    const query = issueRepository.createQueryBuilder('issue');

    const totalCount = await query.getCount();

    const videoCount = await query
      .where('issue.issueType = :issueType', {
        issueType: IssueType.VIDEO,
      })
      .getCount();

    const audioCount = await query
      .where('issue.issueType = :issueType', {
        issueType: IssueType.AUDIO,
      })
      .getCount();

    const subtitlesCount = await query
      .where('issue.issueType = :issueType', {
        issueType: IssueType.SUBTITLES,
      })
      .getCount();

    const othersCount = await query
      .where('issue.issueType = :issueType', {
        issueType: IssueType.OTHER,
      })
      .getCount();

    const openCount = await query
      .where('issue.status = :issueStatus', {
        issueStatus: IssueStatus.OPEN,
      })
      .getCount();

    const closedCount = await query
      .where('issue.status = :issueStatus', {
        issueStatus: IssueStatus.RESOLVED,
      })
      .getCount();

    return res.status(200).json({
      total: totalCount,
      video: videoCount,
      audio: audioCount,
      subtitles: subtitlesCount,
      others: othersCount,
      open: openCount,
      closed: closedCount,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving issue counts.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Unable to retrieve issue counts.' });
  }
});

issueRoutes.get<{ issueId: string }>(
  '/:issueId',
  isAuthenticated(
    [
      Permission.MANAGE_ISSUES,
      Permission.VIEW_ISSUES,
      Permission.CREATE_ISSUES,
    ],
    { type: 'or' }
  ),
  async (req, res, next) => {
    const issueRepository = getRepository(Issue);
    // Satisfy typescript here. User is set, we assure you!
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    try {
      const issue = await issueRepository
        .createQueryBuilder('issue')
        .leftJoinAndSelect('issue.comments', 'comments')
        .leftJoinAndSelect('issue.createdBy', 'createdBy')
        .leftJoinAndSelect('comments.user', 'user')
        .leftJoinAndSelect('issue.media', 'media')
        .where('issue.id = :issueId', { issueId: Number(req.params.issueId) })
        .getOneOrFail();

      if (
        issue.createdBy.id !== req.user.id &&
        !req.user.hasPermission(
          [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
          { type: 'or' }
        )
      ) {
        return next({
          status: 403,
          message: 'You do not have permission to view this issue.',
        });
      }

      return res.status(200).json(issue);
    } catch (e) {
      logger.debug('Failed to retrieve issue.', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Issue not found.' });
    }
  }
);

issueRoutes.post<{ issueId: string }, Issue, { message: string }>(
  '/:issueId/comment',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
    type: 'or',
  }),
  async (req, res, next) => {
    const issueRepository = getRepository(Issue);
    // Satisfy typescript here. User is set, we assure you!
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    try {
      const issue = await issueRepository.findOneOrFail({
        where: { id: Number(req.params.issueId) },
      });

      if (
        issue.createdBy.id !== req.user.id &&
        !req.user.hasPermission(Permission.MANAGE_ISSUES)
      ) {
        return next({
          status: 403,
          message: 'You do not have permission to comment on this issue.',
        });
      }

      const comment = new IssueComment({
        message: req.body.message,
        user: req.user,
      });

      issue.comments = [...issue.comments, comment];
      issue.updatedAt = new Date();
      await issueRepository.save(issue);

      return res.status(200).json(issue);
    } catch (e) {
      logger.debug('Something went wrong creating an issue comment.', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Issue not found.' });
    }
  }
);

issueRoutes.post<{ issueId: string; status: string }, Issue>(
  '/:issueId/:status',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
    type: 'or',
  }),
  async (req, res, next) => {
    const issueRepository = getRepository(Issue);
    // Satisfy typescript here. User is set, we assure you!
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    try {
      const issue = await issueRepository.findOneOrFail({
        where: { id: Number(req.params.issueId) },
      });

      if (
        !req.user?.hasPermission(Permission.MANAGE_ISSUES) &&
        issue.createdBy.id !== req.user?.id
      ) {
        return next({
          status: 401,
          message: 'You do not have permission to modify this issue.',
        });
      }

      let newStatus: IssueStatus | undefined;

      switch (req.params.status) {
        case 'resolved':
          newStatus = IssueStatus.RESOLVED;
          break;
        case 'open':
          newStatus = IssueStatus.OPEN;
      }

      if (!newStatus) {
        return next({
          status: 400,
          message: 'You must provide a valid status',
        });
      }

      issue.status = newStatus;
      issue.modifiedBy = req.user;

      await issueRepository.save(issue);

      return res.status(200).json(issue);
    } catch (e) {
      logger.debug('Something went wrong creating an issue comment.', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Issue not found.' });
    }
  }
);

issueRoutes.post<{ issueId: string }>(
  '/:issueId/media/search',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.MANAGE_REQUESTS], {
    type: 'and',
  }),
  async (req, res, next) => {
    const issueRepository = getRepository(Issue);
    const mediaRepository = getRepository(Media);

    let issue: Issue;
    let media: Media;

    try {
      issue = await issueRepository.findOneOrFail({
        where: { id: Number(req.params.issueId) },
        relations: { media: true },
      });

      media = await mediaRepository.findOneOrFail({
        where: { id: issue.media.id },
      });
    } catch (e) {
      logger.debug('Failed to retrieve issue media to search for a release.', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({ status: 404, message: 'Issue not found.' });
    }

    if (media.status === MediaStatus.BLOCKLISTED) {
      return next({
        status: 409,
        message: 'Blocklisted media is not searched for again.',
      });
    }

    // Only the versions actually managed by a Radarr/Sonarr server can be
    // searched for. Anything else (e.g. media only ever scanned in from the
    // media server) has no server to ask.
    const versions: boolean[] = [];

    if (media.serviceId != null && media.serviceId >= 0) {
      versions.push(false);
    }

    if (media.serviceId4k != null && media.serviceId4k >= 0) {
      versions.push(true);
    }

    if (!versions.length) {
      return next({
        status: 409,
        message: 'No Radarr/Sonarr server manages this media.',
      });
    }

    try {
      for (const is4k of versions) {
        await searchMediaRelease(media, is4k, {
          season: issue.problemSeason,
          episode: issue.problemEpisode,
        });
      }
    } catch (e) {
      logger.error('Something went wrong searching for a new release.', {
        label: 'Issue',
        errorMessage: e.message,
        issueId: Number(req.params.issueId),
        mediaId: media.id,
      });

      const isServiceError =
        e instanceof MediaServiceNotConfiguredError ||
        e instanceof MediaNotInServiceError;

      return next({
        status: isServiceError ? 409 : 500,
        message: isServiceError
          ? e.message
          : 'Something went wrong starting the search.',
      });
    }

    return res.status(204).send();
  }
);

issueRoutes.delete<{ issueId: string }>(
  '/:issueId/media',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.MANAGE_REQUESTS], {
    type: 'and',
  }),
  async (req, res, next) => {
    const issueRepository = getRepository(Issue);
    const mediaRepository = getRepository(Media);
    // Satisfy typescript here. User is set, we assure you!
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    let issue: Issue;
    let media: Media;

    try {
      issue = await issueRepository.findOneOrFail({
        where: { id: Number(req.params.issueId) },
        relations: { media: true },
      });

      media = await mediaRepository.findOneOrFail({
        where: { id: issue.media.id },
      });
    } catch (e) {
      logger.debug('Failed to retrieve issue media for deletion.', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({ status: 404, message: 'Issue not found.' });
    }

    // Only attempt to remove the versions that are actually managed by a
    // Radarr/Sonarr server. Anything else (e.g. media only ever scanned in from
    // the media server) is simply cleared from Seerr below.
    const versions: boolean[] = [];

    if (media.serviceId != null && media.serviceId >= 0) {
      versions.push(false);
    }

    if (media.serviceId4k != null && media.serviceId4k >= 0) {
      versions.push(true);
    }

    if (!versions.length) {
      // Without a Radarr/Sonarr server there are no files for us to delete and
      // nothing to search for again, so clearing the record is all we can do.
      // Removing the media also removes any issues attached to it.
      if (media.status === MediaStatus.BLOCKLISTED) {
        media.resetServiceData();
        await mediaRepository.save(media);
      } else {
        await mediaRepository.remove(media);
      }

      return res.status(204).send();
    }

    try {
      for (const is4k of versions) {
        await deleteMediaFile(media, is4k);
      }
    } catch (e) {
      logger.error('Something went wrong deleting media files for an issue.', {
        label: 'Issue',
        errorMessage: e.message,
        issueId: Number(req.params.issueId),
        mediaId: media.id,
      });

      return next({
        status: e instanceof MediaServiceNotConfiguredError ? 409 : 500,
        message:
          e instanceof MediaServiceNotConfiguredError
            ? e.message
            : 'Something went wrong deleting the media files.',
      });
    }

    if (media.status === MediaStatus.BLOCKLISTED) {
      // Blocklisted media is meant to stay gone, so it never gets searched for
      // again.
      media.resetServiceData();
      await mediaRepository.save(media);
    } else {
      // Deleting the files on their own would leave everyone without the media
      // the issue was reported against, so go looking for a replacement.
      try {
        for (const is4k of versions) {
          await restartMediaSearch(media, is4k, req.user);
        }
      } catch (e) {
        logger.error(
          'Deleted the media files for an issue, but failed to search for the media again.',
          {
            label: 'Issue',
            errorMessage: e.message,
            issueId: Number(req.params.issueId),
            mediaId: media.id,
          }
        );

        return next({
          status: 500,
          message:
            'The media files were deleted, but the search could not be restarted.',
        });
      }
    }

    // The media the issue was reported against is gone, so the issue itself has
    // been dealt with.
    issue.status = IssueStatus.RESOLVED;
    issue.modifiedBy = req.user;
    await issueRepository.save(issue);

    return res.status(204).send();
  }
);

issueRoutes.delete(
  '/:issueId',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
    type: 'or',
  }),
  async (req, res, next) => {
    const issueRepository = getRepository(Issue);

    try {
      const issue = await issueRepository.findOneOrFail({
        where: { id: Number(req.params.issueId) },
        relations: { createdBy: true },
      });

      if (
        !req.user?.hasPermission(Permission.MANAGE_ISSUES) &&
        (issue.createdBy.id !== req.user?.id || issue.comments.length > 1)
      ) {
        return next({
          status: 401,
          message: 'You do not have permission to delete this issue.',
        });
      }

      await issueRepository.remove(issue);

      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong deleting an issue.', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 404, message: 'Issue not found.' });
    }
  }
);

export default issueRoutes;
