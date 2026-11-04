import { parseUsageEvent } from '@usage-metering/shared';
import type { Log } from './ports.js';

const MAX_LOGGED_PAYLOAD = 200;

/**
 * Handles one raw pub/sub message: logs valid usage.recorded events, warns on
 * malformed ones. Never throws, so a bad message can't take the subscriber down.
 */
export function createUsageEventHandler(log: Log): (raw: string) => void {
  return (raw) => {
    try {
      const result = parseUsageEvent(raw);
      if (result.ok) {
        log.info({ event: result.event }, 'usage.recorded');
        return;
      }
      log.warn(
        { reason: result.reason, payload: raw.slice(0, MAX_LOGGED_PAYLOAD) },
        'ignored malformed usage event',
      );
    } catch (err) {
      log.error({ err }, 'unexpected error handling usage event');
    }
  };
}
