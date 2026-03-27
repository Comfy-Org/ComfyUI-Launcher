"""
pygit2-based git operations for ComfyUI Desktop 2.0 Launcher.

Provides git subcommands for standalone installs where system git is not
available.  Each subcommand prints structured output that the TypeScript
caller (src/main/lib/git.ts) can parse.

Usage: python git_operations.py <subcommand> <repo_path> [args...]

Subcommands:
  rev-parse          <repo_path> <ref>
  describe-tags      <repo_path> [commit]
  tag-list           <repo_path>
  rev-list-count     <repo_path> <tag_or_ref> [commit]
  cherry-pick-count  <repo_path> <ref1> <ref2>
  merge-base         <repo_path> <ref1> <ref2>
  is-ancestor        <repo_path> <ancestor> <descendant>
  fetch-tags         <repo_path>
  fetch-commit       <repo_path> <sha>
  clone              <url> <dest>
  checkout           <repo_path> <commit>
  fetch-and-checkout <repo_path> <commit>
  ls-remote-tags     <url>
  ls-remote-ref      <url> <ref>
"""

import os
import sys
from collections import deque

import pygit2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def open_repo(repo_path):
    """Open a pygit2 Repository, mirroring update_comfyui.py patterns."""
    repo_path = os.path.abspath(repo_path.rstrip("/\\"))
    git_dir = os.path.join(repo_path, ".git")

    # Ensure required .git subdirectories exist (archive extraction can
    # drop empty directories that libgit2 requires).
    for sub in ["refs/heads", "refs/tags", "refs/remotes"]:
        try:
            os.makedirs(os.path.join(git_dir, sub), exist_ok=True)
        except OSError:
            pass

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
        print("Error: could not open git repository at %s" % repo_path, file=sys.stderr)
        for err in errors:
            print(err, file=sys.stderr)
        sys.exit(1)

    return repo


def resolve_ref(repo, ref):
    """Resolve a ref string (tag name, branch, SHA prefix, HEAD) to an Oid."""
    if ref == "HEAD":
        return repo.head.target

    # Try refs/tags/<ref> (annotated or lightweight)
    try:
        tag_ref = repo.lookup_reference("refs/tags/%s" % ref)
        obj = tag_ref.peel(pygit2.Commit)
        return obj.id
    except (KeyError, ValueError):
        pass

    # Try refs/heads/<ref>
    try:
        branch_ref = repo.lookup_reference("refs/heads/%s" % ref)
        return branch_ref.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        pass

    # Try refs/remotes/origin/<ref>
    try:
        remote_ref = repo.lookup_reference("refs/remotes/origin/%s" % ref)
        return remote_ref.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        pass

    # Try as a full reference name
    try:
        full_ref = repo.lookup_reference(ref)
        return full_ref.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        pass

    # Try as a SHA or abbreviated SHA
    try:
        obj = repo.revparse_single(ref)
        commit = obj.peel(pygit2.Commit)
        return commit.id
    except (KeyError, ValueError):
        pass

    print("Error: could not resolve ref '%s'" % ref, file=sys.stderr)
    sys.exit(1)


def parse_version_tuple(tag_name):
    """Parse a 'vX.Y.Z' tag name into a comparable tuple, or None."""
    name = tag_name
    if name.startswith("v"):
        name = name[1:]
    try:
        return tuple(int(x) for x in name.split("."))
    except (ValueError, IndexError):
        return None


def get_origin(repo):
    """Return the 'origin' remote, or exit with an error."""
    for remote in repo.remotes:
        if remote.name == "origin":
            return remote
    print("Error: no 'origin' remote found", file=sys.stderr)
    sys.exit(1)


def build_tag_target_map(repo):
    """Build a dict mapping commit Oid -> tag name for all tags."""
    tag_map = {}
    for ref_name in repo.references:
        if ref_name.startswith("refs/tags/"):
            tag_name = ref_name[len("refs/tags/"):]
            try:
                ref = repo.lookup_reference(ref_name)
                target = ref.peel(pygit2.Commit)
                tag_map[target.id] = tag_name
            except (KeyError, ValueError):
                pass
    return tag_map


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------

