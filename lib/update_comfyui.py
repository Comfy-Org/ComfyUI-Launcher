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

import pygit2
from datetime import datetime
import sys


def pull(repo, remote_name="origin", branch="master"):
    for remote in repo.remotes:
        if remote.name == remote_name:
            remote.fetch()
            remote_ref = repo.lookup_reference("refs/remotes/origin/%s" % branch)
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
                        print("Conflict in: %s" % conflict[0].path)
                    raise RuntimeError("Merge conflicts detected. Aborting.")
                user = repo.default_signature
                tree = repo.index.write_tree()
                repo.create_commit(
                    "HEAD", user, user, "Merge!",
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
                parts = list(map(int, ref_name[len(prefix):].split(".")))
                score = parts[0] * 10000000000 + parts[1] * 100000 + parts[2]
                versions.append((score, ref_name))
            except (ValueError, IndexError):
                pass
    versions.sort()
    return versions[-1][1] if versions else None


def main():
    if len(sys.argv) < 2:
        print("Usage: python update_comfyui.py <repo_path> [--stable]")
        sys.exit(1)

    repo_path = sys.argv[1].rstrip("/\\")
    stable = "--stable" in sys.argv

    pygit2.option(pygit2.GIT_OPT_SET_OWNER_VALIDATION, 0)
    repo = pygit2.Repository(repo_path)
    ident = pygit2.Signature("comfyui", "comfy@ui")

    # Emit pre-update HEAD
    pre_head = str(repo.head.target)
    print("[PRE_UPDATE_HEAD] %s" % pre_head)

    # Stash local changes
    print("Stashing current changes…")
    try:
        repo.stash(ident)
    except KeyError:
        print("Nothing to stash.")
    except Exception:
        print("Could not stash, cleaning index and trying again.")
        repo.state_cleanup()
        repo.index.read_tree(repo.head.peel().tree)
        repo.index.write()
        try:
            repo.stash(ident)
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

    # Checkout master
    print("Checking out master branch…")
    branch = repo.lookup_branch("master")
    if branch is None:
        try:
            ref = repo.lookup_reference("refs/remotes/origin/master")
        except KeyError:
            print("Fetching from origin…")
            for remote in repo.remotes:
                if remote.name == "origin":
                    remote.fetch()
            ref = repo.lookup_reference("refs/remotes/origin/master")
        repo.checkout(ref)
        branch = repo.lookup_branch("master")
        if branch is None:
            repo.create_branch("master", repo.get(ref.target))
    else:
        ref = repo.lookup_reference(branch.name)
        repo.checkout(ref)

    # Pull latest
    print("Pulling latest changes…")
    pull(repo)

    # Checkout stable tag if requested
    if stable:
        tag = find_latest_stable_tag(repo)
        if tag is not None:
            print("Checking out stable tag: %s" % tag)
            repo.checkout(tag)
            print("[CHECKED_OUT_TAG] %s" % tag)
        else:
            print("No stable tags found, staying on master.")

    # Emit post-update HEAD
    post_head = str(repo.head.target)
    print("[POST_UPDATE_HEAD] %s" % post_head)

    print("Done!")


if __name__ == "__main__":
    main()
