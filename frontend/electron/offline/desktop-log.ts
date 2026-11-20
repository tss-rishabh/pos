import { app } from 'electron';
import { desktopRecord, type DesktopLogEvent } from './events';
import { jsonlSink, type JsonlSink } from './log-sink';

let sink: JsonlSink | null = null;
let currentUser: () => string | null = () => null;

/**
 * The desktop main-process log: rotating, size-capped JSON Lines in the OS log folder
 * (`app.getPath('logs')`: `~/Library/Logs/Retail POS` on macOS, `%APPDATA%\Retail POS\logs` on
 * Windows). Installed builds discard stdout, so stdout is used only in unpackaged development.
 */
function desktopSink(): JsonlSink {
  sink ??= jsonlSink({ directory: app.getPath('logs'), stdout: !app.isPackaged });
  return sink;
}

/** The signed-in operator whose ID every line carries (null before sign-in). */
export function setDesktopLogUser(provider: () => string | null) {
  currentUser = provider;
}

/** Log one registered desktop event. Never throws. */
export function desktopLog(event: DesktopLogEvent) {
  try {
    let userId: string | null = null;
    try {
      userId = currentUser();
    } catch {
      userId = null;
    }
    desktopSink().write(desktopRecord(event, { userId, now: Date.now() }));
  } catch {
    /* Logging never breaks the app. */
  }
}

export function closeDesktopLog() {
  sink?.close();
  sink = null;
}
