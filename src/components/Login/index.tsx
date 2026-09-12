import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import Button from '@app/components/Common/Button';
import ImageFader from '@app/components/Common/ImageFader';
import PageTitle from '@app/components/Common/PageTitle';
import LanguagePicker from '@app/components/Layout/LanguagePicker';
import JellyfinLogin from '@app/components/Login/JellyfinLogin';
import LocalLogin from '@app/components/Login/LocalLogin';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@heroicons/react/24/solid';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import { useRouter } from 'next/dist/client/router';
import Image from 'next/image';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useIntl } from 'react-intl';
import { CSSTransition, SwitchTransition } from 'react-transition-group';
import useSWR from 'swr';

const messages = defineMessages('components.Login', {
  signin: 'Sign In',
  signinheader: 'Sign in to continue',
  signinwithplex: 'Use your Plex account',
  signinwithjellyfin: 'Use your {mediaServerName} account',
  signinwithoverseerr: 'Use your {applicationTitle} account',
  orsigninwith: 'Or sign in with',
});

/** Sign-in methods that are presented as a form (Plex uses an OAuth button). */
type LoginFormMethod = 'local' | 'jellyfin' | 'emby';

const mediaServerForms: Record<
  Exclude<LoginFormMethod, 'local'>,
  {
    serverType: MediaServerType;
    name: string;
    Logo: React.FC<React.SVGProps<SVGSVGElement>>;
  }
> = {
  jellyfin: {
    serverType: MediaServerType.JELLYFIN,
    name: 'Jellyfin',
    Logo: JellyfinLogo,
  },
  emby: { serverType: MediaServerType.EMBY, name: 'Emby', Logo: EmbyLogo },
};

