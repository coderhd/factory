import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FactoryError } from '../domain/errors';
import type { ArtifactStore } from '../state/store';

/**
 * E3.2 per-Task worktree isolation (spec §15/§17). Worktree isolation is
 * mandatory for implementation Tasks: every Task executes on its own branch,
 * worktree and baseCommit. This module shells out to `git`; it never touches
 * the Factory's own repository (tests use OS temp dirs — Ruling R5).
 */

export interface TaskWorktree {
  taskId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
}

export interface WorktreeManager {
  createTaskWorktree(taskId: string, repoPath: string): TaskWorktree;
  removeTaskWorktree(task: TaskWorktree, evidence: ArtifactStore): void;
}

export interface WorktreeManagerConfig {
  rootDir: string;
  baseBranch: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The main repo that owns a worktree, discovered from the worktree itself. */
function repoOf(worktreePath: string): string {
  const commonDir = git(
    ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    worktreePath,
  );
  return dirname(commonDir);
}

/**
 * The WorktreeManager façade: `branch + worktree + baseCommit` per Task.
 * `baseCommit` is resolved from `baseBranch` at assign time.
 */
export function createWorktreeManager(config: WorktreeManagerConfig): WorktreeManager {
  const { rootDir, baseBranch } = config;

  return {
    createTaskWorktree(taskId, repoPath): TaskWorktree {
      const baseCommit = git(['rev-parse', baseBranch], repoPath);
      const branch = `factory/task-${taskId}`;
      const worktreePath = join(rootDir, taskId);

      if (existsSync(worktreePath)) {
        throw new FactoryError('WORKTREE_EXISTS', `worktree already exists: ${worktreePath}`);
      }
      mkdirSync(rootDir, { recursive: true });
      git(['worktree', 'add', '-b', branch, worktreePath, baseCommit], repoPath);

      return { taskId, branch, worktreePath, baseCommit };
    },

    removeTaskWorktree(task, evidence): void {
      // Evidence-preserving cleanup (spec §18.4): keep the diff before removing.
      if (existsSync(task.worktreePath)) {
        try {
          const diff = git(['-C', task.worktreePath, 'diff', 'HEAD'], task.worktreePath);
          if (diff.length > 0) evidence.put(`${task.taskId}/diff.patch`, diff);
        } catch {
          // A diff that cannot be read must not block cleanup.
        }
      }

      const repoPath = repoOf(task.worktreePath);
      git(['worktree', 'remove', '--force', task.worktreePath], repoPath);
      git(['branch', '-D', task.branch], repoPath);
    },
  };
}
