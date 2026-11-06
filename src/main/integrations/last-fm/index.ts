import { app, shell, safeStorage, ipcMain } from "electron";
import path from "node:path";

import PlayerStateStore from "../../services/playerstatestore";
import MemoryStore from "../../services/memorystore";
import ConfigStore from "../../services/configstore";

import log from "electron-log";
import Integration from "../integration";
import { MemoryStoreSchema, StoreSchema } from "~shared/store/schema";
import { LikeStatus, PlayerSignal, PlayerState, VideoState } from "~shared/playerstatestore/types";
import LastFMClient from "./last-fm-client";
import LastFMOutbox from "./outbox";
import { CleanTrack, chosenByUser, cleanTrack } from "./track-name.mjs";

declare const LASTFM_API_KEY: string | null | undefined;
declare const LASTFM_API_SECRET: string | null | undefined;

export default class LastFM extends Integration {
  public name = "LastFM";
  public storeEnableProperty: Integration["storeEnableProperty"] = "integrations.lastFMEnabled";
  public override disableFlags = ["disable_last_fm"];

  private lastFMDetails: StoreSchema["lastfm"] | null = null;
  private playerStateFunction: ((state: PlayerState) => void) | null = null;
  private playerSignalFunction: ((signal: PlayerSignal) => void) | null = null;

  private lastFMClient?: LastFMClient;
  private outbox?: LastFMOutbox;

  // The cleaned name of the current video. Set once per video before now playing is sent.
  private currentTrack: Promise<CleanTrack> | null = null;
  private currentChosenByUser = true;
  // Like status last seen for the current video, to spot thumbs up and thumbs down
  private lastLikeStatus: LikeStatus = LikeStatus.Unknown;
  // Videos already loved this session, so replaying a liked song sends one love, not one per play
  private lovedThisSession = new Set<string>();
  private correctionCache = new Map<string, CleanTrack>();

  private currentVideoId: string | null = null
  private scrobbleTimeRequired = -1;
  private accumulatedPlaybackTime = -1;
  private hasScrobbled = false;
  private playbackStartTimestamp = 0;
  private lastPlaybackAccumulationTime = 0;

  public onSetup() {}

  public async onEnabled() {
    const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);

    if (
      (typeof LASTFM_API_KEY === "undefined" || !LASTFM_API_KEY?.trim()) ||
      (typeof LASTFM_API_SECRET === "undefined" || !LASTFM_API_SECRET?.trim())
    ) {
      log.info("Refusing to enable LastFM Integration with reason: invalid api key or secret");
      return;
    }

    if (!memoryStore.get("safeStorageAvailable")) {
      log.info("Refusing to enable LastFM Integration with reason: safeStorage unavailable");
      return;
    }

    this.lastFMDetails = await this.getSettings();
    // A login made with another API key (upstream's build) or revoked on last.fm stops
    // working. Forget it and show the "Log in to Last.fm" button again. Unsent scrobbles
    // stay in the outbox until the new login.
    this.lastFMClient = new LastFMClient(LASTFM_API_KEY, LASTFM_API_SECRET, this.lastFMDetails.sessionKey ?? undefined, () => {
      log.warn("lastfm: session no longer valid, log in again from Settings > Integrations");
      if (this.lastFMDetails) this.lastFMDetails.sessionKey = null;
      this.getService(ConfigStore).set("lastfm.sessionKey", null);
      memoryStore.set("lastFMAuthenticationStep", 0);
    });
    if (!this.outbox) this.outbox = new LastFMOutbox(path.join(app.getPath("userData"), "lastfm-outbox.json"), () => this.lastFMClient);
    this.outbox.start();

    if (!this.lastFMDetails.sessionKey) {
      memoryStore.set("lastFMAuthenticationStep", 0);
    } else {
      memoryStore.set("lastFMAuthenticationStep", 2);
      void this.refreshUserName();
    }

    this.playerStateFunction = (state: PlayerState) => this.updatePlayerState(state);
    this.playerSignalFunction = (signal: PlayerSignal) => this.updateFromPlayerSignal(signal);

    const playerStateStore = this.getService(PlayerStateStore);
    playerStateStore.on("state-changed", this.playerStateFunction);
    playerStateStore.on("player-signal", this.playerSignalFunction);

    const finishLogin = async (token: string): Promise<boolean> => {
      if (!this.lastFMClient || memoryStore.get("lastFMToken") !== token) return false;
      const sessionKey = await this.lastFMClient.getSession(token);
      if (this.lastFMDetails) this.lastFMDetails.sessionKey = sessionKey;
      await this.saveSettings();
      memoryStore.set("lastFMAuthenticationStep", 2);
      log.info("lastfm: logged in");
      void this.refreshUserName();
      void this.outbox?.flush();
      return true;
    };

