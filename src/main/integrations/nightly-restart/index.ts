import { app } from 'electron';
import log from 'electron-log';

import Integration from '../integration';
import PlayerStateStore from '../../services/playerstatestore';
import StateManager from '../../services/statemanager';
import { VideoState } from '~shared/playerstatestore/types';

const CHECK_EVERY_MS = 5 * 60 * 1000;
// Restart between 04:00 and 04:59 local time
const RESTART_HOUR = 4;
// Never restart an app that only just started
const MIN_UPTIME_MS = 6 * 60 * 60 * 1000;

/**
 * YouTube Music's web page grows in memory the longer it runs. Once a night, while
 * nothing is playing, restart the app. "Continue where you left off" brings back the
 * last song, paused. If music is playing at 4 am, skip that night.
 */
export default class NightlyRestart extends Integration {
  public name = 'NightlyRestart';
  public storeEnableProperty: Integration['storeEnableProperty'] =
    'integrations.nightlyRestartEnabled';

  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  public onSetup() {}

  public onEnabled() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  public onDisabled() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private check() {
    if (new Date().getHours() !== RESTART_HOUR) return;
    if (Date.now() - this.startedAt < MIN_UPTIME_MS) return;

    const state = this.getService(PlayerStateStore).getState();
    if (
      state.trackState === VideoState.Playing ||
      state.trackState === VideoState.Buffering
    )
      return;

    log.info(
      `nightly restart: up ${Math.round((Date.now() - this.startedAt) / 3600000)}h and idle, restarting`,
    );
    this.getService(StateManager).forceWrite();
    app.relaunch();
    app.quit();
  }
}
