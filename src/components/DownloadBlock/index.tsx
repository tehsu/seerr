import Badge from '@app/components/Common/Badge';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { MessageDescriptor } from 'react-intl';
import { FormattedRelativeTime, useIntl } from 'react-intl';

const messages = defineMessages('components.DownloadBlock', {
  estimatedtime: 'Estimated {time}',
  startedtime: 'Started {time}',
  formattedTitle: '{title}: Season {seasonNumber} Episode {episodeNumber}',
  progress: '{downloaded} of {total}',
  downloadrate: '{rate}/s',
  downloadclient: 'Client',
  indexer: 'Indexer',
  protocol: 'Protocol',
  statusqueued: 'Queued',
  statuspaused: 'Paused',
  statusdownloading: 'Downloading',
  statuscompleted: 'Completed',
  statusdelay: 'Delayed',
  statusclientunavailable: 'Client Unavailable',
  statusfailed: 'Failed',
  statuswarning: 'Warning',
  stateimportpending: 'Waiting to Import',
  stateimportblocked: 'Import Blocked',
  stateimporting: 'Importing',
  stateimported: 'Imported',
});

/**
 * Where the release sits in its lifecycle, which Radarr and Sonarr report
 * separately from the queue status. Once a transfer finishes, this is the part
 * still worth watching, so it wins over the status when both are known.
 */
const trackedStateLabels: Record<string, MessageDescriptor> = {
  importPending: messages.stateimportpending,
  importBlocked: messages.stateimportblocked,
  importing: messages.stateimporting,
  imported: messages.stateimported,
  failedPending: messages.statusfailed,
  failed: messages.statusfailed,
};

const statusLabels: Record<string, MessageDescriptor> = {
  queued: messages.statusqueued,
  paused: messages.statuspaused,
  downloading: messages.statusdownloading,
  completed: messages.statuscompleted,
  delay: messages.statusdelay,
  downloadClientUnavailable: messages.statusclientunavailable,
  failed: messages.statusfailed,
  warning: messages.statuswarning,
};

/** Seconds from now, negative for a time already past. */
const relativeSeconds = (date: Date): number =>
  Math.floor((new Date(date).getTime() - Date.now()) / 1000);

interface DownloadBlockProps {
  downloadItem: DownloadingItem;
  is4k?: boolean;
  title?: string;
}

const DownloadBlock = ({
  downloadItem,
  is4k = false,
  title,
}: DownloadBlockProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();

  const isAdmin = hasPermission(Permission.ADMIN);
  const hasError =
    downloadItem.trackedDownloadStatus === 'error' ||
    downloadItem.status === 'failed';
  const hasWarning =
    !hasError &&
    (downloadItem.trackedDownloadStatus === 'warning' ||
      downloadItem.status === 'warning' ||
      downloadItem.status === 'downloadClientUnavailable');

  // Clamped because a queue record briefly reports more left than its total
  // when the release it points at is swapped for a different one.
  const progress = downloadItem.size
    ? Math.min(
        Math.max(
          Math.round(
            ((downloadItem.size - downloadItem.sizeLeft) / downloadItem.size) *
              100
          ),
          0
        ),
        100
      )
    : 0;

  const statusLabel =
    (downloadItem.trackedDownloadState
      ? trackedStateLabels[downloadItem.trackedDownloadState]
      : undefined) ?? statusLabels[downloadItem.status];

  // Anything Radarr or Sonarr is unhappy about, which is the one thing worth
  // reading in full when a download stops moving. Release names leak through
  // here, so it stays behind the same gate as the title above.
  const problems = isAdmin
    ? [
        ...(downloadItem.errorMessage ? [downloadItem.errorMessage] : []),
        ...(downloadItem.statusMessages ?? []).flatMap((statusMessage) =>
          statusMessage.messages.length > 0
            ? statusMessage.messages
            : [statusMessage.title]
        ),
      ]
    : [];

  const details = isAdmin
    ? [
        { label: messages.downloadclient, value: downloadItem.downloadClient },
        { label: messages.indexer, value: downloadItem.indexer },
        { label: messages.protocol, value: downloadItem.protocol },
      ].filter((detail) => !!detail.value)
    : [];

  return (
    <div className="p-4">
      <div className="mb-2 w-56 truncate text-sm sm:w-80 md:w-full">
        {isAdmin
          ? downloadItem.title
          : downloadItem.episode
            ? intl.formatMessage(messages.formattedTitle, {
                title,
                seasonNumber: downloadItem?.episode?.seasonNumber,
                episodeNumber: downloadItem?.episode?.episodeNumber,
              })
            : title}
      </div>
      <div className="relative mb-2 h-6 min-w-0 overflow-hidden rounded-full bg-gray-700">
        <div
          className={`h-8 transition-all duration-200 ease-in-out ${
            hasError
              ? 'bg-red-600'
              : hasWarning
                ? 'bg-yellow-600'
                : 'bg-indigo-600'
          }`}
          style={{ width: `${progress}%` }}
        />
        <div className="absolute inset-0 flex h-6 w-full items-center justify-center text-xs">
          <span>{progress}%</span>
        </div>
      </div>
      {!!downloadItem.size && (
        <div className="mb-2 flex items-center justify-between text-xs text-gray-300">
          <span>
            {intl.formatMessage(messages.progress, {
              downloaded: formatBytes(
                Math.max(downloadItem.size - downloadItem.sizeLeft, 0)
              ),
              total: formatBytes(downloadItem.size),
            })}
          </span>
          {downloadItem.downloadRate != null && (
            <span>
              {intl.formatMessage(messages.downloadrate, {
                rate: formatBytes(downloadItem.downloadRate, 1),
              })}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-xs">
        <span className="flex flex-wrap items-center gap-1">
          {is4k && <Badge badgeType="warning">4K</Badge>}
          <Badge
            badgeType={hasError ? 'danger' : hasWarning ? 'warning' : 'default'}
            className={statusLabel ? undefined : 'capitalize'}
          >
            {statusLabel
              ? intl.formatMessage(statusLabel)
              : downloadItem.status}
          </Badge>
          {!!downloadItem.quality && (
            <Badge badgeType="light">{downloadItem.quality}</Badge>
          )}
        </span>
        <span>
          {downloadItem.estimatedCompletionTime ? (
            intl.formatMessage(messages.estimatedtime, {
              time: (
                <FormattedRelativeTime
                  value={relativeSeconds(downloadItem.estimatedCompletionTime)}
                  updateIntervalInSeconds={1}
                  numeric="auto"
                />
              ),
            })
          ) : downloadItem.startedAt ? (
            // Nothing is moving, so how long it has been sitting there is the
            // next most useful thing to know.
            intl.formatMessage(messages.startedtime, {
              time: (
                <FormattedRelativeTime
                  value={relativeSeconds(downloadItem.startedAt)}
                  updateIntervalInSeconds={1}
                  numeric="auto"
                />
              ),
            })
          ) : (
            <></>
          )}
        </span>
      </div>
      {problems.length > 0 && (
        <ul
          className={`mt-2 space-y-1 text-xs ${
            hasError ? 'text-red-400' : 'text-yellow-400'
          }`}
        >
          {problems.map((problem, index) => (
            <li key={`download-problem-${index}`}>{problem}</li>
          ))}
        </ul>
      )}
      {details.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
          {details.map((detail) => (
            <span key={detail.label.id}>
              {intl.formatMessage(detail.label)}: {detail.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default DownloadBlock;