const Login = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { user, revalidate } = useUser();

  const [error, setError] = useState('');
  const [isProcessing, setProcessing] = useState(false);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [selectedForm, setSelectedForm] = useState<LoginFormMethod | undefined>(
    undefined
  );

  // Effect that is triggered when the `authToken` comes back from the Plex OAuth
  // We take the token and attempt to sign in. If we get a success message, we will
  // ask swr to revalidate the user which _should_ come back with a valid user.
  useEffect(() => {
    const login = async () => {
      setProcessing(true);
      try {
        const response = await axios.post('/api/v1/auth/plex', { authToken });

        if (response.data?.id) {
          revalidate();
        }
      } catch (e) {
        setError(e.response?.data?.message);
        setAuthToken(undefined);
        setProcessing(false);
      }
    };
    if (authToken) {
      login();
    }
  }, [authToken, revalidate]);

  // Effect that is triggered whenever `useUser`'s user changes. If we get a new
  // valid user, we redirect the user to the home page as the login was successful.
  useEffect(() => {
    if (user) {
      router.push('/');
    }
  }, [user, router]);

  const { data: backdrops } = useSWR<string[]>('/api/v1/backdrops', {
    refreshInterval: 0,
    refreshWhenHidden: false,
    revalidateOnFocus: false,
  });

  const {
    mediaServerType: primaryServerType,
    mediaServerLogin: primaryServerLoginEnabled,
    localLogin: localLoginEnabled,
    loginServers,
  } = settings.currentSettings;

  // Form-based sign-in methods, in the order they are offered: the primary
  // media server first, then the local account, then any additional
  // Jellyfin/Emby servers configured for sign-in alongside the primary one.
  const formMethods: LoginFormMethod[] = [];
  if (
    primaryServerLoginEnabled &&
    primaryServerType === MediaServerType.JELLYFIN
  ) {
    formMethods.push('jellyfin');
  }
  if (primaryServerLoginEnabled && primaryServerType === MediaServerType.EMBY) {
    formMethods.push('emby');
  }
  if (localLoginEnabled) {
    formMethods.push('local');
  }
  if (
    loginServers?.jellyfin.enabled &&
    primaryServerType !== MediaServerType.JELLYFIN
  ) {
    formMethods.push('jellyfin');
  }
  if (
    loginServers?.emby.enabled &&
    primaryServerType !== MediaServerType.EMBY
  ) {
    formMethods.push('emby');
  }

  const plexLoginEnabled =
    primaryServerLoginEnabled && primaryServerType === MediaServerType.PLEX;

  const activeForm =
    selectedForm && formMethods.includes(selectedForm)
      ? selectedForm
      : formMethods[0];
  const loginFormVisible = !!activeForm;

  const localLoginRef = useRef<HTMLDivElement>(null);
  const jellyfinLoginRef = useRef<HTMLDivElement>(null);
  const embyLoginRef = useRef<HTMLDivElement>(null);
  const loginRefs = {
    local: localLoginRef,
    jellyfin: jellyfinLoginRef,
    emby: embyLoginRef,
  };
  const loginRef = activeForm ? loginRefs[activeForm] : localLoginRef;

  const additionalLoginOptions: JSX.Element[] = [];

  if (plexLoginEnabled) {
    additionalLoginOptions.push(
      <PlexLoginButton
        key="plex"
        isProcessing={isProcessing}
        onAuthToken={(authToken) => setAuthToken(authToken)}
        large={!loginFormVisible}
      />
    );
  }

  formMethods
    .filter((method) => method !== activeForm)
    .forEach((method) => {
      if (method === 'local') {
        additionalLoginOptions.push(
          <Button
            key="seerr"
            data-testid="seerr-login-button"
            className="flex-1 bg-transparent"
            onClick={() => setSelectedForm('local')}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/os_icon.svg"
              alt={settings.currentSettings.applicationTitle}
              className="mr-2 h-5"
            />
            <span>{settings.currentSettings.applicationTitle}</span>
          </Button>
        );
        return;
      }

      const { serverType, name, Logo } = mediaServerForms[method];

      additionalLoginOptions.push(
        <Button
          key={method}
          data-testid={
            serverType === primaryServerType
              ? 'mediaserver-login-button'
              : `${method}-login-button`
          }
          className="flex-1 bg-transparent"
          onClick={() => setSelectedForm(method)}
        >
          <Logo />
          <span>{name}</span>
        </Button>
      );
    });

  return (
    <div className="relative flex min-h-screen flex-col bg-gray-900 py-14">
      <PageTitle title={intl.formatMessage(messages.signin)} />
      <ImageFader
        backgroundImages={
          backdrops?.map(
            (backdrop) => `https://image.tmdb.org/t/p/original${backdrop}`
          ) ?? []
        }
      />
      <div className="absolute right-4 top-4 z-50">
        <LanguagePicker />
      </div>
      <div className="relative z-40 mt-10 flex flex-col items-center px-4 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="relative h-48 w-full max-w-full">
          <Image src="/logo_stacked.svg" alt="Logo" fill />
        </div>
      </div>
      <div className="relative z-50 mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div
          className="bg-gray-800/50 shadow sm:rounded-lg"
          style={{ backdropFilter: 'blur(5px)' }}
        >
          <>
            <Transition
              as="div"
              show={!!error}
              enter="transition-opacity duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="mb-4 rounded-md bg-red-600 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <XCircleIcon className="h-5 w-5 text-red-300" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-300">
                      {error}
                    </h3>
                  </div>
                </div>
              </div>
            </Transition>
            <div className="px-10 py-8">
              <SwitchTransition mode="out-in">
                <CSSTransition
                  key={activeForm ?? 'none'}
                  nodeRef={loginRef}
                  timeout={{ enter: 300, exit: 150 }}
                  onEntered={() => {
                    document
                      .querySelector<HTMLInputElement>('#email, #username')
                      ?.focus();
                  }}
                  classNames={{
                    enter: 'opacity-0',
                    enterActive: 'transition-opacity duration-300 opacity-100',
                    exit: 'opacity-100',
                    exitActive: 'transition-opacity duration-150 opacity-0',
                  }}
                >
                  <div ref={loginRef} className="button-container">
                    {activeForm === 'local' ? (
                      <LocalLogin revalidate={revalidate} />
                    ) : (
                      activeForm && (
                        <JellyfinLogin
                          serverType={mediaServerForms[activeForm].serverType}
                          revalidate={revalidate}
                        />
                      )
                    )}
                  </div>
                </CSSTransition>
              </SwitchTransition>

              {additionalLoginOptions.length > 0 &&
                (loginFormVisible ? (
                  <div className="flex items-center py-5">
                    <div className="flex-grow border-t border-gray-600" />
                    <span className="mx-2 flex-shrink text-sm text-gray-400">
                      {intl.formatMessage(messages.orsigninwith)}
                    </span>
                    <div className="flex-grow border-t border-gray-600" />
                  </div>
                ) : (
                  <h2 className="mb-6 text-center text-lg font-bold text-neutral-200">
                    {intl.formatMessage(messages.signinheader)}
                  </h2>
                ))}

              <div
                className={`flex w-full flex-wrap gap-2 ${
                  !loginFormVisible ? 'flex-col' : ''
                }`}
              >
                {additionalLoginOptions}
              </div>
            </div>
          </>
        </div>
      </div>
    </div>
  );
};

export default Login;
