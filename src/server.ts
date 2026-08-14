import http from 'http';
import cluster from 'cluster';
import os from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import app from './app';

const PORT = process.env.PORT || 3000;

// Create HTTP Server
const server = http.createServer(app);

// Initialize WebSocket Server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  console.log('[WS] Browser client connected for live synchronization');
  
  ws.send(JSON.stringify({ type: 'WELCOME', message: 'WebSocket synchronized successfully' }));
  
  ws.on('close', () => {
    console.log('[WS] Browser client disconnected');
  });
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Define global broadcast function to prevent circular imports
(global as any).broadcastLiveEvent = (type: string, data: any) => {
  const payload = JSON.stringify({ type, data, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
};

// Node.js process clustering scaling in production
if (process.env.NODE_ENV === 'production') {
  if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    console.log(`[CLUSTER] Primary process ${process.pid} running. Forking ${numCPUs} CPU cores...`);
    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }
    cluster.on('exit', (worker) => {
      console.warn(`[CLUSTER] Worker ${worker.process.pid} crashed. Restarting process thread...`);
      cluster.fork();
    });
  } else {
    server.listen(PORT, () => {
      console.log(`[INFO] Worker process ${process.pid} listening on port ${PORT}`);
    });
  }
} else {
  server.listen(PORT, () => {
    console.log(`[INFO] Development HTTP/WS Server running on port ${PORT}`);
  });
}
