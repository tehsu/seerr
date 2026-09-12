import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LabeledCheckbox from '@app/components/Common/LabeledCheckbox';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PermissionEdit from '@app/components/PermissionEdit';
import QuotaSelector from '@app/components/QuotaSelector';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import type {
  LoginServerSettings,
  LoginServersSettings,
  MainSettings,
} from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik, getIn } from 'formik';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as yup from 'yup';

const messages = defineMessages('components.Settings.SettingsUsers', {
  users: 'Users',
  userSettings: 'User Settings',
  userSettingsDescription: 'Configure global and default user settings.',
  toastSettingsSuccess: 'User settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  toastLoginServerConnectionFailure:
    'Unable to connect to an additional sign-in server. Check its hostname, port and URL base.',
  loginMethods: 'Login Methods',
  loginMethodsTip: 'Configure login methods for users.',
  localLogin: 'Enable Local Sign-In',
  localLoginTip:
    'Allow users to sign in using their email address and password',
  mediaServerLogin: 'Enable {mediaServerName} Sign-In',
  mediaServerLoginTip:
    'Allow users to sign in using their {mediaServerName} account',
  loginServerTip:
    'Allow users of an additional {mediaServerName} server to sign in using their {mediaServerName} account',
  loginServerHostname: 'Hostname or IP Address',
  loginServerPort: 'Port',
  loginServerUseSsl: 'Use SSL',
  loginServerUrlBase: 'URL Base',
  loginServerExternalUrl: 'External URL',
  loginServerForgotPasswordUrl: 'Forgot Password URL',
  validationLoginServerHostnameRequired:
    'You must provide a valid hostname or IP address',
  validationLoginServerPortRequired: 'You must provide a valid port number',
  validationLoginServerUrl: 'You must provide a valid URL',
  validationLoginServerUrlTrailingSlash: 'URL must not end in a trailing slash',
  validationLoginServerUrlBaseLeadingSlash:
    'URL base must have a leading slash',
  validationLoginServerUrlBaseTrailingSlash:
    'URL base must not end in a trailing slash',
  atLeastOneAuth: 'At least one authentication method must be selected.',
  newPlexLogin: 'Enable New {mediaServerName} Sign-In',
  newPlexLoginTip:
    'Allow {mediaServerName} users to sign in without first being imported',
  movieRequestLimitLabel: 'Global Movie Request Limit',
  tvRequestLimitLabel: 'Global Series Request Limit',
  defaultPermissions: 'Default Permissions',
  defaultPermissionsTip: 'Initial permissions assigned to new users',
  disabledMediaServerLoginWarning:
    'Some users may not have a {applicationTitle} password set. Disabling {mediaServerName} sign-in could lock them out. Affected users will need to set a password from their profile or via a password reset link.',
});

const defaultLoginServer: LoginServerSettings = {
  enabled: false,
  ip: '',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: '',
  forgotPasswordUrl: '',
};

const loginServerTypes: {
  key: keyof LoginServersSettings;
  name: string;
  type: MediaServerType;
}[] = [
  { key: 'jellyfin', name: 'Jellyfin', type: MediaServerType.JELLYFIN },
  { key: 'emby', name: 'Emby', type: MediaServerType.EMBY },
];

