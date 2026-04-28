import 'dotenv/config';
import http from 'http';
import express from 'express';
import { errorMiddleware } from './middleware/error';
import { createWsServer, broadcastActivity, broadcastHealth } from './ws/server';
import { bootstrapGraph } from './tail';
import { startTail } from './tail';
import { getKnownServices, getHealthSnapshot } from './health';

const app = express();
const httpServer = http.createServer(app);

app.use(errorMiddleware);

const PORT = process.env.PORT ?? '3001';
httpServer.listen(Number(PORT), () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

createWsServer(httpServer);

bootstrapGraph().then(() => {
  startTail((span) => {
    broadcastActivity(span);
  });

  setInterval(() => {
    for (const service of getKnownServices()) {
      getHealthSnapshot(service).then(({ status, errorRate }) => {
        broadcastHealth(service, status, errorRate);
      }).catch((err: unknown) => {
        console.error(`Health check failed for ${service}:`, err);
      });
    }
  }, 5_000);
}).catch((err: unknown) => {
  console.error('Failed to bootstrap graph:', err);
  process.exit(1);
});