    ipcMain.on("lastfm:authenticate", async () => {
      const authStep = memoryStore.get("lastFMAuthenticationStep");
      if (authStep === 0) {
        memoryStore.set("lastFMAuthenticationStep", 1);

        const token = await this.lastFMClient?.getToken();
        memoryStore.set("lastFMToken", token);
        shell.openExternal(
          `https://www.last.fm/api/auth/` + `?api_key=${encodeURIComponent(LASTFM_API_KEY)}` + `&token=${encodeURIComponent(token)}`
        );

        // Finish by itself once the user approves in the browser, so the "Finish" click is
        // optional. Last.fm answers "unauthorized token" until then; tokens live 60 minutes.
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline && memoryStore.get("lastFMAuthenticationStep") === 1 && memoryStore.get("lastFMToken") === token) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          try {
            if (memoryStore.get("lastFMAuthenticationStep") === 1 && (await finishLogin(token))) return;
          } catch {
            // not approved yet
          }
        }
      } else if (authStep === 1) {
        try {
          await finishLogin(memoryStore.get("lastFMToken") as string);
        } catch (err) {
          log.warn("lastfm: finish login failed, approve the app in the browser first", err);
        }
      }
    });
  }

  public onDisabled(): void {
    const playerStateStore = this.getService(PlayerStateStore);
    if (this.playerStateFunction) playerStateStore.off("state-changed", this.playerStateFunction);
    if (this.playerSignalFunction) playerStateStore.off("player-signal", this.playerSignalFunction);
    this.outbox?.stop();
  }

  private async refreshUserName() {
    try {
      const name = await this.lastFMClient?.getUserName();
      this.getService(MemoryStore<MemoryStoreSchema>).set("lastFMUsername", name ?? null);
    } catch (err) {
      log.warn("lastfm: could not read the username", err);
    }
  }

  private async getSettings(): Promise<StoreSchema["lastfm"]> {
    const configStore = this.getService(ConfigStore);
    const decryptedValues = configStore.get("lastfm");

    // Grab the session key and token from the store and decrypt them
    if (decryptedValues.sessionKey) {
      try {
        decryptedValues.sessionKey = (await safeStorage.decryptStringAsync(Buffer.from(decryptedValues.sessionKey, "hex"))).result;
      } catch (e) {
        decryptedValues.sessionKey = null;
        log.error(e);
      }
    }

    return decryptedValues;
  }

  private async saveSettings(): Promise<void> {
    const configStore = this.getService(ConfigStore);
    try {
      if (this.lastFMDetails) {
        if (this.lastFMDetails.sessionKey) {
          configStore.set("lastfm.sessionKey", (await safeStorage.encryptStringAsync(this.lastFMDetails.sessionKey)).toString("hex"));
        }
      }
    } catch {
      // Do nothing, the values are not valid and can be ignored
    }
  }

  private async maybeUpdateScrobble(state: PlayerState): Promise<void> {
    // TODO: Regression counterpart checking is removed - maybe consider it completely valid as it is not inherently the same video?

    if (!state.videoDetails) return;
    if (state.videoDetails.id === this.currentVideoId) return;

    const hasFullMetadata = state.hasFullMetadata;
    if (!hasFullMetadata) {
      return;
    }

    // Track must be longer than 30 seconds
    // https://www.last.fm/api/scrobbling "When is a scrobble a scrobble?"
    if (state.videoDetails.durationSeconds < 30) {
      return;
    }

    this.currentVideoId = state.videoDetails.id;

    const configStore = this.getService(ConfigStore);

    this.lastFMDetails!.scrobblePercent = configStore.get("lastfm.scrobblePercent");
    const scrobblePercentDecimal = Math.max(50, Math.min(100, this.lastFMDetails!.scrobblePercent)) / 100;
    this.scrobbleTimeRequired = Math.min(
      // Scrobble the track if it has been played to the percent picked by the user
      Math.round(state.videoDetails.durationSeconds * scrobblePercentDecimal),
      // OR if it has been played for more than 4 minutes, scrobble maximum time: https://www.last.fm/api/scrobbling
      240
    );
    this.accumulatedPlaybackTime = -1;
    this.hasScrobbled = false;
    this.playbackStartTimestamp = new Date().getTime();
    this.lastLikeStatus = LikeStatus.Unknown;
    this.currentChosenByUser = chosenByUser(state.playlistId, state.videoDetails.id);
    this.currentTrack = this.resolveTrack(state);
  }

  /**
   * The artist and track name to send to Last.fm. Music videos and uploads get their
   * names cleaned ("DaftPunkVEVO" -> "Daft Punk"), then checked against Last.fm's own
   * spelling. Official audio tracks are sent as YouTube Music reports them.
   */
  private async resolveTrack(state: PlayerState): Promise<CleanTrack> {
    const details = state.videoDetails!;
    const raw = { title: details.title, author: details.author, album: details.album, videoType: details.videoType };
    const configStore = this.getService(ConfigStore);
    if (!configStore.get("lastfm.cleanNames")) {
      return { artist: details.author, track: details.title, album: details.album ?? undefined };
    }

    const cleaned = cleanTrack(raw);
    if (details.videoType === 0) return cleaned;

    const cached = this.correctionCache.get(details.id);
    if (cached) return cached;
    let result = cleaned;
    try {
      const corrected = await this.lastFMClient?.getCorrection(cleaned.artist, cleaned.track);
      if (corrected) result = { ...cleaned, ...corrected };
    } catch (err) {
      log.warn("lastfm: name correction failed, using the cleaned name", err);
    }
    if (result.artist !== details.author || result.track !== details.title) {
      log.info(`lastfm: "${details.author} - ${details.title}" -> "${result.artist} - ${result.track}"`);
    }
    if (this.correctionCache.size > 500) this.correctionCache.clear();
    this.correctionCache.set(details.id, result);
    return result;
  }

  /**
   * Thumbs up in YouTube Music loves the track on Last.fm. Removing the thumbs up, or
   * a thumbs down, unloves it. A song that is already liked when it starts playing is
   * loved once per session, which back-fills likes made before this feature existed.
   */
  private async syncLove(state: PlayerState) {
    const details = state.videoDetails;
    if (!details || details.id !== this.currentVideoId || !this.currentTrack) return;
    if (!this.getService(ConfigStore).get("lastfm.loveSync")) return;

    const status = details.likeStatus;
    if (status === LikeStatus.Unknown || status === this.lastLikeStatus) return;
    const previous = this.lastLikeStatus;
    this.lastLikeStatus = status;

    const track = await this.currentTrack;
    if (status === LikeStatus.Like && !this.lovedThisSession.has(details.id)) {
      this.lovedThisSession.add(details.id);
      this.outbox?.add({ kind: "love", artist: track.artist, track: track.track });
    } else if (previous === LikeStatus.Like && status !== LikeStatus.Like) {
      this.lovedThisSession.delete(details.id);
      this.outbox?.add({ kind: "unlove", artist: track.artist, track: track.track });
    }
  }

  private async updatePlayerState(state: PlayerState): Promise<void> {
    if (!this.isEnabled || !this.lastFMDetails?.sessionKey) {
      return;
    }

    await this.maybeUpdateScrobble(state);
    void this.syncLove(state);

    // Media is actively playing accumulate playback time for scrobble & update now playing if needed
    if (state.videoDetails && state.trackState === VideoState.Playing) {
      if (this.accumulatedPlaybackTime === -1) {
        this.accumulatedPlaybackTime = 0;
        try {
          const track = await this.currentTrack;
          if (!track) return;
          await this.lastFMClient?.updateNowPlaying({
            artist: track.artist,
            track: track.track,
            album: track.album,
            duration: state.videoDetails.durationSeconds
          });
        } catch(err) {
          log.error("lastfm: failed to update now playing", err);
        }
      }

      if (!this.hasScrobbled && this.scrobbleTimeRequired >= 0) {
        const now = new Date().getTime();
        if (now - this.lastPlaybackAccumulationTime >= 1000) {
          this.accumulatedPlaybackTime++;
          this.lastPlaybackAccumulationTime = now;
        }

        if (this.accumulatedPlaybackTime >= this.scrobbleTimeRequired) {
          this.hasScrobbled = true;
          const track = await this.currentTrack;
          if (!track) return;
          // Saved to disk first; the outbox sends it now, or later if Last.fm is unreachable
          this.outbox?.add({
            kind: "scrobble",
            play: {
              artist: track.artist,
              track: track.track,
              timestamp: Math.floor(this.playbackStartTimestamp / 1000),
              album: track.album,
              duration: state.videoDetails.durationSeconds,
              chosenByUser: this.currentChosenByUser
            }
          });
        }
      }
    }
  }

  private updateFromPlayerSignal(signal: PlayerSignal) {
    // NewPlayback signal is considered a fresh playback e.g. a new video or a looped video
    if (signal === PlayerSignal.NewPlayback) {
      this.currentVideoId = null;
    }
  }
}