const SettingsUsers = () => {
  const { addToast } = useToasts();
  const intl = useIntl();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MainSettings>('/api/v1/settings/main');
  const settings = useSettings();

  // Jellyfin/Emby servers that can be configured for sign-in in addition to
  // the primary media server
  const additionalLoginServerTypes = loginServerTypes.filter(
    (server) => server.type !== settings.currentSettings.mediaServerType
  );

  const loginServerSchema = yup.object().shape({
    enabled: yup.boolean(),
    ip: yup
      .string()
      .nullable()
      .when('enabled', {
        is: true,
        then: (schema) =>
          schema.required(
            intl.formatMessage(messages.validationLoginServerHostnameRequired)
          ),
      }),
    port: yup
      .number()
      .typeError(intl.formatMessage(messages.validationLoginServerPortRequired))
      .nullable()
      .when('enabled', {
        is: true,
        then: (schema) =>
          schema.required(
            intl.formatMessage(messages.validationLoginServerPortRequired)
          ),
      }),
    urlBase: yup
      .string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationLoginServerUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        intl.formatMessage(messages.validationLoginServerUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    externalHostname: yup
      .string()
      .nullable()
      .test(
        'valid-url',
        intl.formatMessage(messages.validationLoginServerUrl),
        isValidURL
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationLoginServerUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    forgotPasswordUrl: yup
      .string()
      .nullable()
      .test(
        'valid-url',
        intl.formatMessage(messages.validationLoginServerUrl),
        isValidURL
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationLoginServerUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
  });

  const schema = yup
    .object()
    .shape({
      localLogin: yup.boolean(),
      mediaServerLogin: yup.boolean(),
      loginServers: yup.object().shape({
        jellyfin: loginServerSchema,
        emby: loginServerSchema,
      }),
    })
    .test({
      name: 'atLeastOneAuth',
      test: function (values) {
        const isValid =
          !!values.localLogin ||
          !!values.mediaServerLogin ||
          additionalLoginServerTypes.some(
            (server) => !!values.loginServers?.[server.key]?.enabled
          );

        if (isValid) return true;
        return this.createError({
          path: 'localLogin | mediaServerLogin',
          message: intl.formatMessage(messages.atLeastOneAuth),
        });
      },
    });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const mediaServerFormatValues = {
    mediaServerName:
      settings.currentSettings.mediaServerType === MediaServerType.JELLYFIN
        ? 'Jellyfin'
        : settings.currentSettings.mediaServerType === MediaServerType.EMBY
          ? 'Emby'
          : settings.currentSettings.mediaServerType === MediaServerType.PLEX
            ? 'Plex'
            : undefined,
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.users),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.userSettings)}</h3>
        <p className="description">
          {intl.formatMessage(messages.userSettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            localLogin: data?.localLogin,
            mediaServerLogin: data?.mediaServerLogin,
            loginServers: {
              jellyfin: {
                ...defaultLoginServer,
                ...data?.loginServers?.jellyfin,
              },
              emby: { ...defaultLoginServer, ...data?.loginServers?.emby },
            },
            newPlexLogin: data?.newPlexLogin,
            movieQuotaLimit: data?.defaultQuotas.movie.quotaLimit ?? 0,
            movieQuotaDays: data?.defaultQuotas.movie.quotaDays ?? 7,
            tvQuotaLimit: data?.defaultQuotas.tv.quotaLimit ?? 0,
            tvQuotaDays: data?.defaultQuotas.tv.quotaDays ?? 7,
            defaultPermissions: data?.defaultPermissions ?? 0,
          }}
          validationSchema={schema}
          enableReinitialize
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/main', {
                localLogin: values.localLogin,
                mediaServerLogin: values.mediaServerLogin,
                loginServers: Object.fromEntries(
                  loginServerTypes.map(({ key }) => [
                    key,
                    {
                      ...values.loginServers[key],
                      port: Number(values.loginServers[key].port),
                    },
                  ])
                ),
                newPlexLogin: values.newPlexLogin,
                defaultQuotas: {
                  movie: {
                    quotaLimit: values.movieQuotaLimit,
                    quotaDays: values.movieQuotaDays,
                  },
                  tv: {
                    quotaLimit: values.tvQuotaLimit,
                    quotaDays: values.tvQuotaDays,
                  },
                },
                defaultPermissions: values.defaultPermissions,
              });
              mutate('/api/v1/settings/public');

              addToast(intl.formatMessage(messages.toastSettingsSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch (e) {
              const isConnectionError =
                e?.response?.data?.message === ApiErrorCode.InvalidUrl ||
                e?.response?.data?.message === ApiErrorCode.ConnectionError;

              addToast(
                intl.formatMessage(
                  isConnectionError
                    ? messages.toastLoginServerConnectionFailure
                    : messages.toastSettingsFailure
                ),
                {
                  autoDismiss: true,
                  appearance: 'error',
                }
              );
            } finally {
              revalidate();
            }
          }}
        >
          {({
            isSubmitting,
            isValid,
            values,
            errors,
            touched,
            setFieldValue,
          }) => {
            const loginServerError = (path: string) => {
              const fieldError = getIn(errors, path);

              return getIn(touched, path) && typeof fieldError === 'string' ? (
                <div className="error">{fieldError}</div>
              ) : null;
            };

            return (
              <Form className="section">
                <div
                  role="group"
                  aria-labelledby="group-label"
                  className="form-group"
                >
                  <div className="form-row">
                    <span id="group-label" className="group-label">
                      {intl.formatMessage(messages.loginMethods)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.loginMethodsTip)}
                      </span>
                      {'localLogin | mediaServerLogin' in errors && (
                        <span className="error">
                          {errors['localLogin | mediaServerLogin'] as string}
                        </span>
                      )}
                    </span>

                    <div className="form-input-area max-w-lg">
                      <LabeledCheckbox
                        id="localLogin"
                        label={intl.formatMessage(messages.localLogin)}
                        description={intl.formatMessage(
                          messages.localLoginTip,
                          mediaServerFormatValues
                        )}
                        onChange={() =>
                          setFieldValue('localLogin', !values.localLogin)
                        }
                      />
                      <LabeledCheckbox
                        id="mediaServerLogin"
                        className="mt-4"
                        label={intl.formatMessage(
                          messages.mediaServerLogin,
                          mediaServerFormatValues
                        )}
                        description={intl.formatMessage(
                          messages.mediaServerLoginTip,
                          mediaServerFormatValues
                        )}
                        onChange={() =>
                          setFieldValue(
                            'mediaServerLogin',
                            !values.mediaServerLogin
                          )
                        }
                      />
                      {!values.mediaServerLogin && values.localLogin && (
                        <div className="mt-4">
                          <Alert
                            title={intl.formatMessage(
                              messages.disabledMediaServerLoginWarning,
                              {
                                applicationTitle:
                                  settings.currentSettings.applicationTitle,
                                ...mediaServerFormatValues,
                              }
                            )}
                            type="warning"
                          />
                        </div>
                      )}
                      {additionalLoginServerTypes.map(({ key, name }) => {
                        const server = values.loginServers[key];
                        const fieldName = (field: keyof LoginServerSettings) =>
                          `loginServers.${key}.${field}`;

                        return (
                          <div key={key} className="mt-4">
                            <LabeledCheckbox
                              id={fieldName('enabled')}
                              label={intl.formatMessage(
                                messages.mediaServerLogin,
                                { mediaServerName: name }
                              )}
                              description={intl.formatMessage(
                                messages.loginServerTip,
                                { mediaServerName: name }
                              )}
                              onChange={() =>
                                setFieldValue(
                                  fieldName('enabled'),
                                  !server.enabled
                                )
                              }
                            />
                            {server.enabled && (
                              <div className="mt-4 space-y-4 pl-10">
                                <div>
                                  <label htmlFor={fieldName('ip')}>
                                    {intl.formatMessage(
                                      messages.loginServerHostname
                                    )}
                                    <span className="label-required">*</span>
                                  </label>
                                  <div className="form-input-field">
                                    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                                      {server.useSsl ? 'https://' : 'http://'}
                                    </span>
                                    <Field
                                      type="text"
                                      inputMode="url"
                                      id={fieldName('ip')}
                                      name={fieldName('ip')}
                                      className="rounded-r-only"
                                    />
                                  </div>
                                  {loginServerError(fieldName('ip'))}
                                </div>
                                <div>
                                  <label htmlFor={fieldName('port')}>
                                    {intl.formatMessage(
                                      messages.loginServerPort
                                    )}
                                    <span className="label-required">*</span>
                                  </label>
                                  <Field
                                    type="text"
                                    inputMode="numeric"
                                    id={fieldName('port')}
                                    name={fieldName('port')}
                                    className="short"
                                  />
                                  {loginServerError(fieldName('port'))}
                                </div>
                                <div className="flex items-center">
                                  <Field
                                    type="checkbox"
                                    id={fieldName('useSsl')}
                                    name={fieldName('useSsl')}
                                    onChange={() => {
                                      setFieldValue(
                                        fieldName('useSsl'),
                                        !server.useSsl
                                      );
                                      setFieldValue(
                                        fieldName('port'),
                                        server.useSsl ? 8096 : 443
                                      );
                                    }}
                                  />
                                  <label
                                    htmlFor={fieldName('useSsl')}
                                    className="mb-0 ml-3"
                                  >
                                    {intl.formatMessage(
                                      messages.loginServerUseSsl
                                    )}
                                  </label>
                                </div>
                                <div>
                                  <label htmlFor={fieldName('urlBase')}>
                                    {intl.formatMessage(
                                      messages.loginServerUrlBase
                                    )}
                                  </label>
                                  <div className="form-input-field">
                                    <Field
                                      type="text"
                                      inputMode="url"
                                      id={fieldName('urlBase')}
                                      name={fieldName('urlBase')}
                                    />
                                  </div>
                                  {loginServerError(fieldName('urlBase'))}
                                </div>
                                <div>
                                  <label
                                    htmlFor={fieldName('externalHostname')}
                                  >
                                    {intl.formatMessage(
                                      messages.loginServerExternalUrl
                                    )}
                                  </label>
                                  <div className="form-input-field">
                                    <Field
                                      type="text"
                                      inputMode="url"
                                      id={fieldName('externalHostname')}
                                      name={fieldName('externalHostname')}
                                    />
                                  </div>
                                  {loginServerError(
                                    fieldName('externalHostname')
                                  )}
                                </div>
                                <div>
                                  <label
                                    htmlFor={fieldName('forgotPasswordUrl')}
                                  >
                                    {intl.formatMessage(
                                      messages.loginServerForgotPasswordUrl
                                    )}
                                  </label>
                                  <div className="form-input-field">
                                    <Field
                                      type="text"
                                      inputMode="url"
                                      id={fieldName('forgotPasswordUrl')}
                                      name={fieldName('forgotPasswordUrl')}
                                    />
                                  </div>
                                  {loginServerError(
                                    fieldName('forgotPasswordUrl')
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="form-row">
                  <label htmlFor="newPlexLogin" className="checkbox-label">
                    {intl.formatMessage(
                      messages.newPlexLogin,
                      mediaServerFormatValues
                    )}
                    <span className="label-tip">
                      {intl.formatMessage(
                        messages.newPlexLoginTip,
                        mediaServerFormatValues
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="newPlexLogin"
                      name="newPlexLogin"
                      onChange={() => {
                        setFieldValue('newPlexLogin', !values.newPlexLogin);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="applicationTitle" className="text-label">
                    {intl.formatMessage(messages.movieRequestLimitLabel)}
                  </label>
                  <div className="form-input-area">
                    <QuotaSelector
                      onChange={setFieldValue}
                      dayFieldName="movieQuotaDays"
                      limitFieldName="movieQuotaLimit"
                      mediaType="movie"
                      defaultDays={values.movieQuotaDays}
                      defaultLimit={values.movieQuotaLimit}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="applicationTitle" className="text-label">
                    {intl.formatMessage(messages.tvRequestLimitLabel)}
                  </label>
                  <div className="form-input-area">
                    <QuotaSelector
                      onChange={setFieldValue}
                      dayFieldName="tvQuotaDays"
                      limitFieldName="tvQuotaLimit"
                      mediaType="tv"
                      defaultDays={values.tvQuotaDays}
                      defaultLimit={values.tvQuotaLimit}
                    />
                  </div>
                </div>
                <div
                  role="group"
                  aria-labelledby="group-label"
                  className="form-group"
                >
                  <div className="form-row">
                    <span id="group-label" className="group-label">
                      {intl.formatMessage(messages.defaultPermissions)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.defaultPermissionsTip)}
                      </span>
                    </span>
                    <div className="form-input-area">
                      <div className="max-w-lg">
                        <PermissionEdit
                          currentPermission={values.defaultPermissions}
                          onUpdate={(newPermissions) =>
                            setFieldValue('defaultPermissions', newPermissions)
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="actions">
                  <div className="flex justify-end">
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting || !isValid}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </span>
                  </div>
                </div>
              </Form>
            );
          }}
        </Formik>
      </div>
    </>
  );
};

export default SettingsUsers;
