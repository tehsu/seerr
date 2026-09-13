import EmbyLogo from '@app/assets/services/emby.svg';
import JellyfinLogo from '@app/assets/services/jellyfin.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import type { MainSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsPrimaryServer', {
  primaryServer: 'Primary Media Server',
  primaryServerDescription:
    'Seerr scans your libraries and checks media availability on your primary media server. Connect a different server here if you have moved to another one.',
  currentServer: 'Current',
  changeTo: 'Change to {mediaServerName}',
  cancel: 'Cancel',
  warningTitle: 'Changing your media server affects existing users and media',
  warningUsers:
    'Users of your current media server can no longer sign in with it, unless they have a password set for local sign-in.',
  warningMedia:
    'Media availability is rebuilt from the new server, so titles stay unavailable until its libraries have been scanned.',
  warningLibraries:
    'Libraries have to be selected again once the new server is connected.',
  ownerOnly:
    'Only the owner account can change the media server, because Seerr connects to it with their account.',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  enablessl: 'Use SSL',
  urlBase: 'URL Base',
  username: 'Username',
  password: 'Password',
  credentialsTip:
    'Sign in with an administrator account on the new {mediaServerName} server. Seerr uses it to create an API key and to keep you signed in.',
  plexTip:
    'Sign in with the Plex account that owns the server you want to use. You can select the server itself once the change is applied.',
  keepForSignIn: 'Keep {mediaServerName} Sign-In',
  keepForSignInTip:
    'Keep your current {mediaServerName} server available as an additional sign-in server, so its users do not lose access to Seerr',
  changeServer: 'Change Media Server',
  changingServer: 'Changing…',
  changeServerSuccess:
    '{mediaServerName} is now your primary media server. Select the libraries you would like to scan.',
  changeServerFailure: 'Something went wrong while changing the media server.',
  connectionerror: 'Unable to connect to the {mediaServerName} server.',
  credentialerror: 'The username or password is incorrect.',
  adminerror: 'You must use an administrator account.',
  linkederror:
    'That {mediaServerName} account is already linked to another Seerr user.',
  noserverserror: 'No Plex servers were found for this account.',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationUsernameRequired: 'You must provide a username',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
});

type PrimaryServerType =
  | MediaServerType.PLEX
  | MediaServerType.JELLYFIN
  | MediaServerType.EMBY;

const serverTypes: {
  type: PrimaryServerType;
  name: string;
  logo: React.ReactNode;
}[] = [
  {
    type: MediaServerType.PLEX,
    name: 'Plex',
    logo: <PlexLogo className="h-8" />,
  },
  {
    type: MediaServerType.JELLYFIN,
    name: 'Jellyfin',
    logo: <JellyfinLogo className="h-10" />,
  },
  {
    type: MediaServerType.EMBY,
    name: 'Emby',
    logo: <EmbyLogo className="h-9" />,
  },
];

const getServerName = (type: MediaServerType) =>
  serverTypes.find((server) => server.type === type)?.name ?? '';

/**
 * Offers to keep the Jellyfin/Emby server that is being replaced available as
 * an additional sign-in server.
 */
const KeepForSignInCheckbox = ({
  mediaServerName,
  checked,
  onChange,
}: {
  mediaServerName: string;
  checked: boolean;
  onChange: () => void;
}) => {
  const intl = useIntl();
  const label = intl.formatMessage(messages.keepForSignIn, { mediaServerName });

  return (
    <div className="relative flex items-start">
      <div className="flex h-6 items-center">
        <input
          type="checkbox"
          id="primaryServerKeepForSignIn"
          checked={checked}
          onChange={onChange}
        />
      </div>
      <div className="ml-3 text-sm leading-6">
        <label
          htmlFor="primaryServerKeepForSignIn"
          className="mb-0 block"
          aria-label={label}
        >
          <div className="flex flex-col">
            <span className="font-medium text-white">{label}</span>
            <span className="font-normal text-gray-400">
              {intl.formatMessage(messages.keepForSignInTip, {
                mediaServerName,
              })}
            </span>
          </div>
        </label>
      </div>
    </div>
  );
};