def cmd_rev_parse(repo_path, ref):
    """Resolve a ref to its SHA. Print the SHA on stdout."""
    repo = open_repo(repo_path)
    oid = resolve_ref(repo, ref)
    print(str(oid))


def cmd_describe_tags(repo_path, commit="HEAD"):
    """Find the nearest ancestor tag (like git describe --tags --abbrev=0).

    Walks ancestors breadth-first, checking each commit against all tag
    targets. Prints the tag name on stdout, or exits 1 if no tags found.
    """
    repo = open_repo(repo_path)
    start_oid = resolve_ref(repo, commit)
    tag_map = build_tag_target_map(repo)

    if not tag_map:
        print("Error: no tags found in repository", file=sys.stderr)
        sys.exit(1)

    # BFS over ancestors
    visited = set()
    queue = deque([start_oid])
    while queue:
        oid = queue.popleft()
        if oid in visited:
            continue
        visited.add(oid)

        if oid in tag_map:
            print(tag_map[oid])
            return

        try:
            commit_obj = repo.get(oid)
            if commit_obj is not None and commit_obj.type == pygit2.GIT_OBJ_COMMIT:
                for parent_id in commit_obj.parent_ids:
                    if parent_id not in visited:
                        queue.append(parent_id)
        except (KeyError, ValueError):
            pass

    print("Error: no ancestor tag found", file=sys.stderr)
    sys.exit(1)


def cmd_tag_list(repo_path):
    """List all v* tags sorted by version descending (like git tag -l 'v*' --sort=-v:refname)."""
    repo = open_repo(repo_path)

    tags = []
    for ref_name in repo.references:
        if ref_name.startswith("refs/tags/v"):
            tag_name = ref_name[len("refs/tags/"):]
            version = parse_version_tuple(tag_name)
            if version is not None:
                tags.append((version, tag_name))

    tags.sort(reverse=True)
    for _, tag_name in tags:
        print(tag_name)


def cmd_rev_list_count(repo_path, tag_or_ref, commit="HEAD"):
    """Count commits between tag and commit (like git rev-list --count tag..commit).

    Walks from commit back through ancestors, stopping at the tag's commit.
    Counts how many commits are visited before reaching the tag.
    """
    repo = open_repo(repo_path)
    tag_oid = resolve_ref(repo, tag_or_ref)
    commit_oid = resolve_ref(repo, commit)

    if tag_oid == commit_oid:
        print(0)
        return

    walker = repo.walk(commit_oid, pygit2.GIT_SORT_TOPOLOGICAL)
    walker.hide(tag_oid)
    print(sum(1 for _ in walker))


def cmd_cherry_pick_count(repo_path, ref1, ref2):
    """Count unique commits (approximation of git rev-list --count --cherry-pick --left-only ref1...ref2).

    Uses merge-base to find the common ancestor, then counts commits
    reachable from ref1 but not from the merge-base. This is a simpler
    approximation since pygit2 doesn't expose patch-id comparison.
    """
    repo = open_repo(repo_path)
    oid1 = resolve_ref(repo, ref1)
    oid2 = resolve_ref(repo, ref2)

    try:
        base_oid = repo.merge_base(oid1, oid2)
    except Exception:
        print("Error: could not find merge-base", file=sys.stderr)
        sys.exit(1)

    if base_oid is None:
        print("Error: no common ancestor found", file=sys.stderr)
        sys.exit(1)

    walker = repo.walk(oid1, pygit2.GIT_SORT_TOPOLOGICAL)
    walker.hide(base_oid)
    print(sum(1 for _ in walker))


def cmd_merge_base(repo_path, ref1, ref2):
    """Find the common ancestor of two refs. Print the SHA."""
    repo = open_repo(repo_path)
    oid1 = resolve_ref(repo, ref1)
    oid2 = resolve_ref(repo, ref2)

    try:
        base_oid = repo.merge_base(oid1, oid2)
    except Exception:
        print("Error: could not find merge-base", file=sys.stderr)
        sys.exit(1)

    if base_oid is None:
        print("Error: no common ancestor found", file=sys.stderr)
        sys.exit(1)

    print(str(base_oid))


