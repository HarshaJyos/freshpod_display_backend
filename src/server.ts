import http from 'http';
import app from './app';

const PORT = process.env.PORT || 3000;

// Create plain HTTP server — no WebSocket.
// Live dashboard events are delivered via SSE (/api/events) backed by MQTT.
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`[INFO] FreshPod HTTP server running on port ${PORT}`);
  console.log(`[INFO] Live events delivered via SSE at /api/events (MQTT-backed)`);
});

export default server;
