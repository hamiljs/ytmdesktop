export enum TrayIconStyle {
  Auto = 0,
  White = 1,
  Black = 2
}

export type StoreSchema = {
  metadata: {
    version: 1;
    appVersion: string;
  };
  general: {
    disableHardwareAcceleration: boolean;
    hideToTrayOnClose: boolean;
    showNotificationOnSongChange: boolean;
    startOnBoot: boolean;
    startMinimized: boolean;
  };
  appearance: {
    alwaysShowVolumeSlider: boolean;
    customCSSEnabled: boolean;
    customCSSPath: string | null;
    zoom: number;
    trayIconStyle: TrayIconStyle;
  };
  playback: {
    continueWhereYouLeftOff: boolean;
    continueWhereYouLeftOffPaused: boolean;
    enableSpeakerFill: boolean;
    progressInTaskbar: boolean;
    ratioVolume: boolean;
  };
  integrations: {
    companionServerEnabled: boolean;
    companionServerAuthTokens: string | null; // array[object] | Encrypted for security
    companionServerCORSWildcardEnabled: boolean;
    discordPresenceEnabled: boolean;
    lastFMEnabled: boolean;
    enhancedMediaServiceEnabled: boolean;
    // HDC fork
    callAutoPauseEnabled: boolean;
    nightlyRestartEnabled: boolean;
    agentControlEnabled: boolean;
  };
  shortcuts: {
    playPause: string;
    next: string;
    previous: string;
    thumbsUp: string;
    thumbsDown: string;
    volumeUp: string;
    volumeDown: string;
    volumeMute: string;
    toggleShuffle: string;
    toggleRepeat: string;
  };
  state: {
    lastUrl: string;
    lastPlaylistId: string;
    lastVideoId: string;
    windowBounds: Electron.Rectangle | null;
    windowMaximized: boolean;
    miniplayerWindowBounds: Electron.Rectangle | null;
  };
  lastfm: {
    sessionKey: string | null;
    scrobblePercent: number;
    // HDC fork
    loveSync: boolean;
    cleanNames: boolean;
  };
  developer: {
    enableDevTools: boolean;
  };
};

export type MemoryStoreSchema = {
  discordPresenceConnectionFailed: boolean;

  shortcutsPlayPauseRegisterFailed: boolean;
  shortcutsNextRegisterFailed: boolean;
  shortcutsPreviousRegisterFailed: boolean;
  shortcutsThumbsUpRegisterFailed: boolean;
  shortcutsThumbsDownRegisterFailed: boolean;
  shortcutsVolumeUpRegisterFailed: boolean;
  shortcutsVolumeDownRegisterFailed: boolean;
  shortcutsVolumeMuteRegisterFailed: boolean;
  shortcutsToggleShuffleRegisterFailed: boolean;
  shortcutsToggleRepeatRegisterFailed: boolean;

  companionServerAuthWindowEnabled: boolean;

  safeStorageAvailable: boolean;

  autoUpdaterDisabled: boolean;
  autoUpdaterChecking: boolean;
  autoUpdaterNotAvailable: boolean;
  autoUpdaterAvailable: boolean;
  autoUpdaterDownloaded: boolean;
  autoUpdaterErrored: boolean;

  ytmViewLoadTimedout: boolean;
  ytmViewLoading: boolean;
  ytmViewLoadingError: boolean;
  ytmViewLoadingStatus: string;
  ytmViewUnresponsive: boolean;

  appLoadingStatus: string;

  lastFMAuthenticationStep: number;
  lastFMToken: string;
  // HDC fork: shared with the agent socket for read-only Last.fm queries
  lastFMUsername: string | null;
  // HDC fork: set by call auto-pause; agent commands that start sound refuse while true
  callInProgress: boolean;
};
