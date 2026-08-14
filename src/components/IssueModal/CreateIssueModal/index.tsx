import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import { issueOptions } from '@app/components/IssueModal/constants';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { RadioGroup } from '@headlessui/react';
import { ArrowRightCircleIcon } from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { Field, Formik } from 'formik';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.IssueModal.CreateIssueModal', {
  validationMessageRequired: 'You must provide a description',
  whatswrong: "What's wrong?",
  providedetail:
    'Please provide a detailed explanation of the issue you encountered.',
  extras: 'Extras',
  season: 'Season {seasonNumber}',
  episode: 'Episode {episodeNumber}',
  allseasons: 'All Seasons',
  allepisodes: 'All Episodes',
  problemseason: 'Affected Season',
  problemepisode: 'Affected Episode',
  toastSuccessCreate:
    'Issue report for <strong>{title}</strong> submitted successfully!',
  toastFailedCreate: 'Something went wrong while submitting the issue.',
  toastviewissue: 'View Issue',
  reportissue: 'Report an Issue',
  submitissue: 'Submit Issue',
  requestdeletion: 'Request deletion of this {mediaType}',
  requestdeletiontip:
    'Ask an administrator to remove this item instead of fixing it.',
  movie: 'movie',
  series: 'series',
  findnewrelease: 'Find a new release?',
  findnewreleasedescription:
    'Have {arr} search for a new release of <strong>{title}</strong> now. The current files are kept unless a better release turns up.',
  findnewreleasesearch: 'Find New Release',
  findnewreleasesearching: 'Searching…',
  findnewreleaseskip: 'Not Now',
  toastSearchSuccess:
    'Searching for a new release of <strong>{title}</strong>.',
  toastSearchFailed: 'Something went wrong while starting the search.',
});

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const classNames = (...classes: string[]) => {
  return classes.filter(Boolean).join(' ');
};

interface CreateIssueModalProps {
  mediaType: 'movie' | 'tv';
  tmdbId?: number;
  onCancel?: () => void;
}

