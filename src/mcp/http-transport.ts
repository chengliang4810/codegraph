import * as http from 'http';
import { randomUUID } from 'crypto';
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse } from './transport';

export type SessionMessageHandler = (
  message: JsonRpcRequest | JsonRpcNotification,
  sessionId: string
) => Promise<JsonRpcResponse | null>;

interface SSESession {
  id: string;
  res: http.ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

export interface HttpTransportOptions {
  host?: string;
  port?: number;
}

export class HttpSseTransport {
  private server: http.Server | null = null;
  private sessions: Map<string, SSESession> = new Map();
  private handler: SessionMessageHandler | null = null;
  private host: string;
  private port: number;

  constructor(options: HttpTransportOptions = {}) {
    this.host = options.host ?? '0.0.0.0';
    this.port = options.port ?? 3100;
  }

  async start(handler: SessionMessageHandler): Promise<void> {
    this.handler = handler;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => resolve());
      this.server!.on('error', reject);
    });
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      clearInterval(session.heartbeat);
      session.res.end();
    }
    this.sessions.clear();
    this.server?.close();
    this.server = null;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  sendToSession(sessionId: string, data: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      this.handleSSE(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !this.sessions.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
        return;
      }
      this.handlePost(req, res, sessionId);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: this.sessions.size }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleSSE(res: http.ServerResponse): void {
    const sessionId = randomUUID();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const heartbeat = setInterval(() => {
      res.write(':ping\n\n');
    }, 30000);

    const session: SSESession = { id: sessionId, res, heartbeat };
    this.sessions.set(sessionId, session);

    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.sessions.delete(sessionId);
    });
  }

  private handlePost(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      res.writeHead(202, { 'Content-Type': 'text/plain' });
      res.end('Accepted');

      if (this.handler) {
        const response = await this.handler(parsed as JsonRpcRequest | JsonRpcNotification, sessionId);
        if (response) {
          this.sendToSession(sessionId, response);
        }
      }
    });
  }
}
