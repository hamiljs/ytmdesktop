import { app } from 'electron';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import log from 'electron-log';

import Integration from '../integration';
import PlayerStateStore from '../../services/playerstatestore';
import ProtectedAPIManager from '../../services/protectedapimanager';
import MemoryStore from '../../services/memorystore';
import { MemoryStoreSchema } from '~shared/store/schema';
import { VideoState } from '~shared/playerstatestore/types';

// The call app can drop the mic for a moment (switching devices, a reconnect). Wait this
// long after the last call app lets go before the music comes back.
const RESUME_DELAY_MS = 5000;
const RESPAWN_DELAY_MS = 10000;

/**
 * Pauses the music when a call starts and resumes it when the call ends, but only if
 * this integration was the one that paused it. The `callwatch` helper (Rust, in
 * native/callwatch) watches which apps use the microphone and prints a line on change.
 */
export default class CallPause extends Integration {
  public name = 'CallAutoPause';
  public storeEnableProperty: Integration['storeEnableProperty'] =
    'integrations.callAutoPauseEnabled';

  private child: ChildProcessWithoutNullStreams | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private inCall = false;
  private pausedByUs = false;

  public onSetup() {}

  public onEnabled() {
    if (process.platform !== 'darwin') return;
    this.startHelper();
  }

  public onDisabled() {
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.respawnTimer = this.resumeTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.inCall = false;
    this.pausedByUs = false;
    this.getService(MemoryStore<MemoryStoreSchema>).set(
      'callInProgress',
      false,
    );
  }

  private helperPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'callwatch')
      : path.join(
          app.getAppPath(),
          'native',
          'callwatch',
          'target',
          'release',
          'callwatch',
        );
  }

  private startHelper() {
    const helper = this.helperPath();
    if (!fs.existsSync(helper)) {
      log.warn(`call auto-pause: helper not found at ${helper}, feature off`);
      return;
    }

    // Optional list of your own apps that count as calls, one bundle id prefix per line
    const extraApps = path.join(
      app.getPath('userData'),
      'callwatch-extra-apps.txt',
    );
    const args = fs.existsSync(extraApps) ? ['--extra-apps', extraApps] : [];
    const child = spawn(helper, args, { stdio: 'pipe' });
    this.child = child;
    readline
      .createInterface({ input: child.stdout })
      .on('line', (line) => this.onLine(line));
    child.stderr.on('data', (data) =>
      log.warn(`call auto-pause: helper: ${String(data).trim()}`),
    );
    child.on('exit', (code) => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      log.warn(
        `call auto-pause: helper exited with code ${code}, restarting in ${RESPAWN_DELAY_MS / 1000}s`,
      );
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        if (this.isEnabled) this.startHelper();
      }, RESPAWN_DELAY_MS);
    });
  }

  private onLine(line: string) {
    let message: { inCall: boolean; apps: string[] };
    try {
      message = JSON.parse(line);
    } catch {
      log.warn(`call auto-pause: unreadable helper line: ${line}`);
      return;
    }

    if (message.inCall) this.callStarted(message.apps);
    else this.callEnded();
  }

  private callStarted(apps: string[]) {
    if (this.resumeTimer) {
      // The mic came back before the resume delay ran out: same call, keep paused
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (this.inCall) return;
    this.inCall = true;
    this.getService(MemoryStore<MemoryStoreSchema>).set('callInProgress', true);

    const state = this.getService(PlayerStateStore).getState();
    if (
      state.trackState === VideoState.Playing ||
      state.trackState === VideoState.Buffering
    ) {
      this.remoteControl('pause');
      this.pausedByUs = true;
      log.info(`call auto-pause: call started (${apps.join(', ')}), paused`);
    } else {
      log.info(
        `call auto-pause: call started (${apps.join(', ')}), nothing playing`,
      );
    }
  }

  private callEnded() {
    if (!this.inCall || this.resumeTimer) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.inCall = false;
      this.getService(MemoryStore<MemoryStoreSchema>).set(
        'callInProgress',
        false,
      );
      if (!this.pausedByUs) return;
      this.pausedByUs = false;

      // If the user started the music again during the call, leave it alone
      const state = this.getService(PlayerStateStore).getState();
      if (state.trackState === VideoState.Paused) {
        this.remoteControl('play');
        log.info('call auto-pause: call ended, resumed');
      }
    }, RESUME_DELAY_MS);
  }

  private remoteControl(command: 'play' | 'pause') {
    this.getService(ProtectedAPIManager)
      .createOrGetAPI('RemoteControl')
      .postMessage('execute', command);
  }
}