const CreateIssueModal = ({
  onCancel,
  mediaType,
  tmdbId,
}: CreateIssueModalProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const { data, error } = useSWR<MovieDetails | TvDetails>(
    tmdbId ? `/api/v1/${mediaType}/${tmdbId}` : null
  );
  // Set once the issue has been filed and we want to offer a search for a new
  // release of the media it was reported against.
  const [searchIssueId, setSearchIssueId] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  if (!tmdbId) {
    return null;
  }

  const availableSeasons = (data?.mediaInfo?.seasons ?? [])
    .filter(
      (season) =>
        season.status === MediaStatus.AVAILABLE ||
        season.status === MediaStatus.PARTIALLY_AVAILABLE ||
        (settings.currentSettings.series4kEnabled &&
          hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
            type: 'or',
          }) &&
          (season.status4k === MediaStatus.AVAILABLE ||
            season.status4k === MediaStatus.PARTIALLY_AVAILABLE))
    )
    .map((season) => season.seasonNumber);

  const CreateIssueModalSchema = Yup.object().shape({
    message: Yup.string().required(
      intl.formatMessage(messages.validationMessageRequired)
    ),
  });

  const title = data ? (isMovie(data) ? data.title : data.name) : '';
  const arr = mediaType === 'movie' ? 'Radarr' : 'Sonarr';

  // Only a Radarr/Sonarr server can go looking for another release, and
  // blocklisted media is meant to stay gone.
  const isManagedByArr =
    (data?.mediaInfo?.serviceId != null && data.mediaInfo.serviceId >= 0) ||
    (data?.mediaInfo?.serviceId4k != null && data.mediaInfo.serviceId4k >= 0);
  const canFindNewRelease =
    isManagedByArr &&
    data?.mediaInfo?.status !== MediaStatus.BLOCKLISTED &&
    hasPermission([Permission.MANAGE_ISSUES, Permission.MANAGE_REQUESTS], {
      type: 'and',
    });

  const findNewRelease = async () => {
    setIsSearching(true);

    try {
      await axios.post(`/api/v1/issue/${searchIssueId}/media/search`);

      addToast(
        intl.formatMessage(messages.toastSearchSuccess, {
          title,
          strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      addToast(
        e.response?.data?.message ??
          intl.formatMessage(messages.toastSearchFailed),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setIsSearching(false);

      if (onCancel) {
        onCancel();
      }
    }
  };

  if (searchIssueId != null) {
    return (
      <Modal
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(messages.findnewrelease)}
        subTitle={title}
        cancelText={intl.formatMessage(messages.findnewreleaseskip)}
        onOk={() => findNewRelease()}
        okText={intl.formatMessage(
          isSearching
            ? messages.findnewreleasesearching
            : messages.findnewreleasesearch
        )}
        okDisabled={isSearching}
        backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
      >
        {intl.formatMessage(messages.findnewreleasedescription, {
          arr,
          title,
          strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
        })}
      </Modal>
    );
  }

  return (
    <Formik
      initialValues={{
        selectedIssue: issueOptions[0],
        message: '',
        problemSeason: availableSeasons.length === 1 ? availableSeasons[0] : 0,
        problemEpisode: 0,
        deletionRequested: false,
      }}
      validationSchema={CreateIssueModalSchema}
      onSubmit={async (values) => {
        try {
          const newIssue = await axios.post<Issue>('/api/v1/issue', {
            issueType: values.selectedIssue.issueType,
            message: values.message,
            mediaId: data?.mediaInfo?.id,
            problemSeason: values.problemSeason,
            problemEpisode:
              values.problemSeason > 0 ? values.problemEpisode : 0,
            deletionRequested: values.deletionRequested,
          });

          if (data) {
            addToast(
              <>
                <div>
                  {intl.formatMessage(messages.toastSuccessCreate, {
                    title,
                    strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                  })}
                </div>
                <Link href={`/issues/${newIssue.data.id}`} legacyBehavior>
                  <Button as="a" className="mt-4">
                    <span>{intl.formatMessage(messages.toastviewissue)}</span>
                    <ArrowRightCircleIcon />
                  </Button>
                </Link>
              </>,
              {
                appearance: 'success',
                autoDismiss: true,
              }
            );

            mutate('/api/v1/issue/count');
          }

          // Asking for a replacement makes no sense alongside a request to have
          // the item removed altogether.
          if (canFindNewRelease && !values.deletionRequested) {
            setSearchIssueId(newIssue.data.id);
            return;
          }

          if (onCancel) {
            onCancel();
          }
        } catch {
          addToast(intl.formatMessage(messages.toastFailedCreate), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      }}
    >
      {({ handleSubmit, values, setFieldValue, errors, touched }) => {
        return (
          <Modal
            backgroundClickable
            onCancel={onCancel}
            title={intl.formatMessage(messages.reportissue)}
            subTitle={title}
            cancelText={intl.formatMessage(globalMessages.close)}
            onOk={() => handleSubmit()}
            okText={intl.formatMessage(messages.submitissue)}
            loading={!data && !error}
            backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
          >
            {mediaType === 'tv' && data && !isMovie(data) && (
              <>
                <div className="form-row">
                  <label htmlFor="problemSeason" className="text-label">
                    {intl.formatMessage(messages.problemseason)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="select"
                        id="problemSeason"
                        name="problemSeason"
                        disabled={availableSeasons.length === 1}
                      >
                        {availableSeasons.length > 1 && (
                          <option value={0}>
                            {intl.formatMessage(messages.allseasons)}
                          </option>
                        )}
                        {availableSeasons.map((season) => (
                          <option
                            value={season}
                            key={`problem-season-${season}`}
                          >
                            {season === 0
                              ? intl.formatMessage(messages.extras)
                              : intl.formatMessage(messages.season, {
                                  seasonNumber: season,
                                })}
                          </option>
                        ))}
                      </Field>
                    </div>
                  </div>
                </div>
                {values.problemSeason > 0 && (
                  <div className="form-row mb-2">
                    <label htmlFor="problemEpisode" className="text-label">
                      {intl.formatMessage(messages.problemepisode)}
                      <span className="label-required">*</span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          as="select"
                          id="problemEpisode"
                          name="problemEpisode"
                        >
                          <option value={0}>
                            {intl.formatMessage(messages.allepisodes)}
                          </option>
                          {[
                            ...Array(
                              data.seasons.find(
                                (season) =>
                                  Number(values.problemSeason) ===
                                  season.seasonNumber
                              )?.episodeCount ?? 0
                            ),
                          ].map((i, index) => (
                            <option
                              value={index + 1}
                              key={`problem-episode-${index + 1}`}
                            >
                              {intl.formatMessage(messages.episode, {
                                episodeNumber: index + 1,
                              })}
                            </option>
                          ))}
                        </Field>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <RadioGroup
              value={values.selectedIssue}
              onChange={(issue) => setFieldValue('selectedIssue', issue)}
              className="mt-4"
            >
              <RadioGroup.Label className="sr-only">
                Select an Issue
              </RadioGroup.Label>
              <div className="-space-y-px overflow-hidden rounded-md bg-gray-800/30">
                {issueOptions.map((setting, index) => (
                  <RadioGroup.Option
                    key={`issue-type-${setting.issueType}`}
                    value={setting}
                    className={({ checked }) =>
                      classNames(
                        index === 0 ? 'rounded-tl-md rounded-tr-md' : '',
                        index === issueOptions.length - 1
                          ? 'rounded-bl-md rounded-br-md'
                          : '',
                        checked
                          ? 'z-10 border border-indigo-500 bg-indigo-400/20'
                          : 'border-gray-500',
                        'relative flex cursor-pointer border p-4 focus:outline-none'
                      )
                    }
                  >
                    {({ active, checked }) => (
                      <>
                        <span
                          className={`${
                            checked
                              ? 'border-transparent bg-indigo-600'
                              : 'border-gray-300 bg-white'
                          } ${
                            active ? 'ring-2 ring-indigo-300 ring-offset-2' : ''
                          } mt-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border`}
                          aria-hidden="true"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-white" />
                        </span>
                        <div className="ml-3 flex flex-col">
                          <RadioGroup.Label
                            as="span"
                            className={`block text-sm font-medium ${
                              checked ? 'text-indigo-100' : 'text-gray-100'
                            }`}
                          >
                            {intl.formatMessage(setting.name)}
                          </RadioGroup.Label>
                        </div>
                      </>
                    )}
                  </RadioGroup.Option>
                ))}
              </div>
            </RadioGroup>
            <div className="mt-4 flex-col space-y-2">
              <label htmlFor="message">
                {intl.formatMessage(messages.whatswrong)}
                <span className="label-required">*</span>
              </label>
              <Field
                as="textarea"
                name="message"
                id="message"
                className="h-28"
                placeholder={intl.formatMessage(messages.providedetail)}
              />
              {errors.message &&
                touched.message &&
                typeof errors.message === 'string' && (
                  <div className="error">{errors.message}</div>
                )}
            </div>
            <div className="mt-4 flex items-start rounded-md border border-gray-500 bg-gray-800/30 p-4">
              <Field
                type="checkbox"
                id="deletionRequested"
                name="deletionRequested"
                className="mt-0.5 flex-shrink-0"
              />
              <label
                htmlFor="deletionRequested"
                className="mb-0 ml-3 cursor-pointer"
              >
                {intl.formatMessage(messages.requestdeletion, {
                  mediaType: intl.formatMessage(
                    mediaType === 'movie' ? messages.movie : messages.series
                  ),
                })}
                <span className="label-tip">
                  {intl.formatMessage(messages.requestdeletiontip)}
                </span>
              </label>
            </div>
          </Modal>
        );
      }}
    </Formik>
  );
};

export default CreateIssueModal;
