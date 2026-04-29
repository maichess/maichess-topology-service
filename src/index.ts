import 'dotenv/config';
import http from 'http';
import express from 'express';
import { errorMiddleware } from './middleware/error';
import { createWsServer, broadcastActivity, broadcastHealth } from './ws/server';
import { bootstrapGraph, startTail } from './tail';
import { getKnownServices, getHealthSnapshot, registerService } from './health';
import { addNode, addEdge } from './graph';
import { discoverGraphFromDocker } from './docker';

const app = express();
const httpServer = http.createServer(app);

app.use(errorMiddleware);

const PORT = process.env.PORT ?? '3001';
httpServer.listen(Number(PORT), () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

createWsServer(httpServer);

async function startup() {
  // Step 1: Pre-populate graph from Docker — discovers all running maichess services
  // and their connections from existing env var URLs. Zero config required.
  try {
    const discovered = await discoverGraphFromDocker();
    for (const node of discovered.nodes) {
      addNode(node);
      registerService(node);
    }
    for (const edge of discovered.edges) {
      // Ensure both endpoints exist as nodes (e.g. 'client' is edge-only)
      addNode(edge.source);
      addNode(edge.target);
      addEdge(edge.source, edge.target);
    }
    console.log(
      `Docker discovery: ${discovered.nodes.length} nodes, ${discovered.edges.length} edges`,
    );
  } catch (err) {
    console.warn('Docker graph discovery failed — falling back to span-only mode:', err);
  }

  // Step 2: Enrich graph with edges observed from recent span history
  await bootstrapGraph();

  // Step 3: Tail the span file for live updates
  startTail((span) => {
    broadcastActivity(span);
  });

  // Step 4: Broadcast health every 5 seconds for all known services
  setInterval(() => {
    for (const service of getKnownServices()) {
      getHealthSnapshot(service)
        .then(({ status, errorRate }) => {
          broadcastHealth(service, status, errorRate);
        })
        .catch((err: unknown) => {
          console.error(`Health check failed for ${service}:`, err);
        });
    }
  }, 5_000);
}

startup().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
