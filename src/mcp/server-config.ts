import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

export interface RepoEntryDir {
  name: string;
  type: 'dir';
  path: string;
  readOnly?: boolean;
}

export interface RepoEntryGit {
  name: string;
  type: 'git';
  url: string;
  branch?: string;
  readOnly?: boolean;
}

export type RepoEntry = RepoEntryDir | RepoEntryGit;

export interface ServerConfig {
  host?: string;
  port?: number;
  dataDir?: string;
  repos: RepoEntry[];
}

export function getDefaultConfigPath(): string {
  return resolve(homedir(), '.codegraph', 'server.json');
}

export function loadServerConfig(configPath?: string): ServerConfig {
  const filePath = configPath ?? getDefaultConfigPath();
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Config file not found: ${filePath}`);
    }
    throw new Error(`Failed to read config file: ${filePath} — ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${filePath}`);
  }

  const config = parsed as Record<string, unknown>;

  if (!Array.isArray(config.repos) || config.repos.length === 0) {
    throw new Error(`Config file must have a non-empty "repos" array: ${filePath}`);
  }

  const repos: RepoEntry[] = [];
  for (const repo of config.repos) {
    if (typeof repo !== 'object' || repo === null) {
      throw new Error(`Each entry in "repos" must be an object`);
    }
    if (typeof repo.name !== 'string' || repo.name.length === 0) {
      throw new Error(`Each repo entry must have a non-empty "name" field`);
    }
    if (repo.type !== 'git' && repo.type !== 'dir') {
      throw new Error(`Repo "${repo.name}" must have type "git" or "dir"`);
    }

    if (repo.type === 'git') {
      if (typeof repo.url !== 'string' || repo.url.length === 0) {
        throw new Error(`Git repo "${repo.name}" must have a non-empty "url" field`);
      }
      repos.push({
        name: repo.name,
        type: 'git',
        url: repo.url,
        branch: typeof repo.branch === 'string' ? repo.branch : undefined,
        readOnly: repo.readOnly ?? false,
      });
    } else {
      if (typeof repo.path !== 'string' || repo.path.length === 0) {
        throw new Error(`Dir repo "${repo.name}" must have a non-empty "path" field`);
      }
      repos.push({
        name: repo.name,
        type: 'dir',
        path: resolve(repo.path),
        readOnly: repo.readOnly ?? false,
      });
    }
  }

  const defaultDataDir = resolve(homedir(), '.codegraph', 'repos');

  return {
    host: typeof config.host === 'string' ? config.host : '0.0.0.0',
    port: typeof config.port === 'number' ? config.port : 3100,
    dataDir: typeof config.dataDir === 'string' ? resolve(config.dataDir) : defaultDataDir,
    repos,
  };
}
