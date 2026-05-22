import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import CodeGraph from '../index';
import type { RepoEntry } from './server-config';

export class RepoManager {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  async prepareRepo(entry: RepoEntry): Promise<string> {
    if (entry.type === 'dir') {
      await this.ensureInitialized(entry.path);
      return entry.path;
    }

    const localPath = resolve(this.dataDir, entry.name);

    if (!existsSync(localPath)) {
      process.stderr.write(`[codegraph] Cloning ${entry.url} → ${localPath}\n`);
      const branchArg = entry.branch ? `--branch ${entry.branch}` : '';
      execSync(`git clone --depth 1 ${branchArg} ${entry.url} ${localPath}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    await this.ensureInitialized(localPath);
    return localPath;
  }

  async checkAndSync(entry: RepoEntry, localPath: string, cg: CodeGraph): Promise<boolean> {
    if (entry.type !== 'git') return false;

    try {
      execSync('git fetch', { cwd: localPath, stdio: 'pipe' });
      const status = execSync('git status -uno', { cwd: localPath, encoding: 'utf8' });

      if (status.includes('behind')) {
        process.stderr.write(`[codegraph] Pulling updates for "${entry.name}"\n`);
        execSync('git pull', { cwd: localPath, stdio: 'pipe' });
        await cg.sync();
        process.stderr.write(`[codegraph] Synced "${entry.name}"\n`);
        return true;
      }
    } catch (err) {
      process.stderr.write(`[codegraph] Update check failed for "${entry.name}": ${(err as Error).message}\n`);
    }
    return false;
  }

  private async ensureInitialized(localPath: string): Promise<void> {
    if (CodeGraph.isInitialized(localPath)) return;

    process.stderr.write(`[codegraph] Initializing index for ${localPath}\n`);
    const cg = await CodeGraph.init(localPath, { index: true });
    cg.close();
    process.stderr.write(`[codegraph] Index complete for ${localPath}\n`);
  }
}
