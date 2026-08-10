import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unprivilegedChildEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);
const gitOptions = { env: unprivilegedChildEnvironment() };

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class WorkspaceManager {
  constructor(
    private readonly sourceRepository: string,
    private readonly worktreeRoot: string,
  ) {}

  async prepare(sessionKey: string, existingDirectory?: string | null): Promise<string> {
    const sourceRoot = (await execFileAsync("git", ["-C", this.sourceRepository, "rev-parse", "--show-toplevel"], gitOptions)).stdout.trim();
    await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "--verify", "HEAD"], gitOptions);
    await mkdir(this.worktreeRoot, { recursive: true });
    const realRoot = await realpath(this.worktreeRoot);
    if (existingDirectory && (await exists(path.join(existingDirectory, ".git")))) {
      return this.assertManagedWorktree(sourceRoot, await this.assertInsideRoot(await realpath(existingDirectory)));
    }

    const slug = createHash("sha256").update(sessionKey).digest("hex").slice(0, 20);
    const target = path.resolve(realRoot, slug);
    const relative = path.relative(realRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Refusing to create a worktree outside the configured worktree root");
    }

    if (await exists(target)) {
      await this.assertInsideRoot(await realpath(target));
      if (await exists(path.join(target, ".git"))) {
        return this.assertManagedWorktree(sourceRoot, target);
      }
      const entries = await readdir(target);
      if (entries.length > 0) throw new Error(`Worktree target already exists and is not a Git worktree: ${target}`);
    }
    await execFileAsync("git", ["-C", sourceRoot, "worktree", "add", "--detach", target, "HEAD"], gitOptions);
    return target;
  }

  private async assertManagedWorktree(sourceRoot: string, candidate: string): Promise<string> {
    const targetRoot = (await execFileAsync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], gitOptions)).stdout.trim();
    const sourceCommon = path.resolve(sourceRoot, (await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "--git-common-dir"], gitOptions)).stdout.trim());
    const targetCommon = path.resolve(candidate, (await execFileAsync("git", ["-C", candidate, "rev-parse", "--git-common-dir"], gitOptions)).stdout.trim());
    const samePath = (left: string, right: string) => process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
    if (!samePath(path.resolve(targetRoot), path.resolve(candidate)) || !samePath(sourceCommon, targetCommon)) {
      throw new Error(`Worktree target is not owned by the configured source repository: ${candidate}`);
    }
    return candidate;
  }

  async cleanup(workingDirectory: string): Promise<void> {
    const target = await this.assertInsideRoot(
      (await exists(workingDirectory)) ? await realpath(workingDirectory) : workingDirectory,
    );
    const sourceRoot = (await execFileAsync(
      "git",
      ["-C", this.sourceRepository, "rev-parse", "--show-toplevel"],
      gitOptions,
    )).stdout.trim();
    await execFileAsync("git", ["-C", sourceRoot, "worktree", "remove", "--force", target], gitOptions);
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
