import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { unprivilegedChildEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);
const gitOptions = { env: unprivilegedChildEnvironment() };

export interface WorkspaceIdentity {
  hash: string;
  directoryName: string;
  branchName: string;
}

export function workspaceIdentity(sessionKey: string): WorkspaceIdentity {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 20);
  return {
    hash,
    directoryName: hash,
    branchName: `agent-runner/${hash}`,
  };
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function isMissingGitRef(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 1;
}

interface WorktreeRegistration {
  path: string;
  branchRef: string | null;
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  let worktreePath: string | undefined;
  let branchRef: string | null = null;
  const finish = () => {
    if (worktreePath) registrations.push({ path: worktreePath, branchRef });
    worktreePath = undefined;
    branchRef = null;
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      finish();
    } else if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branchRef = line.slice("branch ".length);
    }
  }
  finish();
  return registrations;
}

export class WorkspaceManager {
  constructor(
    private readonly sourceRepository: string,
    private readonly worktreeRoot: string,
  ) {}

  async prepare(sessionKey: string, existingDirectory?: string | null): Promise<string> {
    const sourceRoot = await this.sourceRoot();
    await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "--verify", "HEAD"], gitOptions);
    await mkdir(this.worktreeRoot, { recursive: true });
    const realRoot = await realpath(this.worktreeRoot);
    const identity = workspaceIdentity(sessionKey);
    const target = await this.assertInsideRoot(path.resolve(realRoot, identity.directoryName));
    const expectedBranchRef = `refs/heads/${identity.branchName}`;

    if (existingDirectory) {
      const existingTarget = await exists(existingDirectory)
        ? await this.assertInsideRoot(await realpath(existingDirectory))
        : await this.assertInsideRoot(path.resolve(existingDirectory));
      if (!samePath(existingTarget, target)) {
        throw new Error(`Persisted worktree directory does not match the expected session directory: ${existingDirectory}`);
      }
    }

    if (await exists(target)) {
      const realTarget = await this.assertInsideRoot(await realpath(target));
      if (!samePath(realTarget, target)) {
        throw new Error(`Worktree target resolves outside its expected session directory: ${target}`);
      }
      if (await exists(path.join(realTarget, ".git"))) {
        await this.assertManagedWorktree(sourceRoot, realTarget);
        await this.assertExpectedBranch(realTarget, expectedBranchRef);
        return realTarget;
      }
      const entries = await readdir(realTarget);
      if (entries.length > 0) throw new Error(`Worktree target already exists and is not a Git worktree: ${target}`);
    }

    await this.clearStaleExpectedRegistration(sourceRoot, target, expectedBranchRef);
    const registered = await this.registrationForBranch(sourceRoot, expectedBranchRef);
    if (registered) {
      throw new Error(`Expected branch is already checked out in another worktree: ${registered.path}`);
    }

    if (await this.localBranchExists(sourceRoot, expectedBranchRef)) {
      await execFileAsync("git", ["-C", sourceRoot, "worktree", "add", target, identity.branchName], gitOptions);
    } else {
      await execFileAsync("git", ["-C", sourceRoot, "worktree", "add", "-b", identity.branchName, target, "HEAD"], gitOptions);
    }
    const preparedTarget = await this.assertInsideRoot(await realpath(target));
    await this.assertManagedWorktree(sourceRoot, preparedTarget);
    await this.assertExpectedBranch(preparedTarget, expectedBranchRef);
    return preparedTarget;
  }

  async cleanup(workingDirectory: string): Promise<void> {
    const target = await this.assertInsideRoot(
      (await exists(workingDirectory)) ? await realpath(workingDirectory) : path.resolve(workingDirectory),
    );
    const sourceRoot = await this.sourceRoot();
    if (!(await exists(target))) {
      await execFileAsync("git", ["-C", sourceRoot, "worktree", "prune", "--expire", "now"], gitOptions);
      return;
    }
    await this.assertManagedWorktree(sourceRoot, target);
    const status = (await execFileAsync(
      "git",
      ["-C", target, "status", "--porcelain=v1", "--untracked-files=all"],
      gitOptions,
    )).stdout;
    if (status.length > 0) {
      throw new Error(`Refusing to remove a dirty worktree during retention cleanup: ${target}`);
    }
    await execFileAsync("git", ["-C", sourceRoot, "worktree", "remove", target], gitOptions);
  }

  private async sourceRoot(): Promise<string> {
    return (await execFileAsync(
      "git",
      ["-C", this.sourceRepository, "rev-parse", "--show-toplevel"],
      gitOptions,
    )).stdout.trim();
  }

  private async localBranchExists(sourceRoot: string, branchRef: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["-C", sourceRoot, "show-ref", "--verify", "--quiet", branchRef], gitOptions);
      return true;
    } catch (error) {
      if (isMissingGitRef(error)) return false;
      throw error;
    }
  }

  private async registrationForBranch(sourceRoot: string, branchRef: string): Promise<WorktreeRegistration | undefined> {
    const output = (await execFileAsync("git", ["-C", sourceRoot, "worktree", "list", "--porcelain"], gitOptions)).stdout;
    return parseWorktreeRegistrations(output).find((registration) => registration.branchRef === branchRef);
  }

  private async clearStaleExpectedRegistration(sourceRoot: string, target: string, branchRef: string): Promise<void> {
    const registered = await this.registrationForBranch(sourceRoot, branchRef);
    if (!registered || !samePath(registered.path, target) || await exists(path.join(target, ".git"))) return;
    if (await exists(target)) {
      const entries = await readdir(target);
      if (entries.length > 0) return;
      await rmdir(target);
    }
    await execFileAsync("git", ["-C", sourceRoot, "worktree", "prune", "--expire", "now"], gitOptions);
  }

  private async assertExpectedBranch(candidate: string, expectedBranchRef: string): Promise<void> {
    let actualBranchRef: string;
    try {
      actualBranchRef = (await execFileAsync(
        "git",
        ["-C", candidate, "symbolic-ref", "--quiet", "HEAD"],
        gitOptions,
      )).stdout.trim();
    } catch (error) {
      if (isMissingGitRef(error)) {
        throw new Error(`Worktree is detached; expected branch ${expectedBranchRef}: ${candidate}`);
      }
      throw error;
    }
    if (actualBranchRef !== expectedBranchRef) {
      throw new Error(`Worktree uses ${actualBranchRef}; expected ${expectedBranchRef}: ${candidate}`);
    }
  }

  private async assertManagedWorktree(sourceRoot: string, candidate: string): Promise<void> {
    const targetRoot = (await execFileAsync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], gitOptions)).stdout.trim();
    const sourceCommon = path.resolve(sourceRoot, (await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "--git-common-dir"], gitOptions)).stdout.trim());
    const targetCommon = path.resolve(candidate, (await execFileAsync("git", ["-C", candidate, "rev-parse", "--git-common-dir"], gitOptions)).stdout.trim());
    if (!samePath(targetRoot, candidate) || !samePath(sourceCommon, targetCommon)) {
      throw new Error(`Worktree target is not owned by the configured source repository: ${candidate}`);
    }
  }

  private async assertInsideRoot(candidate: string): Promise<string> {
    const root = await realpath(this.worktreeRoot);
    const target = path.resolve(candidate);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Refusing to access a worktree outside the configured worktree root");
    }
    return target;
  }
}
