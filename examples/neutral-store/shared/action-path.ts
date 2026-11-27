import type { Operation } from './api.ts';

/**
 * The request path of one starter action. Every client and command builds action paths here, and only here. This
 * module imports no package, so `./lifecycle` can use it before `npm ci`.
 */
export function actionPath(operation: Operation): string {
  return `/api/actions/${operation}`;
}
