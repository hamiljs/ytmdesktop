import { app } from "electron";
import crypto from "node:crypto";
import log from "electron-log";

const LASTFM_ENDPOINT = "https://ws.audioscrobbler.com/2.0/";

export type LastFMUpdateNowPlayingParams = {
  artist: string;
  track: string;
  album?: string;
  trackNumber?: number;
  context?: string;
  mbid?: string;
  duration?: number;
  albumArtist?: string;
};

export type LastFMScrobbleParams = {
  artist: string;
  track: string;
  timestamp: number;
  album?: string;
  context?: string;
  streamId?: string;
  chosenByUser?: boolean;
  trackNumber?: number;
  mbid?: string;
  albumArtist?: string;
  duration?: number;
};

export enum LastFMErrorCode {
  Unknown1 = 1,
  InvalidService = 2,
  InvalidMethod = 3,
  AuthenticationFailed = 4,
  InvalidFormat = 5,
  InvalidParameters = 6,
  InvalidResourceSpecified = 7,
  OperationFailed = 8,
  InvalidSessionKey = 9,
  InvalidAPIKey = 10,
  ServiceOffline = 11,
  SubscribersOnly = 12,
  InvalidMethodSignature = 13,
  UnauthorizedToken = 14,
  NotAvailableForStreaming = 15,
  ServiceTemporarilyUnvailable = 16,
  RequiresLogin = 17,
  TrialExpired = 18,
  Unknown19 = 19,
  NotEnoughContent = 20,
  NotEnoughMembers = 21,
  NotEnoughFans = 22,
  NotEnoughNeighbors = 23,
  NoPeakRadio = 24,
  RadioNotFound = 25,
  APIKeySuspended = 26,
  Deprecated = 27,
  RateLimitExceeded = 29
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default class LastFMClient {
  private apiKey: string;
  private apiSecret: string;
  private sessionKey?: string;

  private apiKeySuspended = false;

  constructor(
    apiKey: string,
    apiSecret: string,
    sessionKey?: string,
    private readonly onSessionInvalid?: () => void
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.sessionKey = sessionKey;
  }

  private sign(body: Record<string, string>) {
    const bodySignature = Object.keys(body)
      .sort()
      .map((key) => `${key}${body[key]}`)
      .join("");
    return crypto
      .createHash("md5")
      .update(bodySignature + this.apiSecret, "utf8")
      .digest("hex");
  }

  private modifyClientForLastFMError(error: any) {
    if (error === LastFMErrorCode.InvalidSessionKey && this.sessionKey) {
      this.sessionKey = undefined;
      this.onSessionInvalid?.();
    }

    if (error === LastFMErrorCode.APIKeySuspended) {
      log.warn("lastfm: api key suspended forbidding any future requests to lastfm");
      this.apiKeySuspended = true;
    }
  }

  private getRetryDelay(response: Response, attempt: number) {
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }

      const retryDate = Date.parse(retryAfter);
      if (Number.isFinite(retryDate)) {
        return Math.max(0, retryDate - Date.now());
      }
    }

