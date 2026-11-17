import { createApp } from './app.ts';
const server = createApp();
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`PORT ${typeof addr === 'object' && addr ? addr.port : 0}`);
});
