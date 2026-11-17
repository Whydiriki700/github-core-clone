// MCP endpoint: placeholder until the tools land.
import type { ServerResponse } from 'node:http';
import type { Ctx, SendJson } from './app.ts';

export function handleMcp(ctx: Ctx, sendJson: SendJson): void {
  const res: ServerResponse = ctx.res;
  sendJson(res, 404, { message: 'Not Found' });
}
