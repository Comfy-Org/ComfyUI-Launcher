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

    # Emit pre-update HEAD
    pre_head = str(repo.head.target)
    print("[PRE_UPDATE_HEAD] %s" % pre_head)

    # Clean any leftover merge/rebase state from a previous failed update
    repo.state_cleanup()

    # Create backup branch so local modifications can be recovered manually.
    # If there are uncommitted changes in the working tree, commit them onto
    # the backup branch so they are not lost when the hard reset runs.
    backup_name = "backup_branch_%s" % datetime.today().strftime("%Y-%m-%d_%H_%M_%S")
    print("Creating backup branch: %s" % backup_name)
    try:
        repo.branches.local.create(backup_name, repo.head.peel())
        print("[BACKUP_BRANCH] %s" % backup_name)
        repo.index.add_all()
        repo.index.write()
        if repo.index.diff_to_tree(repo.head.peel().tree):
            tree = repo.index.write_tree()
            ident = pygit2.Signature("comfyui", "comfy@ui")
            backup_ref = "refs/heads/%s" % backup_name
            repo.create_commit(
                backup_ref, ident, ident,
                "Backup of uncommitted changes before update",
                tree, [repo.head.target],
            )
            print("Uncommitted changes saved to backup branch.")
    except Exception:
        print("Warning: could not create backup branch.")

    # Fetch master from origin (handles shallow/single-branch clones)
    print("Fetching from origin…")
    for remote in repo.remotes:
        if remote.name == "origin":
            refspecs = ["+refs/heads/master:refs/remotes/origin/master"]
            if stable:
                refspecs.append("+refs/tags/*:refs/tags/*")
            try:
                remote.fetch(refspecs)
            except Exception as e:
                print("[ERROR] Failed to fetch from origin: %s" % e)
                print("Check your internet connection and try again.")
                sys.exit(1)
            break

    # Hard-reset master to origin/master.
    # Launcher-managed installations should not have local modifications to
    # tracked files. Using a hard reset instead of merge/stash avoids merge
    # conflicts and stash-pop conflict markers that can corrupt working-tree
    # files (see issue #245).
    print("Resetting to origin/master…")
    remote_ref = repo.lookup_reference("refs/remotes/origin/master")
    remote_id = remote_ref.target
    branch = repo.lookup_branch("master")
    if branch is None:
        repo.create_branch("master", repo.get(remote_id))
    else:
        branch.set_target(remote_id)
    ref = repo.lookup_reference("refs/heads/master")
    repo.checkout(ref, strategy=pygit2.GIT_CHECKOUT_FORCE)
    repo.reset(remote_id, pygit2.GIT_RESET_HARD)

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

    # Emit post-update HEAD
    post_head = str(repo.head.target)
    print("[POST_UPDATE_HEAD] %s" % post_head)

    print("Done!")


if __name__ == "__main__":
    main()