def cmd_is_ancestor(repo_path, ancestor, descendant):
    """Check if ancestor is reachable from descendant.

    Exit 0 if true, exit 1 if false.
    """
    repo = open_repo(repo_path)
    ancestor_oid = resolve_ref(repo, ancestor)
    descendant_oid = resolve_ref(repo, descendant)

    if ancestor_oid == descendant_oid:
        sys.exit(0)

    try:
        base_oid = repo.merge_base(ancestor_oid, descendant_oid)
    except Exception:
        sys.exit(1)

    if base_oid is not None and base_oid == ancestor_oid:
        sys.exit(0)
    else:
        sys.exit(1)


def cmd_fetch_tags(repo_path):
    """Fetch from origin, including tags.

    Try unshallowing first, fall back to regular fetch.
    Exit 0 on success, 1 on failure.
    """
    repo = open_repo(repo_path)
    origin = get_origin(repo)

    # Try unshallow + tags first
    try:
        origin.fetch(
            ["+refs/tags/*:refs/tags/*"],
            depth=0,  # unshallow
        )
        print("Fetched tags (unshallowed).", file=sys.stderr)
        return
    except Exception:
        pass

    # Fall back to regular tag fetch
    try:
        origin.fetch(["+refs/tags/*:refs/tags/*"])
        print("Fetched tags.", file=sys.stderr)
        return
    except Exception as e:
        print("Error: failed to fetch tags: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_fetch_commit(repo_path, sha):
    """Fetch a single commit SHA from origin so it is available locally.

    Needed when the local repo (e.g. a Stable install on a tag) doesn't have
    the remote HEAD commit that the 'latest' channel points at.
    Exit 0 on success, 1 on failure.
    """
    repo = open_repo(repo_path)
    origin = get_origin(repo)

    # Try unshallow fetch first so the full history is available
    try:
        origin.fetch(depth=0)
        print("Fetched commit %s (unshallowed)." % sha, file=sys.stderr)
        return
    except Exception:
        pass

    # Fall back to regular fetch
    try:
        origin.fetch()
        print("Fetched commit %s." % sha, file=sys.stderr)
        return
    except Exception as e:
        print("Error: failed to fetch commit %s: %s" % (sha, e), file=sys.stderr)
        sys.exit(1)


def cmd_clone(url, dest):
    """Clone a repository. Print progress to stderr."""
    print("Cloning %s into %s..." % (url, dest), file=sys.stderr)
    try:
        class Progress(pygit2.RemoteCallbacks):
            def transfer_progress(self, stats):
                print("\r  Objects: %d/%d, Received: %d bytes" % (
                    stats.indexed_objects, stats.total_objects,
                    stats.received_bytes), end='', file=sys.stderr)
        pygit2.clone_repository(url, dest, callbacks=Progress())
        print(file=sys.stderr)  # newline after progress
        print("Clone complete.", file=sys.stderr)
    except Exception as e:
        print("Error: clone failed: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_checkout(repo_path, commit):
    """Checkout a specific commit.

    If the commit is not available locally, fetch from origin first
    (unshallow if needed), then retry.
    """
    repo = open_repo(repo_path)

    # Try direct checkout first
    try:
        oid = resolve_ref(repo, commit)
        commit_obj = repo.get(oid)
        repo.checkout_tree(commit_obj, strategy=pygit2.GIT_CHECKOUT_SAFE)
        repo.set_head(oid)
        print("Checked out %s" % str(oid), file=sys.stderr)
        return
    except Exception:
        pass

    # Fetch from origin and retry
    print("Commit not found locally, fetching from origin...", file=sys.stderr)
    origin = get_origin(repo)

    # Try unshallow fetch
    try:
        origin.fetch(depth=0)
    except Exception:
        try:
            origin.fetch()
        except Exception as e:
            print("Error: fetch failed: %s" % e, file=sys.stderr)
            sys.exit(1)

    # Retry checkout
    try:
        oid = resolve_ref(repo, commit)
        commit_obj = repo.get(oid)
        repo.checkout_tree(commit_obj, strategy=pygit2.GIT_CHECKOUT_SAFE)
        repo.set_head(oid)
        print("Checked out %s" % str(oid), file=sys.stderr)
    except Exception as e:
        print("Error: checkout failed after fetch: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_fetch_and_checkout(repo_path, commit):
    """Fetch master from origin + checkout a specific commit.

    Ensures local master branch exists (mirrors update_comfyui.py behavior).
    """
    repo = open_repo(repo_path)
    origin = get_origin(repo)

    # Fetch master explicitly + tags (mirroring update_comfyui.py)
    refspecs = [
        "+refs/heads/master:refs/remotes/origin/master",
        "+refs/tags/*:refs/tags/*",
    ]

    # Try unshallow first, fall back to regular fetch
    try:
        origin.fetch(refspecs, depth=0)
    except Exception:
        try:
            origin.fetch(refspecs)
        except Exception as e:
            print("Error: failed to fetch from origin: %s" % e, file=sys.stderr)
            sys.exit(1)

    # Detach HEAD before modifying master to avoid corrupting state
    # if HEAD is currently attached to master
    try:
        repo.set_head(repo.head.target)
    except Exception:
        pass

    # Ensure local master branch exists, pointing at origin/master
    try:
        remote_ref = repo.lookup_reference("refs/remotes/origin/master")
        remote_id = remote_ref.target
        branch = repo.lookup_branch("master")
        if branch is None:
            repo.create_branch("master", repo.get(remote_id))
        else:
            branch.set_target(remote_id)
    except Exception as e:
        print("Warning: could not update local master branch: %s" % e, file=sys.stderr)

    # Checkout the target commit
    try:
        oid = resolve_ref(repo, commit)
        commit_obj = repo.get(oid)
        repo.checkout_tree(commit_obj, strategy=pygit2.GIT_CHECKOUT_FORCE)
        repo.set_head(oid)
        print("Checked out %s" % str(oid), file=sys.stderr)
    except Exception as e:
        print("Error: checkout failed: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_ls_remote_tags(url):
    """List version tags from a remote repository URL, sorted by version descending.

    Uses a temporary bare repo to query the remote via the Git protocol
    (not the GitHub API), so it is not subject to REST API rate limits.
    Prints one tag name per line on stdout.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        repo = pygit2.init_repository(tmpdir, bare=True)
        remote = repo.remotes.create_anonymous(url)
        try:
            heads = remote.list_heads()
        except AttributeError:
            heads = remote.ls_remotes()

        tags = []
        for ref in heads:
            name = ref["name"] if isinstance(ref, dict) else ref.name
            if not name.startswith("refs/tags/") or name.endswith("^{}"):
                continue
            tag_name = name[len("refs/tags/"):]
            version = parse_version_tuple(tag_name)
            if version is not None:
                tags.append((version, tag_name))

        tags.sort(reverse=True)
        for _, tag_name in tags:
            print(tag_name)


def cmd_ls_remote_ref(url, ref):
    """Get the SHA of a specific ref on a remote URL.

    Prints the SHA on stdout, or exits with code 1 if not found.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        repo = pygit2.init_repository(tmpdir, bare=True)
        remote = repo.remotes.create_anonymous(url)
        try:
            heads = remote.list_heads()
        except AttributeError:
            heads = remote.ls_remotes()
        for head in heads:
            name = head["name"] if isinstance(head, dict) else head.name
            oid = head["oid"] if isinstance(head, dict) else head.oid
            if name == ref and oid is not None:
                print(str(oid))
                return
        print("Error: ref %s not found" % ref, file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

USAGE = """\
Usage: python git_operations.py <subcommand> [args...]

Subcommands:
  rev-parse          <repo_path> <ref>
  describe-tags      <repo_path> [commit]
  tag-list           <repo_path>
  rev-list-count     <repo_path> <tag_or_ref> [commit]
  cherry-pick-count  <repo_path> <ref1> <ref2>
  merge-base         <repo_path> <ref1> <ref2>
  is-ancestor        <repo_path> <ancestor> <descendant>
  fetch-tags         <repo_path>
  fetch-commit       <repo_path> <sha>
  clone              <url> <dest>
  checkout           <repo_path> <commit>
  fetch-and-checkout <repo_path> <commit>
  ls-remote-tags     <url>
  ls-remote-ref      <url> <ref>
"""

if __name__ == "__main__":
    pygit2.option(pygit2.GIT_OPT_SET_OWNER_VALIDATION, 0)

    if len(sys.argv) < 2:
        print(USAGE, file=sys.stderr)
        sys.exit(1)

    subcmd = sys.argv[1]

    try:
        if subcmd == "rev-parse":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py rev-parse <repo_path> <ref>", file=sys.stderr)
                sys.exit(1)
            cmd_rev_parse(sys.argv[2], sys.argv[3])

        elif subcmd == "describe-tags":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py describe-tags <repo_path> [commit]", file=sys.stderr)
                sys.exit(1)
            commit = sys.argv[3] if len(sys.argv) > 3 else "HEAD"
            cmd_describe_tags(sys.argv[2], commit)

        elif subcmd == "tag-list":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py tag-list <repo_path>", file=sys.stderr)
                sys.exit(1)
            cmd_tag_list(sys.argv[2])

        elif subcmd == "rev-list-count":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py rev-list-count <repo_path> <tag_or_ref> [commit]", file=sys.stderr)
                sys.exit(1)
            commit = sys.argv[4] if len(sys.argv) > 4 else "HEAD"
            cmd_rev_list_count(sys.argv[2], sys.argv[3], commit)

        elif subcmd == "cherry-pick-count":
            if len(sys.argv) < 5:
                print("Usage: git_operations.py cherry-pick-count <repo_path> <ref1> <ref2>", file=sys.stderr)
                sys.exit(1)
            cmd_cherry_pick_count(sys.argv[2], sys.argv[3], sys.argv[4])

        elif subcmd == "merge-base":
            if len(sys.argv) < 5:
                print("Usage: git_operations.py merge-base <repo_path> <ref1> <ref2>", file=sys.stderr)
                sys.exit(1)
            cmd_merge_base(sys.argv[2], sys.argv[3], sys.argv[4])

        elif subcmd == "is-ancestor":
            if len(sys.argv) < 5:
                print("Usage: git_operations.py is-ancestor <repo_path> <ancestor> <descendant>", file=sys.stderr)
                sys.exit(1)
            cmd_is_ancestor(sys.argv[2], sys.argv[3], sys.argv[4])

        elif subcmd == "fetch-tags":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py fetch-tags <repo_path>", file=sys.stderr)
                sys.exit(1)
            cmd_fetch_tags(sys.argv[2])

        elif subcmd == "fetch-commit":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py fetch-commit <repo_path> <sha>", file=sys.stderr)
                sys.exit(1)
            cmd_fetch_commit(sys.argv[2], sys.argv[3])

        elif subcmd == "clone":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py clone <url> <dest>", file=sys.stderr)
                sys.exit(1)
            cmd_clone(sys.argv[2], sys.argv[3])

        elif subcmd == "checkout":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py checkout <repo_path> <commit>", file=sys.stderr)
                sys.exit(1)
            cmd_checkout(sys.argv[2], sys.argv[3])

        elif subcmd == "fetch-and-checkout":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py fetch-and-checkout <repo_path> <commit>", file=sys.stderr)
                sys.exit(1)
            cmd_fetch_and_checkout(sys.argv[2], sys.argv[3])

        elif subcmd == "ls-remote-tags":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py ls-remote-tags <url>", file=sys.stderr)
                sys.exit(1)
            cmd_ls_remote_tags(sys.argv[2])

        elif subcmd == "ls-remote-ref":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py ls-remote-ref <url> <ref>", file=sys.stderr)
                sys.exit(1)
            cmd_ls_remote_ref(sys.argv[2], sys.argv[3])

        else:
            print("Unknown subcommand: %s" % subcmd, file=sys.stderr)
            print(USAGE, file=sys.stderr)
            sys.exit(1)

    except SystemExit:
        raise
    except Exception as e:
        print("Error: %s" % e, file=sys.stderr)
        sys.exit(1)
