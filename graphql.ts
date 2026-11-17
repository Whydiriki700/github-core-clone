// GraphQL v4: placeholder until the schema lands.
import type { ServerResponse } from 'node:http';
import type { Ctx, SendJson } from './app.ts';

export function handleGraphQL(ctx: Ctx, sendJson: SendJson): void {
  const res: ServerResponse = ctx.res;
  sendJson(res, 404, { message: 'Not Found' });
}
