"""
Launcher-owned ComfyUI updater using pygit2.

Performs git operations only — no pip/uv installs, no self-update logic.
The launcher handles requirements sync separately.

Usage: python update_comfyui.py <repo_path> [--stable]

Outputs structured markers that the launcher can parse:
  [BACKUP_BRANCH] <name>
  [PRE_UPDATE_HEAD] <sha>
  [POST_UPDATE_HEAD] <sha>
  [CHECKED_OUT_TAG] <tag>
"""

import os
import pygit2
from datetime import datetime
import sys


def pull(repo, ident, remote_name="origin", branch="master"):
    remote_ref = repo.lookup_reference("refs/remotes/%s/%s" % (remote_name, branch))
    remote_id = remote_ref.target
    merge_result, _ = repo.merge_analysis(remote_id)

    if merge_result & pygit2.GIT_MERGE_ANALYSIS_UP_TO_DATE:
        print("Already up to date.")
        return

    if merge_result & pygit2.GIT_MERGE_ANALYSIS_FASTFORWARD:
        repo.checkout_tree(repo.get(remote_id))
        try:
            local_ref = repo.lookup_reference("refs/heads/%s" % branch)
            local_ref.set_target(remote_id)
        except KeyError:
            repo.create_branch(branch, repo.get(remote_id))
        repo.head.set_target(remote_id)
        return

    if merge_result & pygit2.GIT_MERGE_ANALYSIS_NORMAL:
        repo.merge(remote_id)
        if repo.index.conflicts is not None:
            for conflict in repo.index.conflicts:
                entry = next((x for x in conflict if x is not None), None)
                print("Conflict in: %s" % (entry.path if entry else "unknown"))
            raise RuntimeError("Merge conflicts detected. Aborting.")
        tree = repo.index.write_tree()
        repo.create_commit(
            "HEAD", ident, ident, "Merge!",
            tree, [repo.head.target, remote_id],
        )
        repo.state_cleanup()
        return

    raise RuntimeError("Unknown merge analysis result")


def find_latest_stable_tag(repo):
    versions = []
    for ref_name in repo.references:
        prefix = "refs/tags/v"
        if ref_name.startswith(prefix):
            try:
                parts = tuple(map(int, ref_name[len(prefix):].split(".")))
                versions.append((parts, ref_name))
            except (ValueError, IndexError):
                pass
    versions.sort()
    return versions[-1][1] if versions else None


def main():
    if len(sys.argv) < 2:
        print("Usage: python update_comfyui.py <repo_path> [--stable]")
        sys.exit(1)

    repo_path = os.path.abspath(sys.argv[1].rstrip("/\\"))
    stable = "--stable" in sys.argv

    pygit2.option(pygit2.GIT_OPT_SET_OWNER_VALIDATION, 0)

    git_dir = os.path.join(repo_path, '.git')

    # Ensure required .git subdirectories exist — archive extraction
    # can drop empty directories (e.g. refs/) which libgit2 requires.
    for sub in ['refs/heads', 'refs/tags', 'refs/remotes']:
        os.makedirs(os.path.join(git_dir, sub), exist_ok=True)
    repo = None
    errors = []
    for candidate in [git_dir, repo_path]:
        try:
            repo = pygit2.Repository(candidate)
            break
        except Exception as e:
            errors.append("  %s -> %s" % (candidate, e))
    if repo is None:
        # Last resort: forward-slash path (libgit2 sometimes prefers it)
        try:
            repo = pygit2.Repository(git_dir.replace("\\", "/"))
        except Exception as e:
            errors.append("  %s -> %s" % (git_dir.replace("\\", "/"), e))
    if repo is None:
        print("Error: could not open git repository at %s" % repo_path)
        for err in errors:
            print(err)
        print(".git contents: %s" % os.listdir(git_dir))
        sys.exit(1)
    ident = pygit2.Signature("comfyui", "comfy@ui")

    # Emit pre-update HEAD
    pre_head = str(repo.head.target)
    print("[PRE_UPDATE_HEAD] %s" % pre_head)

    # Stash local changes
    print("Stashing current changes…")
    did_stash = False
    try:
        repo.stash(ident)
        did_stash = True
    except KeyError:
        print("Nothing to stash.")
    except Exception:
        print("Could not stash, cleaning index and trying again.")
        repo.state_cleanup()
        repo.index.read_tree(repo.head.peel().tree)
        repo.index.write()
        try:
            repo.stash(ident)
            did_stash = True
        except KeyError:
            print("Nothing to stash.")

    # Create backup branch
    backup_name = "backup_branch_%s" % datetime.today().strftime("%Y-%m-%d_%H_%M_%S")
    print("Creating backup branch: %s" % backup_name)
    try:
        repo.branches.local.create(backup_name, repo.head.peel())
        print("[BACKUP_BRANCH] %s" % backup_name)
    except Exception:
        print("Warning: could not create backup branch.")

    # Fetch master from origin (handles shallow/single-branch clones)
    print("Fetching from origin…")
    for remote in repo.remotes:
        if remote.name == "origin":
            refspecs = ["+refs/heads/master:refs/remotes/origin/master"]
            if stable:
                refspecs.append("+refs/tags/*:refs/tags/*")
            remote.fetch(refspecs)
            break

    # Checkout master — create local branch if needed
    print("Checking out master branch…")
    branch = repo.lookup_branch("master")
    if branch is None:
        ref = repo.lookup_reference("refs/remotes/origin/master")
        repo.create_branch("master", repo.get(ref.target))
    ref = repo.lookup_reference("refs/heads/master")
    repo.checkout(ref)

    # Pull latest (fast-forward or merge against already-fetched origin/master)
    print("Pulling latest changes…")
    pull(repo, ident)

    # Checkout stable tag if requested
    if stable:
        tag = find_latest_stable_tag(repo)
        if tag is not None:
            print("Checking out stable tag: %s" % tag)
            repo.checkout(tag)
            tag_name = tag.replace("refs/tags/", "")
            print("[CHECKED_OUT_TAG] %s" % tag_name)
        else:
            print("No stable tags found, staying on master.")

    # Restore stashed changes
    if did_stash:
        print("Restoring stashed changes…")
        try:
            repo.stash_pop()
            print("Stashed changes restored successfully.")
        except Exception as e:
            print("Could not restore stashed changes (conflicts likely): %s" % e)
            print("Your changes are still saved in the stash — run 'git stash pop' manually to recover them.")

    # Emit post-update HEAD
    post_head = str(repo.head.target)
    print("[POST_UPDATE_HEAD] %s" % post_head)

    print("Done!")


if __name__ == "__main__":
    main()
