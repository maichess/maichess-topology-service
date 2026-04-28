import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getGraph } from '../graph';
import { ParsedSpan } from '../spans';

const clients = new Set<WebSocket>();

export function createWsServer(httpServer: http.Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);

    ws.send(JSON.stringify({ type: 'init', graph: getGraph() }));

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  console.log('WebSocket server listening on /ws');
}

export function broadcastActivity(span: ParsedSpan): void {
  const message = JSON.stringify({
    type: 'activity',
    traceId: span.traceId,
    source: span.source,
    target: span.target,
    rpcMethod: span.rpcMethod,
    status: span.status,
    duration: span.duration,
  });
  broadcast(message);
}

export function broadcastHealth(service: string, status: string, errorRate: number): void {
  broadcast(JSON.stringify({ type: 'health', service, status, errorRate }));
}

function broadcast(message: string): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
