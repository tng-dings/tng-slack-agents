import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceManager, workspaceIdentity } from "../src/workspace.js";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function repositoryFixture(prefix: string): Promise<{ root: string; repository: string; worktreeRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const repository = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktrees");
  git("init", repository);
  git("-C", repository, "config", "user.email", "test@example.invalid");
  git("-C", repository, "config", "user.name", "Agent Runner Test");
  await writeFile(path.join(repository, "README.md"), "fixture");
  git("-C", repository, "add", "README.md");
  git("-C", repository, "commit", "-m", "fixture");
  return { root, repository, worktreeRoot };
}

test("workspace identity centralizes deterministic directory and branch names", () => {
  const first = workspaceIdentity("slack:T1:D1:100.1");
  const second = workspaceIdentity("slack:T1:D1:100.1");
  assert.deepEqual(first, second);
  assert.match(first.hash, /^[0-9a-f]{20}$/);
  assert.equal(first.directoryName, first.hash);
  assert.equal(first.branchName, `agent-runner/${first.hash}`);
});

test("workspace manager creates, removes, and reattaches a deterministic session branch", async () => {
  const { root, repository, worktreeRoot } = await repositoryFixture("agent-runner-workspace-branch-");
  const sessionKey = "slack:T1:D1:100.1";
  const identity = workspaceIdentity(sessionKey);
  const manager = new WorkspaceManager(repository, worktreeRoot);
  const sourceHead = git("-C", repository, "rev-parse", "HEAD");

  const prepared = await manager.prepare(sessionKey);
  assert.equal(path.basename(prepared), identity.directoryName);
  assert.equal(git("-C", prepared, "branch", "--show-current"), identity.branchName);
  assert.equal(git("-C", prepared, "rev-parse", "HEAD"), sourceHead);
  assert.equal(await readFile(path.join(prepared, "README.md"), "utf8"), "fixture");
  assert.equal(await manager.prepare(sessionKey, prepared), prepared);

  await writeFile(path.join(prepared, "RESULT.md"), "session result");
  git("-C", prepared, "add", "RESULT.md");
  git("-C", prepared, "commit", "-m", "session result");
  const sessionHead = git("-C", prepared, "rev-parse", "HEAD");
  assert.notEqual(sessionHead, sourceHead);
  assert.equal(git("-C", repository, "rev-parse", "HEAD"), sourceHead);

  await manager.cleanup(prepared);
  await assert.rejects(readFile(path.join(prepared, "README.md"), "utf8"), /ENOENT/);
  assert.equal(git("-C", repository, "show-ref", "--verify", `refs/heads/${identity.branchName}`).length > 0, true);

  const reattached = await manager.prepare(sessionKey, prepared);
  assert.equal(reattached, prepared);
  assert.equal(git("-C", reattached, "branch", "--show-current"), identity.branchName);
  assert.equal(git("-C", reattached, "rev-parse", "HEAD"), sessionHead);
  assert.equal(await readFile(path.join(reattached, "RESULT.md"), "utf8"), "session result");

  await manager.cleanup(reattached);
  await rm(root, { recursive: true, force: true });
});

test("workspace manager recovers a branch left registered at a missing expected directory", async () => {
  const { root, repository, worktreeRoot } = await repositoryFixture("agent-runner-workspace-stale-");
  const sessionKey = "slack:T1:D1:stale";
  const identity = workspaceIdentity(sessionKey);
  const manager = new WorkspaceManager(repository, worktreeRoot);
  const prepared = await manager.prepare(sessionKey);

  await rm(prepared, { recursive: true, force: true });
  const recovered = await manager.prepare(sessionKey, prepared);
  assert.equal(recovered, prepared);
  assert.equal(git("-C", recovered, "branch", "--show-current"), identity.branchName);

  await manager.cleanup(recovered);
  await rm(root, { recursive: true, force: true });
});

test("workspace manager fails safely when the expected branch is checked out elsewhere", async () => {
  const { root, repository, worktreeRoot } = await repositoryFixture("agent-runner-workspace-collision-");
  const sessionKey = "slack:T1:D1:collision";
  const identity = workspaceIdentity(sessionKey);
  const manager = new WorkspaceManager(repository, worktreeRoot);
  const prepared = await manager.prepare(sessionKey);
  await manager.cleanup(prepared);

  const otherWorktree = path.join(root, "operator-worktree");
  git("-C", repository, "worktree", "add", otherWorktree, identity.branchName);
  await assert.rejects(
    manager.prepare(sessionKey, prepared),
    /Expected branch is already checked out in another worktree/,
  );

  git("-C", repository, "worktree", "remove", otherWorktree);
  await rm(root, { recursive: true, force: true });
});

test("workspace manager does not adopt an existing detached worktree", async () => {
  const { root, repository, worktreeRoot } = await repositoryFixture("agent-runner-workspace-detached-");
  const sessionKey = "slack:T1:D1:detached";
  const target = path.join(worktreeRoot, workspaceIdentity(sessionKey).directoryName);
  const manager = new WorkspaceManager(repository, worktreeRoot);
  git("-C", repository, "worktree", "add", "--detach", target, "HEAD");

  await assert.rejects(manager.prepare(sessionKey, target), /Worktree is detached; expected branch/);

  git("-C", repository, "worktree", "remove", target);
  await rm(root, { recursive: true, force: true });
});

test("retention cleanup preserves dirty worktrees and never deletes their branches", async () => {
  const { root, repository, worktreeRoot } = await repositoryFixture("agent-runner-workspace-dirty-");
  const sessionKey = "slack:T1:D1:dirty";
  const identity = workspaceIdentity(sessionKey);
  const manager = new WorkspaceManager(repository, worktreeRoot);
  const prepared = await manager.prepare(sessionKey);
  const untracked = path.join(prepared, "unfinished.txt");
  await writeFile(untracked, "unfinished");

  await assert.rejects(manager.cleanup(prepared), /Refusing to remove a dirty worktree/);
  assert.equal(await readFile(untracked, "utf8"), "unfinished");
  assert.equal(git("-C", repository, "show-ref", "--verify", `refs/heads/${identity.branchName}`).length > 0, true);

  await rm(untracked);
  await manager.cleanup(prepared);
  assert.equal(git("-C", repository, "show-ref", "--verify", `refs/heads/${identity.branchName}`).length > 0, true);
  await rm(root, { recursive: true, force: true });
});
