import fs from 'node:fs';
import crypto from 'node:crypto';
import log from 'electron-log';
import LastFMClient, {
  LastFMErrorCode,
  LastFMScrobbleParams,
  isTransientLastFMError,
} from './last-fm-client';

// Last.fm drops scrobbles whose timestamp is more than 14 days old
const MAX_SCROBBLE_AGE_SECONDS = 14 * 24 * 60 * 60;
const MAX_ENTRIES = 5000;
const FLUSH_INTERVAL_MS = 60 * 1000;

// Ignore codes from track.scrobble: 5 = daily scrobble limit reached, so try again later
const IGNORED_DAILY_LIMIT = 5;

export type OutboxEntry =
  | {
      id: string;
      kind: 'scrobble';
      play: LastFMScrobbleParams;
      queuedAt: number;
    }
  | {
      id: string;
      kind: 'love' | 'unlove';
      artist: string;
      track: string;
      queuedAt: number;
    };

type NewOutboxEntry =
  | { kind: 'scrobble'; play: LastFMScrobbleParams }
  | { kind: 'love' | 'unlove'; artist: string; track: string };

/**
 * A queue on disk for every Last.fm write. A play is saved before it is sent, so it
 * survives being offline, Last.fm outages and app restarts. Entries leave the queue only
 * when Last.fm accepts them or rejects them for good.
 */
export default class LastFMOutbox {
  private entries: OutboxEntry[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly getClient: () => LastFMClient | undefined,
  ) {
    this.load();
  }

  public get size() {
    return this.entries.length;
  }

  public start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    void this.flush();
  }

  public stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public add(entry: NewOutboxEntry) {
    this.entries.push({
      ...entry,
      id: crypto.randomUUID(),
      queuedAt: Date.now(),
    } as OutboxEntry);
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.length - MAX_ENTRIES;
      this.entries.splice(0, dropped);
      log.warn(
        `lastfm outbox: over ${MAX_ENTRIES} entries, dropped the ${dropped} oldest`,
      );
    }
    this.save();
    void this.flush();
  }

  public async flush(): Promise<void> {
    if (this.flushing) return;
    const client = this.getClient();
    if (!client || !client.hasSession()) return;

    this.flushing = true;
    try {
      this.dropExpired();
      while (this.entries.length > 0) {
        const head = this.entries[0];
        const keepGoing =
          head.kind === 'scrobble'
            ? await this.sendScrobbles(client)
            : await this.sendLove(client, head);
        this.save();
        if (!keepGoing) break;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Sends the run of scrobbles at the head of the queue, up to 50. Returns false to stop flushing. */
  private async sendScrobbles(client: LastFMClient): Promise<boolean> {
    const batch: Extract<OutboxEntry, { kind: 'scrobble' }>[] = [];
    for (const entry of this.entries) {
      if (entry.kind !== 'scrobble' || batch.length === 50) break;
      batch.push(entry);
    }

    let codes: number[];
    try {
      codes = await client.scrobbleBatch(batch.map((e) => e.play));
    } catch (err) {
      return this.handleError(
        err,
        batch.map((e) => e.id),
        'scrobble',
      );
    }

    const sent = new Set<string>();
    let hitDailyLimit = false;
    batch.forEach((entry, i) => {
      const code = codes[i];
      if (code === IGNORED_DAILY_LIMIT) {
        hitDailyLimit = true;
        return;
      }
      if (code !== 0)
        log.warn(
          `lastfm outbox: Last.fm ignored scrobble "${entry.play.artist} - ${entry.play.track}" with code ${code}`,
        );
      sent.add(entry.id);
    });
    this.entries = this.entries.filter((e) => !sent.has(e.id));
    log.info(
      `lastfm outbox: sent ${sent.size} scrobble(s), ${this.entries.length} left`,
    );
    return !hitDailyLimit;
  }

  private async sendLove(
    client: LastFMClient,
    entry: Extract<OutboxEntry, { kind: 'love' | 'unlove' }>,
  ): Promise<boolean> {
    try {
      if (entry.kind === 'love') await client.love(entry.artist, entry.track);
      else await client.unlove(entry.artist, entry.track);
    } catch (err) {
      return this.handleError(err, [entry.id], entry.kind);
    }
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    log.info(
      `lastfm outbox: ${entry.kind}d "${entry.artist} - ${entry.track}"`,
    );
    return true;
  }

  /** Decides whether a failed send stays queued. Returns false to stop flushing for now. */
  private handleError(err: unknown, ids: string[], what: string): boolean {
    const code = (err as Error)?.cause;
    const retryLater =
      typeof code !== 'number' || // network failure or retries used up
      isTransientLastFMError(code) ||
      code === LastFMErrorCode.InvalidSessionKey || // wait for the user to log in again
      code === LastFMErrorCode.APIKeySuspended;
    if (retryLater) {
      log.warn(
        `lastfm outbox: ${what} failed, will retry later (${(err as Error)?.message ?? err})`,
      );
      return false;
    }

    // Last.fm rejected the request itself (bad parameters and the like): retrying cannot help
    const drop = new Set(ids);
    this.entries = this.entries.filter((e) => !drop.has(e.id));
    log.error(
      `lastfm outbox: Last.fm rejected ${what} with code ${code}, dropped ${ids.length} entry(ies)`,
      err,
    );
    return true;
  }

  private dropExpired() {
    const cutoff = Math.floor(Date.now() / 1000) - MAX_SCROBBLE_AGE_SECONDS;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.kind !== 'scrobble' || e.play.timestamp > cutoff,
    );
    if (this.entries.length !== before) {
      log.warn(
        `lastfm outbox: dropped ${before - this.entries.length} scrobble(s) older than 14 days`,
      );
      this.save();
    }
  }

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) this.entries = parsed;
      if (this.entries.length > 0)
        log.info(
          `lastfm outbox: loaded ${this.entries.length} unsent entry(ies)`,
        );
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT')
        log.error(
          'lastfm outbox: could not read queue file, starting empty',
          err,
        );
    }
  }

  private save() {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      log.error('lastfm outbox: could not write queue file', err);
    }
  }
}