const SettingsPrimaryServer = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { addToast } = useToasts();
  const { user, revalidate: revalidateUser } = useUser();
  const { data: mainSettings } = useSWR<MainSettings>('/api/v1/settings/main');
  const [selectedType, setSelectedType] = useState<PrimaryServerType>();
  const [isChanging, setIsChanging] = useState(false);
  const [keepForSignIn, setKeepForSignIn] = useState(true);

  const currentType = settings.currentSettings.mediaServerType;
  // Seerr talks to the media server with the credentials of the owner account
  const isOwner = user?.id === 1;
  // The current server can be kept for sign-in only if it is a Jellyfin/Emby one
  const canKeepForSignIn =
    currentType === MediaServerType.JELLYFIN ||
    currentType === MediaServerType.EMBY;

  const changeServer = async (values: {
    type: PrimaryServerType;
    hostname?: string;
    port?: number;
    useSsl?: boolean;
    urlBase?: string;
    username?: string;
    password?: string;
    authToken?: string;
    keepForSignIn?: boolean;
  }) => {
    const mediaServerName = getServerName(values.type);
    setIsChanging(true);

    try {
      await axios.post('/api/v1/settings/mediaserver', {
        ...values,
        port: values.port ? Number(values.port) : undefined,
        keepForSignIn: canKeepForSignIn && values.keepForSignIn,
      });

      await mutate('/api/v1/settings/public');
      await mutate('/api/v1/settings/main');
      revalidateUser();

      addToast(
        intl.formatMessage(messages.changeServerSuccess, { mediaServerName }),
        { autoDismiss: true, appearance: 'success' }
      );

      setSelectedType(undefined);
      router.push(
        values.type === MediaServerType.PLEX
          ? '/settings/plex'
          : '/settings/jellyfin'
      );
    } catch (e) {
      let errorMessage = messages.changeServerFailure;

      switch (e?.response?.data?.message) {
        case ApiErrorCode.InvalidUrl:
        case ApiErrorCode.ConnectionError:
          errorMessage = messages.connectionerror;
          break;
        case ApiErrorCode.InvalidCredentials:
        case ApiErrorCode.InvalidAuthToken:
          errorMessage = messages.credentialerror;
          break;
        case ApiErrorCode.NotAdmin:
          errorMessage = messages.adminerror;
          break;
        case ApiErrorCode.AccountAlreadyLinked:
          errorMessage = messages.linkederror;
          break;
        case ApiErrorCode.NoServersFound:
          errorMessage = messages.noserverserror;
          break;
      }

      addToast(intl.formatMessage(errorMessage, { mediaServerName }), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsChanging(false);
    }
  };

  const JellyfinServerSchema = Yup.object().shape({
    hostname: Yup.string()
      .nullable()
      .required(intl.formatMessage(messages.validationHostnameRequired)),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.validationPortRequired))
      .nullable()
      .required(intl.formatMessage(messages.validationPortRequired)),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        intl.formatMessage(messages.validationUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    username: Yup.string()
      .nullable()
      .required(intl.formatMessage(messages.validationUsernameRequired)),
  });

  // Prefill the connection details of the server if it is already configured
  // as an additional sign-in server
  const loginServer =
    selectedType === MediaServerType.JELLYFIN
      ? mainSettings?.loginServers?.jellyfin
      : selectedType === MediaServerType.EMBY
        ? mainSettings?.loginServers?.emby
        : undefined;

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.primaryServer)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.primaryServerDescription)}
        </p>
      </div>
      <div className="section">
        <Alert title={intl.formatMessage(messages.warningTitle)} type="warning">
          <ul className="list-disc pl-5">
            <li>{intl.formatMessage(messages.warningUsers)}</li>
            <li>{intl.formatMessage(messages.warningMedia)}</li>
            <li>{intl.formatMessage(messages.warningLibraries)}</li>
          </ul>
        </Alert>
        {!isOwner ? (
          <Alert title={intl.formatMessage(messages.ownerOnly)} type="info" />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {serverTypes.map(({ type, name, logo }) => (
                <div
                  key={`media-server-${type}`}
                  className={`flex flex-col divide-y divide-gray-700 rounded-md border bg-gray-800 ${
                    selectedType === type
                      ? 'border-indigo-500'
                      : 'border-gray-700'
                  }`}
                >
                  <div className="flex flex-1 items-center justify-center px-4 py-6">
                    {logo}
                  </div>
                  <div className="px-4 py-3 text-center">
                    {type === currentType ? (
                      <Badge badgeType="success">
                        {intl.formatMessage(messages.currentServer)}
                      </Badge>
                    ) : (
                      <Button
                        buttonType={
                          selectedType === type ? 'primary' : 'default'
                        }
                        className="w-full"
                        onClick={() =>
                          setSelectedType(
                            selectedType === type ? undefined : type
                          )
                        }
                      >
                        {intl.formatMessage(
                          selectedType === type
                            ? messages.cancel
                            : messages.changeTo,
                          { mediaServerName: name }
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {selectedType === MediaServerType.PLEX && (
              <div className="mt-6 space-y-4">
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.plexTip)}
                </p>
                {canKeepForSignIn && (
                  <KeepForSignInCheckbox
                    mediaServerName={getServerName(currentType)}
                    checked={keepForSignIn}
                    onChange={() => setKeepForSignIn(!keepForSignIn)}
                  />
                )}
                <div className="flex">
                  <PlexLoginButton
                    isProcessing={isChanging}
                    onAuthToken={(authToken) =>
                      changeServer({
                        type: MediaServerType.PLEX,
                        authToken,
                        keepForSignIn,
                      })
                    }
                    onError={(message) =>
                      addToast(message, {
                        autoDismiss: true,
                        appearance: 'error',
                      })
                    }
                  />
                </div>
              </div>
            )}
            {(selectedType === MediaServerType.JELLYFIN ||
              selectedType === MediaServerType.EMBY) && (
              <Formik
                initialValues={{
                  hostname: loginServer?.ip ?? '',
                  port: loginServer?.ip ? loginServer.port : 8096,
                  useSsl: loginServer?.ip ? loginServer.useSsl : false,
                  urlBase: loginServer?.ip ? loginServer.urlBase : '',
                  username: '',
                  password: '',
                  keepForSignIn: canKeepForSignIn,
                }}
                enableReinitialize
                validationSchema={JellyfinServerSchema}
                onSubmit={async (values) =>
                  changeServer({ type: selectedType, ...values })
                }
              >
                {({ errors, touched, values, setFieldValue, isSubmitting }) => (
                  <Form className="mt-6 space-y-4">
                    <p className="text-sm text-gray-400">
                      {intl.formatMessage(messages.credentialsTip, {
                        mediaServerName: getServerName(selectedType),
                      })}
                    </p>
                    <div>
                      <label htmlFor="primaryServerHostname">
                        {intl.formatMessage(messages.hostname)}
                        <span className="label-required">*</span>
                      </label>
                      <div className="form-input-field">
                        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                          {values.useSsl ? 'https://' : 'http://'}
                        </span>
                        <Field
                          type="text"
                          inputMode="url"
                          id="primaryServerHostname"
                          name="hostname"
                          className="rounded-r-only"
                        />
                      </div>
                      {errors.hostname && touched.hostname && (
                        <div className="error">{errors.hostname}</div>
                      )}
                    </div>
                    <div>
                      <label htmlFor="primaryServerPort">
                        {intl.formatMessage(messages.port)}
                        <span className="label-required">*</span>
                      </label>
                      <Field
                        type="text"
                        inputMode="numeric"
                        id="primaryServerPort"
                        name="port"
                        className="short"
                      />
                      {errors.port && touched.port && (
                        <div className="error">{errors.port}</div>
                      )}
                    </div>
                    <div className="flex items-center">
                      <Field
                        type="checkbox"
                        id="primaryServerUseSsl"
                        name="useSsl"
                        onChange={() => {
                          setFieldValue('useSsl', !values.useSsl);
                          setFieldValue('port', values.useSsl ? 8096 : 443);
                        }}
                      />
                      <label
                        htmlFor="primaryServerUseSsl"
                        className="mb-0 ml-3"
                      >
                        {intl.formatMessage(messages.enablessl)}
                      </label>
                    </div>
                    <div>
                      <label htmlFor="primaryServerUrlBase">
                        {intl.formatMessage(messages.urlBase)}
                      </label>
                      <Field
                        type="text"
                        inputMode="url"
                        id="primaryServerUrlBase"
                        name="urlBase"
                      />
                      {errors.urlBase && touched.urlBase && (
                        <div className="error">{errors.urlBase}</div>
                      )}
                    </div>
                    <div>
                      <label htmlFor="primaryServerUsername">
                        {intl.formatMessage(messages.username)}
                        <span className="label-required">*</span>
                      </label>
                      <Field
                        type="text"
                        id="primaryServerUsername"
                        name="username"
                        autoComplete="off"
                        data-form-type="other"
                        data-1pignore="true"
                        data-lpignore="true"
                        data-bwignore="true"
                      />
                      {errors.username && touched.username && (
                        <div className="error">{errors.username}</div>
                      )}
                    </div>
                    <div>
                      <label htmlFor="primaryServerPassword">
                        {intl.formatMessage(messages.password)}
                      </label>
                      <Field
                        type="password"
                        id="primaryServerPassword"
                        name="password"
                        autoComplete="off"
                        data-form-type="other"
                        data-1pignore="true"
                        data-lpignore="true"
                        data-bwignore="true"
                      />
                    </div>
                    {canKeepForSignIn && (
                      <KeepForSignInCheckbox
                        mediaServerName={getServerName(currentType)}
                        checked={values.keepForSignIn}
                        onChange={() =>
                          setFieldValue('keepForSignIn', !values.keepForSignIn)
                        }
                      />
                    )}
                    <div className="flex justify-end">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting || isChanging}
                      >
                        {isSubmitting || isChanging
                          ? intl.formatMessage(messages.changingServer)
                          : intl.formatMessage(messages.changeServer)}
                      </Button>
                    </div>
                  </Form>
                )}
              </Formik>
            )}
          </>
        )}
      </div>
    </>
  );
};

export default SettingsPrimaryServer;
