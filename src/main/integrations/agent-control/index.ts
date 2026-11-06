import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import log from 'electron-log';

import Integration from '../integration';
import MemoryStore from '../../services/memorystore';
import PlayerStateStore from '../../services/playerstatestore';
import ProtectedAPIManager from '../../services/protectedapimanager';
import { MemoryStoreSchema } from '~shared/store/schema';
import {
  LikeStatus,
  PlayerQueueItem,
  PlayerState,
  VideoState,
} from '~shared/playerstatestore/types';

declare const LASTFM_API_KEY: string | null | undefined;

/**
 * HDC fork: a local control socket for agents (the `ytm` CLI in native/ytm-cli).
 *
 * Path: <userData>/agent.sock, file mode 0600, so only this macOS user can connect. No
 * token and no network port: anything that can open the file already runs as you.
 *
 * Protocol: one JSON object per line in, one per line out.
 *   {"cmd":"state"}                                -> {"ok":true,"result":{...}}
 *   {"cmd":"search","query":"bicep glue","filter":"songs","limit":5}
 *   {"cmd":"play","videoId":"...","playlistId":"..."}   (both optional: no ids = resume)
 *   {"cmd":"queueAdd","videoId":"...","position":"next"|"end"|<index>}
 *   {"cmd":"lastfm","method":"user.getTopArtists","params":{"period":"1month"}}
 * Send {"cmd":"help"} for the full list.
 */

const SIMPLE_COMMANDS = [
  'pause',
  'playPause',
  'next',
  'previous',
  'toggleLike',
  'toggleDislike',
  'shuffle',
  'mute',
  'unmute',
] as const;

// Read-only Last.fm methods agents may call. user.* methods default to the logged-in user.
const LASTFM_READ_METHODS = new Set([
  'user.getInfo',
  'user.getRecentTracks',
  'user.getTopArtists',
  'user.getTopTracks',
  'user.getTopAlbums',
  'user.getTopTags',
  'user.getLovedTracks',
  'user.getWeeklyTrackChart',
  'user.getWeeklyArtistChart',
  'user.getWeeklyChartList',
  'artist.getInfo',
  'artist.getSimilar',
  'artist.getTopTracks',
  'artist.getTopTags',
  'track.getInfo',
  'track.getSimilar',
  'track.getTopTags',
  'album.getInfo',
  'tag.getTopTracks',
  'tag.getTopArtists',
  'tag.getSimilar',
  'chart.getTopTracks',
  'chart.getTopArtists',
]);

const HELP = {
  commands: {
    state: 'current track, play state, volume and the upcoming queue',
    play: '{videoId?, playlistId?} play a video or playlist; with no ids, resume',
    pause: 'pause',
    playPause: 'toggle',
    next: 'next track',
    previous: 'previous track',
    toggleLike: 'thumbs up (also loves it on Last.fm)',
    toggleDislike: 'thumbs down',
    shuffle: 'toggle shuffle',
    mute: 'mute',
    unmute: 'unmute',
    volume: '{value: 0-100}',
    seek: '{seconds}',
    queueAdd:
      "{videoId | playlistId, position?: 'next' | 'end' | index} (default 'end')",
    search:
      '{query, filter?: songs|videos|albums|playlists|all (default songs), limit?: 1-50}',
    createPlaylist:
      '{title, description?, privacy?: PRIVATE|UNLISTED|PUBLIC (default PRIVATE), videoIds?} new playlist; no videoIds = the current queue',
    addToPlaylist:
      '{playlistId, videoIds} add songs to a playlist (skips ones already in it)',
    playlists: "your library's playlists with their ids",
    lastfmLogin:
      "open Last.fm's approval page; the login finishes by itself after you allow it",
    lastfm: `{method, params?} read-only Last.fm call; methods: ${[...LASTFM_READ_METHODS].join(', ')}`,
  },
};

class AgentError extends Error {}

export default class AgentControl extends Integration {
  public name = 'AgentControl';
  public storeEnableProperty: Integration['storeEnableProperty'] =
    'integrations.agentControlEnabled';

  private server: net.Server | null = null;

  public onSetup() {}

