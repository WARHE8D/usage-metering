import { APP_NAME } from '@usage-metering/shared';

export function startupMessage(service: string): string {
  return `${APP_NAME} ${service} starting`;
}