    // Fallthrough to backoff retries
    const base = Math.min(1000 * 2 ** attempt, 60000);
    return base + Math.random() * Math.min(base * 0.2, 1000);
  }

  /**
   * Calls the Last.fm API. Rate limits, 5xx responses, Last.fm's own "try again" codes and
   * network failures are retried up to `maxAttempts` times with backoff. Any other error is
   * thrown at once with the Last.fm error code as `cause`.
   */
  private async call(method: string, params: Record<string, unknown> = {}, authenticated = true, maxAttempts = 5) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.apiKeySuspended) {
        const error = new Error("LastFM API key suspended");
        error.cause = LastFMErrorCode.APIKeySuspended;
        throw error;
      }

      const body: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined) body[key] = String(value);
      }
      body.method = method;
      body.api_key = this.apiKey;
      if (authenticated) {
        if (!this.sessionKey) {
          const error = new Error("LastFM session key missing");
          error.cause = LastFMErrorCode.InvalidSessionKey;
          throw error;
        }
        body.sk = this.sessionKey;
      }
      body.api_sig = this.sign(body);
      body.format = "json";

      let response: Response;
      let data: any;
      try {
        response = await fetch(LASTFM_ENDPOINT, {
          method: "POST",
          body: new URLSearchParams(body),
          signal: AbortSignal.timeout(15 * 1000),
          headers: {
            "User-Agent": `YTMDesktop/${app.getVersion()} (https://github.com/ytmdesktop/ytmdesktop)`
          }
        });
        data = await response.json();
      } catch (err) {
        // Offline, DNS failure, timeout or a non-JSON body: all worth another try later
        lastError = err;
        if (attempt + 1 < maxAttempts) await sleep(Math.min(1000 * 2 ** attempt, 60000));
        continue;
      }

      if (data.error) {
        this.modifyClientForLastFMError(data.error);

        const error = new Error(data.message || "LastFM returned an error");
        error.cause = data.error;

        const rateLimited = response.status === 429 || data.error == LastFMErrorCode.RateLimitExceeded;
        const transientFailure = (response.status >= 500 && response.status <= 599) || isTransientLastFMError(data.error);
        if ((rateLimited || transientFailure) && attempt + 1 < maxAttempts) {
          lastError = error;
          await sleep(this.getRetryDelay(response, attempt));
          continue;
        }

        throw error;
      }

      return data;
    }

    const error = new Error(`LastFM request failed after ${maxAttempts} attempt(s)`);
    error.cause = lastError;
    throw error;
  }

  public async getToken() {
    const data = await this.call("auth.getToken", {}, false);
    return data.token;
  }

  public async getSession(token: string): Promise<string> {
    const data = await this.call("auth.getSession", { token }, false);
    this.sessionKey = data.session.key;
    return this.sessionKey!;
  }

  /** The logged-in user's Last.fm username. */
  public async getUserName(): Promise<string | null> {
    const data = await this.call("user.getInfo", {}, true, 2);
    return typeof data?.user?.name === "string" ? data.user.name : null;
  }

  public hasSession() {
    return !!this.sessionKey;
  }

  public async updateNowPlaying(params: LastFMUpdateNowPlayingParams) {
    // Last.fm asks clients not to retry failed now playing updates
    await this.call("track.updateNowPlaying", params, true, 1);
  }

  /**
   * Scrobbles up to 50 plays in one request. Returns, in order, Last.fm's ignore code for
   * each play (0 = accepted). Codes: 1 artist ignored, 2 track ignored, 3 too old,
   * 4 too new, 5 daily scrobble limit reached.
   */
  public async scrobbleBatch(plays: LastFMScrobbleParams[]): Promise<number[]> {
    if (plays.length === 0) return [];
    if (plays.length > 50) throw new Error("LastFM accepts at most 50 scrobbles per request");

    const params: Record<string, unknown> = {};
    plays.forEach((play, i) => {
      for (const [key, value] of Object.entries(play)) {
        if (value === null || value === undefined) continue;
        params[`${key}[${i}]`] = typeof value === "boolean" ? (value ? 1 : 0) : value;
      }
    });

    const data = await this.call("track.scrobble", params);
    const results = data?.scrobbles?.scrobble;
    const list = Array.isArray(results) ? results : results ? [results] : [];
    return plays.map((_, i) => Number(list[i]?.ignoredMessage?.code ?? 0) || 0);
  }

  public async love(artist: string, track: string) {
    await this.call("track.love", { artist, track });
  }

  public async unlove(artist: string, track: string) {
    await this.call("track.unlove", { artist, track });
  }

  /**
   * Last.fm's own spelling of a track, when it knows a better one. Returns null when
   * there is no correction.
   */
  public async getCorrection(artist: string, track: string): Promise<{ artist: string; track: string } | null> {
    const data = await this.call("track.getCorrection", { artist, track }, false, 2);
    const corrected = data?.corrections?.correction?.track;
    const name = corrected?.name;
    const artistName = corrected?.artist?.name;
    if (typeof name !== "string" || typeof artistName !== "string" || !name || !artistName) return null;
    if (name === track && artistName === artist) return null;
    return { artist: artistName, track: name };
  }
}

export function isTransientLastFMError(code: unknown) {
  return [LastFMErrorCode.OperationFailed, LastFMErrorCode.ServiceOffline, LastFMErrorCode.ServiceTemporarilyUnvailable, LastFMErrorCode.RateLimitExceeded].includes(
    code as LastFMErrorCode
  );
}