  public onEnabled() {
    if (process.platform === 'win32' || this.server) return;
    const socketPath = this.socketPath();
    try {
      fs.unlinkSync(socketPath); // left over from a crash
    } catch {
      // not there
    }

    const server = net.createServer((socket) => this.onConnection(socket));
    server.on('error', (err) => log.error('agent control: socket error', err));
    // Restrict before listen so the socket is never briefly world-connectable
    const oldMask = process.umask(0o177);
    try {
      server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        log.info(`agent control: listening on ${socketPath}`);
      });
    } finally {
      process.umask(oldMask);
    }
    this.server = server;
  }

  public onDisabled() {
    this.server?.close();
    this.server = null;
    try {
      fs.unlinkSync(this.socketPath());
    } catch {
      // already gone
    }
  }

  private socketPath() {
    return path.join(app.getPath('userData'), 'agent.sock');
  }

  private onConnection(socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    readline.createInterface({ input: socket }).on('line', async (line) => {
      if (!line.trim()) return;
      let reply: object;
      try {
        const request = JSON.parse(line);
        if (!request || typeof request.cmd !== 'string')
          throw new AgentError(
            'send {"cmd": "..."}; {"cmd":"help"} lists them',
          );
        reply = { ok: true, result: await this.handle(request) };
      } catch (err) {
        if (!(err instanceof AgentError) && !(err instanceof SyntaxError))
          log.warn('agent control: command failed', err);
        reply = { ok: false, error: (err as Error)?.message ?? String(err) };
      }
      if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\n');
    });
  }

  private remote(command: string, ...args: unknown[]) {
    this.getService(ProtectedAPIManager)
      .createOrGetAPI('RemoteControl')
      .postMessage('execute', command, ...args);
  }

  private async handle(request: any): Promise<unknown> {
    const state = this.getService(PlayerStateStore).getState();
    const cmd: string = request.cmd;

    if ((SIMPLE_COMMANDS as readonly string[]).includes(cmd)) {
      this.remote(cmd);
      return { done: cmd };
    }

    switch (cmd) {
      case 'help':
        return HELP;

      case 'state':
        return this.describeState(state);

      case 'play': {
        const { videoId, playlistId } = request;
        if (!videoId && !playlistId) {
          this.remote('play');
          return { done: 'play' };
        }
        this.remote('navigate', {
          watchEndpoint: {
            videoId: videoId ?? undefined,
            playlistId: playlistId ?? undefined,
          },
        });
        return {
          done: 'play',
          videoId: videoId ?? null,
          playlistId: playlistId ?? null,
        };
      }

      case 'volume': {
        const value = Number(request.value);
        if (!Number.isFinite(value) || value < 0 || value > 100)
          throw new AgentError('volume needs value 0-100');
        this.remote('setVolume', Math.round(value));
        return { done: 'volume', value: Math.round(value) };
      }

      case 'seek': {
        const seconds = Number(request.seconds);
        const duration = state.videoDetails?.durationSeconds ?? Infinity;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration)
          throw new AgentError(`seek needs seconds 0-${duration}`);
        this.remote('seekTo', seconds);
        return { done: 'seek', seconds };
      }

      case 'queueAdd': {
        const { videoId, playlistId } = request;
        if (!videoId === !playlistId)
          throw new AgentError(
            'queueAdd needs exactly one of videoId or playlistId',
          );
        const items = state.queue?.items.length ?? 0;
        let index: number;
        if (request.position === undefined || request.position === 'end')
          index = items;
        else if (request.position === 'next')
          index = (state.queue?.selectedItemIndex ?? -1) + 1;
        else index = Number(request.position);
        if (!Number.isInteger(index) || index < 0 || index > items)
          throw new AgentError(`position must be "next", "end" or 0-${items}`);
        this.remote('queueAdd', { videoId, playlistId, index });
        return { done: 'queueAdd', index };
      }

      case 'search': {
        if (typeof request.query !== 'string' || !request.query.trim())
          throw new AgentError('search needs a query');
        return this.page('search', {
          query: request.query,
          filter: request.filter ?? 'songs',
          limit: request.limit ?? 10,
        });
      }

      case 'createPlaylist': {
        // No videoIds = save the whole current queue
        let videoIds: unknown = request.videoIds;
        if (videoIds === undefined) {
          videoIds = (state.queue?.items ?? [])
            .map((item) => item?.videoId)
            .filter(Boolean);
          if ((videoIds as string[]).length === 0)
            throw new AgentError('the queue is empty; pass videoIds');
        }
        return this.page('createPlaylist', {
          title: request.title,
          description: request.description ?? '',
          privacy: request.privacy ?? 'PRIVATE',
          videoIds,
        });
      }

      case 'addToPlaylist':
        return this.page('addToPlaylist', {
          playlistId: request.playlistId,
          videoIds: request.videoIds,
        });

      case 'playlists':
        return this.page('playlists', {});

      case 'lastfm':
        return this.lastfm(request.method, request.params ?? {});

      case 'lastfmLogin': {
        // Same path as the Settings button. Opens Last.fm's approval page in the browser;
        // the app finishes the login by itself once the user allows it there.
        const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);
        if (memoryStore.get('lastFMAuthenticationStep') === 2) {
          return { done: 'lastfmLogin', alreadyLoggedIn: true };
        }
        memoryStore.set('lastFMAuthenticationStep', 0);
        ipcMain.emit('lastfm:authenticate');
        return {
          done: 'lastfmLogin',
          next: 'approve the app on the Last.fm page that just opened',
        };
      }

      default:
        throw new AgentError(
          `unknown command "${cmd}"; {"cmd":"help"} lists them`,
        );
    }
  }

  /** Runs a request inside the YouTube Music page (renderer/ytmview/scripts/setup/agent.ts). */
  private async page(name: string, args: object): Promise<unknown> {
    const api = this.getService(ProtectedAPIManager).createOrGetAPI('Agent');
    let response: any;
    try {
      [response] = await api.invokeMessage(name, args);
    } catch {
      throw new AgentError(
        'YouTube Music did not answer in 30 s (is the page loaded?)',
      );
    }
    if (!response?.ok)
      throw new AgentError(response?.error ?? `${name} failed`);
    return response.result;
  }

  private describeState(state: PlayerState) {
    const d = state.videoDetails;
    const queue = state.queue;
    const brief = (item: PlayerQueueItem | null) =>
      item
        ? {
            videoId: item.videoId,
            title: item.title,
            artist: item.author,
            duration: item.duration,
          }
        : null;
    const selected = queue?.selectedItemIndex ?? -1;
    return {
      playing: state.trackState === VideoState.Playing,
      trackState: VideoState[state.trackState] ?? 'Unknown',
      track: d
        ? {
            videoId: d.id,
            title: d.title,
            artist: d.author,
            album: d.album,
            durationSeconds: d.durationSeconds,
            progressSeconds: Math.round(state.videoProgress),
            liked: d.likeStatus === LikeStatus.Like,
            disliked: d.likeStatus === LikeStatus.Dislike,
          }
        : null,
      playlistId: state.playlistId,
      volume: state.volume,
      muted: state.muted,
      adPlaying: state.adPlaying,
      queue: queue
        ? {
            index: selected,
            shuffle: queue.shuffleEnabled,
            autoplay: queue.autoplay,
            length: queue.items.length,
            upNext: queue.items.slice(selected + 1, selected + 26).map(brief),
            recent: queue.items
              .slice(Math.max(0, selected - 10), Math.max(0, selected))
              .map(brief),
          }
        : null,
    };
  }

  private async lastfm(requested: unknown, params: Record<string, unknown>) {
    const method = typeof requested === 'string' ? requested : '';
    if (!LASTFM_READ_METHODS.has(method)) {
      throw new AgentError(
        `lastfm method must be one of: ${[...LASTFM_READ_METHODS].join(', ')}`,
      );
    }
    if (typeof LASTFM_API_KEY !== 'string' || !LASTFM_API_KEY)
      throw new AgentError('this build has no Last.fm API key');

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) query.set(key, String(value));
    }
    if (method.startsWith('user.') && !query.has('user')) {
      const user = this.getService(MemoryStore<MemoryStoreSchema>).get(
        'lastFMUsername',
      );
      if (!user)
        throw new AgentError(
          'not logged in to Last.fm (or username not known yet); pass params.user',
        );
      query.set('user', String(user));
    }
    query.set('method', method);
    query.set('api_key', LASTFM_API_KEY);
    query.set('format', 'json');

    const response = await fetch(
      `https://ws.audioscrobbler.com/2.0/?${query}`,
      {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': `YTMDesktop/${app.getVersion()} (HDC fork; agent control)`,
        },
      },
    );
    const data = await response.json();
    if (data?.error)
      throw new AgentError(`Last.fm error ${data.error}: ${data.message}`);
    return data;
  }
}
