import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
  createTaskWorktree(taskId: string, workOrderId: string, repoPath: string): TaskWorktree;
  removeTaskWorktree(task: TaskWorktree, evidence: ArtifactStore): void;
}

/**
 * The Factory branch namespace for a Task's worktree (E9.1 ruling RE5): the
 * E3 worktree, E6 PR and the E7 embedded `repo.write`/`branch.create` scope
 * (`wo-&#42;/&#42;&#42;`) must agree on one prefix, so policy can authorize exactly the
 * branches the Factory writes. `taskShort` is the deterministic 8-char id
 * prefix — enough to disambiguate while keeping ref names readable.
 */
export function taskWorktreeBranch(taskId: string, workOrderId: string): string {
  return `wo-${workOrderId}/task-${taskId.slice(0, 8)}`;
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
  // `--git-common-dir` may be relative on older git; resolve it ourselves rather
  // than relying on `--path-format=absolute` (git ≥ 2.31).
  const commonDir = git(['-C', worktreePath, 'rev-parse', '--git-common-dir'], worktreePath);
  const absolute = isAbsolute(commonDir) ? commonDir : resolve(worktreePath, commonDir);
  return dirname(absolute);
}

/**
 * The WorktreeManager façade: `branch + worktree + baseCommit` per Task.
 * `baseCommit` is resolved from `baseBranch` at assign time.
 */
export function createWorktreeManager(config: WorktreeManagerConfig): WorktreeManager {
  const { rootDir, baseBranch } = config;

  return {
    createTaskWorktree(taskId, workOrderId, repoPath): TaskWorktree {
      const baseCommit = git(['rev-parse', baseBranch], repoPath);
      const branch = taskWorktreeBranch(taskId, workOrderId);
      const worktreePath = join(rootDir, taskId);

      // A leftover worktree/branch from a crashed assignment must not starve
      // this Task forever (F-E3.2-5): clean the stale artefacts, then retry.
      // The uncommitted diff of a crashed run is E7's §18.4 recovery concern.
      if (existsSync(worktreePath)) {
        try {
          git(['worktree', 'remove', '--force', worktreePath], repoPath);
        } catch {
          // Not a registered worktree for this repo (crash mid-add): drop the dir.
          rmSync(worktreePath, { recursive: true, force: true });
        }
      }
      try {
        git(['worktree', 'prune'], repoPath);
      } catch {
        // Prune is best-effort; a registration pointing at a missing path is inert.
      }
      try {
        git(['branch', '-D', branch], repoPath);
      } catch {
        // The branch may not exist; that is the normal first-create path.
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
