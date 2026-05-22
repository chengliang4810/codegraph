import CodeGraph from '../index';
import { tools, ToolHandler } from './tools';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { HttpSseTransport } from './http-transport';
import { RepoManager } from './repo-manager';
import type { ServerConfig, RepoEntry } from './server-config';
import { ErrorCodes } from './transport';
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse } from './transport';

const SERVER_INFO = {
  name: 'codegraph',
  version: '0.1.0',
};

const PROTOCOL_VERSION = '2024-11-05';

const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

interface LoadedRepo {
  entry: RepoEntry;
  localPath: string;
  cg: CodeGraph;
}

export class HttpMCPServer {
  private transport: HttpSseTransport;
  private toolHandler: ToolHandler;
  private config: ServerConfig;
  private loadedRepos: LoadedRepo[] = [];
  private repoManager: RepoManager;
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
    this.toolHandler = new ToolHandler(null);
    this.transport = new HttpSseTransport({
      host: config.host,
      port: config.port,
    });
    this.repoManager = new RepoManager(config.dataDir!);
  }

  async start(): Promise<void> {
    for (const entry of this.config.repos) {
      try {
        const localPath = await this.repoManager.prepareRepo(entry);
        const cg = await CodeGraph.open(localPath, { readOnly: entry.readOnly });
        this.loadedRepos.push({ entry, localPath, cg });
        this.toolHandler.registerProject(entry.name, cg);
        process.stderr.write(`[codegraph] Ready: ${entry.name} (${localPath})\n`);
      } catch (err) {
        process.stderr.write(`[codegraph] Failed to load "${entry.name}": ${(err as Error).message}\n`);
      }
    }

    if (this.loadedRepos.length > 0) {
      this.toolHandler.setDefaultCodeGraph(this.loadedRepos[0]!.cg);
    }

    await this.transport.start(this.handleMessage.bind(this));
    process.stderr.write(`[codegraph] HTTP+SSE server listening on ${this.config.host ?? '0.0.0.0'}:${this.config.port ?? 3100}\n`);
    process.stderr.write(`[codegraph] ${this.loadedRepos.length} repo(s) available\n`);

    this.startUpdateChecker();
  }

  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    this.transport.stop();
    this.toolHandler.closeAll();
    for (const { cg } of this.loadedRepos) {
      cg.close();
    }
    this.loadedRepos = [];
  }

  private startUpdateChecker(): void {
    const gitRepos = this.loadedRepos.filter(r => r.entry.type === 'git');
    if (gitRepos.length === 0) return;

    this.updateTimer = setInterval(async () => {
      for (const repo of gitRepos) {
        await this.repoManager.checkAndSync(repo.entry, repo.localPath, repo.cg);
      }
    }, UPDATE_INTERVAL_MS);
    this.updateTimer.unref();
  }

  private async handleMessage(
    message: JsonRpcRequest | JsonRpcNotification,
    _sessionId: string
  ): Promise<JsonRpcResponse | null> {
    const isRequest = 'id' in message;

    switch (message.method) {
      case 'initialize':
        if (isRequest) return this.handleInitialize(message as JsonRpcRequest);
        return null;

      case 'initialized':
        return null;

      case 'tools/list':
        if (isRequest) return this.handleToolsList(message as JsonRpcRequest);
        return null;

      case 'tools/call':
        if (isRequest) return await this.handleToolsCall(message as JsonRpcRequest);
        return null;

      case 'ping':
        if (isRequest) {
          return { jsonrpc: '2.0', id: (message as JsonRpcRequest).id, result: {} };
        }
        return null;

      default:
        if (isRequest) {
          return {
            jsonrpc: '2.0',
            id: (message as JsonRpcRequest).id,
            error: { code: ErrorCodes.MethodNotFound, message: `Method not found: ${message.method}` },
          };
        }
        return null;
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    const projects = this.toolHandler.listProjects();
    const repoList = projects.map(p => `  - ${p.name} (${p.path})`).join('\n');
    const instructions = SERVER_INSTRUCTIONS + `\n\nAvailable repositories:\n${repoList}\n\nUse the "projectPath" parameter with the repo name to query a specific repository.`;

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions,
      },
    };
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: this.toolHandler.getTools() },
    };
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as { name: string; arguments?: Record<string, unknown> } | undefined;

    if (!params?.name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: ErrorCodes.InvalidParams, message: 'Missing tool name' },
      };
    }

    const tool = tools.find(t => t.name === params.name);
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: ErrorCodes.InvalidParams, message: `Unknown tool: ${params.name}` },
      };
    }

    const result = await this.toolHandler.execute(params.name, params.arguments ?? {});
    return { jsonrpc: '2.0', id: request.id, result };
  }
}
