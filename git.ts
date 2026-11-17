// Git smart HTTP: placeholder until the protocol lands; claims no routes yet.
import type { Ctx, SendJson, SendRaw } from './app.ts';

export function handleGit(_ctx: Ctx, _segments: string[], _sendRaw: SendRaw, _sendJson: SendJson): boolean {
  return false;
}
