#!/usr/bin/env python3
"""Bounded, owned qualification workspaces and lossless evidence archives.

This is maintainer tooling. It never follows dependency links, publishes data,
or deletes retained evidence without a verified, restorable archive.
"""

import argparse
import contextlib
import dataclasses
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
import zipfile

GIB = 1024**3
SCHEMA = "rnr-qualification-storage/v1"
LINK_ARCHIVE_SCHEMA = "rnr-qualification-archive/v2"
POLICY_SCHEMA = "rnr-qualification-policy/v1"
MAX_CONFIGURED_HISTORY_GIB = 80


class UnsupportedArchiveEntry(ValueError):
    """A raw fixture must remain intact when its node type cannot be archived."""


@dataclasses.dataclass(frozen=True)
class Policy:
    reserve: int = 20 * GIB
    run_limit: int = 12 * GIB
    history_limit: int = 20 * GIB
    poll_seconds: float = 1
    startup_floor: int = 32 * GIB


def effective_policy(store, policy=None):
    """Resolve only this owned store's approval; explicit historical policies stay explicit."""
    if policy is not None:
        return policy, {"kind": "explicit-policy"}
    store = ensure_store(store)
    path = store / "policy.json"
    if not path.exists() and not path.is_symlink():
        return Policy(), {"kind": "conservative-default"}
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16384:
        raise ValueError("Invalid qualification policy file")
    value = json.loads(path.read_text())
    if (not isinstance(value, dict) or set(value) != {
            "schema", "store", "workspace", "uid", "historyLimitGiB", "authorization"}
            or value.get("schema") != POLICY_SCHEMA or value.get("store") != str(store)
            or type(value.get("uid")) is not int or value["uid"] != os.getuid()
            or type(value.get("historyLimitGiB")) is not int or not 1 <= value["historyLimitGiB"] <= MAX_CONFIGURED_HISTORY_GIB
            or not isinstance(value.get("authorization"), str) or not value["authorization"].strip()
            or not isinstance(value.get("workspace"), str)):
        raise ValueError("Malformed or foreign qualification policy")
    workspace = Path(value["workspace"])
    if not workspace.is_absolute() or not workspace.is_dir() or workspace.resolve() != workspace:
        raise ValueError("Qualification policy workspace is not canonical")
    return dataclasses.replace(Policy(), history_limit=value["historyLimitGiB"] * GIB), {
        "kind": "workspace-configuration", "path": str(path), "sha256": digest(path),
        "workspace": str(workspace), "authorization": value["authorization"]}


def assert_policy_scope(path, provenance):
    if provenance.get("workspace") and not Path(path).resolve().is_relative_to(Path(provenance["workspace"])):
        raise ValueError("Operation is outside the configured qualification workspace")


def policy_report(policy, provenance):
    return {"policy": dataclasses.asdict(policy), "policyProvenance": provenance}


def configure_policy(store, workspace, history_limit_gib, authorization):
    store = ensure_store(store)
    workspace = Path(workspace).resolve(strict=True)
    if not workspace.is_dir() or type(history_limit_gib) is not int or not 1 <= history_limit_gib <= MAX_CONFIGURED_HISTORY_GIB or not authorization.strip():
        raise ValueError(f"Choose a workspace, authorization and retained limit from 1 to {MAX_CONFIGURED_HISTORY_GIB} GiB")
    with exclusive(store / "active.lock"):
        # Do not change a live owner's inputs or reinterpret its recorded policy.
        for path in (store / "states").glob("*.json"):
            state = json.loads(path.read_text())
            if state.get("status") in ("starting", "running", "stopping-for-storage"):
                raise RuntimeError("Resolve the nonterminal storage owner before configuring policy")
        target = store / "policy.json"
        if target.is_symlink():
            raise ValueError("Qualification policy refuses symbolic paths")
        write_json(target, {"schema": POLICY_SCHEMA, "store": str(store), "workspace": str(workspace),
                            "uid": os.getuid(), "historyLimitGiB": history_limit_gib,
                            "authorization": authorization})
    return policy_report(*effective_policy(store))


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def available(path):
    value = os.statvfs(path)
    return value.f_bavail * value.f_frsize


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def safe_relative(value):
    path = Path(value)
    if not value or path.is_absolute() or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Unsafe retained path: " + repr(value))
    return path


def required_files(root, expected=None):
    manifest = root / "files.json"
    if not manifest.exists():
        if expected:
            raise ValueError("Frozen evidence manifest is missing")
        return {}
    if expected and digest(manifest) != expected:
        raise ValueError("Frozen evidence manifest changed")
    items = json.loads(manifest.read_text())
    if not isinstance(items, list) or not all(isinstance(x, dict) and "path" in x and "sha256" in x for x in items):
        raise ValueError("Expected a retained file inventory")
    result = {}
    for item in items:
        path = safe_relative(item["path"])
        source = root / path
        if not source.resolve().is_relative_to(root.resolve()) or source.is_symlink():
            raise ValueError("Retained evidence escapes its owner")
        if digest(source) != item["sha256"]:
            raise ValueError("Retained evidence changed: " + str(path))
        result[str(path)] = item["sha256"]
    return result


def captured_paths(root, required=None):
    """Recognize retained inventories before considering any dependency cache.

    In particular, application-sources/node_modules is captured evidence, not an
    installed environment. Nested sealed cohorts retain that distinction too.
    """
    result = dict(required or {})
    for parent, dirs, names in os.walk(root, followlinks=False):
        parent = Path(parent)
        for name in names:
            if name != "files.json" and not name.endswith(("-sources.json", "-inputs.json")):
                continue
            path = parent / name
            if path.is_symlink() or path.stat().st_size > 32 * 1024**2:
                continue
            try:
                value = json.loads(path.read_text())
            except (ValueError, UnicodeError):
                continue
            items = value.get("files", []) if isinstance(value, dict) else value
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("sha256"), str):
                    continue
                try:
                    relative = safe_relative(item["path"])
                except ValueError:
                    continue
                for base in (parent, parent / path.stem):
                    source = base / relative
                    if source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(root.resolve()) and digest(source) == item["sha256"]:
                        result[str(source.relative_to(root))] = item["sha256"]
                        break
        for name in list(dirs):
            relative = str((parent / name).relative_to(root))
            if name == "node_modules" and not any(p.startswith(relative + "/") for p in result):
                dirs.remove(name)
    return result


def prune_dependency_caches(root, retained):
    removed = []
    for parent, dirs, _ in os.walk(root, followlinks=False):
        if "node_modules" not in dirs:
            continue
        path = Path(parent) / "node_modules"
        relative = str(path.relative_to(root))
        if any(p.startswith(relative + "/") for p in retained):
            continue
        dirs.remove("node_modules")
        if path.is_symlink():
            path.unlink()
        else:
            shutil.rmtree(path)
        removed.append(relative)
    for path, sha in retained.items():
        if digest(root / path) != sha:
            raise ValueError("Retained evidence changed during dependency retirement")
    return removed


def inventory(root, required=None, preserve_links=False):
    required = required or {}
    files = []
    directories = []
    links = []
    def retain_link(path):
        if not preserve_links:
            raise UnsupportedArchiveEntry("Archive refuses a symbolic link: " + str(path))
        info = path.lstat()
        links.append({"path": str(path.relative_to(root)), "target": os.readlink(path),
                      "mode": stat.S_IMODE(info.st_mode), "mtimeNs": info.st_mtime_ns})
    for parent, names, leaves in os.walk(root, followlinks=False):
        parent = Path(parent)
        for name in list(names):
            path = parent / name
            relative = str(path.relative_to(root))
            if name == "node_modules" and not any(p.startswith(relative + "/") for p in required):
                names.remove(name)
                continue
            if path.is_symlink():
                retain_link(path)
                names.remove(name)
                continue
            directories.append({"path": relative, "mode": stat.S_IMODE(path.stat().st_mode)})
        for name in leaves:
            path = parent / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                retain_link(path)
                continue
            if not stat.S_ISREG(info.st_mode):
                raise UnsupportedArchiveEntry("Archive requires regular files: " + str(path))
            files.append({"path": str(path.relative_to(root)), "sha256": digest(path), "size": info.st_size,
                          "mode": stat.S_IMODE(info.st_mode), "mtimeNs": info.st_mtime_ns})
    files.sort(key=lambda x: x["path"])
    actual = {x["path"]: x["sha256"] for x in files}
    if any(actual.get(p) != sha for p, sha in required.items()):
        raise ValueError("Archive changed or omitted retained evidence")
    return {"files": files, "directories": sorted(directories, key=lambda x: x["path"]),
            **({"links": sorted(links, key=lambda x: x["path"])} if links else {})}


def allocation_roots(paths):
    """Remove duplicate/nested namespaces before walking; never resolve links."""
    distinct = set()
    for path in sorted({Path(p) for p in paths}, key=lambda p: (len(p.parts), str(p))):
        if not any(parent in distinct for parent in path.parents):
            distinct.add(path)
    return sorted(distinct)


def allocated(paths):
    total = 0
    seen = set()
    pending = []
    for root in allocation_roots(paths):
        try:
            info = root.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(info.st_mode):
            pending.append(str(root))
        elif stat.S_ISREG(info.st_mode):
            key = (info.st_dev, info.st_ino)
            if key not in seen:
                seen.add(key)
                total += info.st_blocks * 512
    while pending:
        directory = pending.pop()
        try:
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except FileNotFoundError:
            continue
        try:
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(os.path.join(directory, entry.name))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        info = entry.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        # Build owners can atomically replace disposable output mid-scan.
                        continue
                    key = (info.st_dev, info.st_ino)
                    if stat.S_ISREG(info.st_mode) and key not in seen:
                        seen.add(key)
                        total += info.st_blocks * 512
        except FileNotFoundError:
            continue
        finally:
            os.close(descriptor)
        # Permission/IO failures must not turn an incomplete scan into admission.
    return total


@contextlib.contextmanager
def timed_phase(timings, name):
    if timings is None:
        yield
        return
    started = time.perf_counter()
    phase = timings.setdefault(name, {"calls": 0, "elapsedMs": 0, "failures": 0})
    phase["calls"] += 1
    try:
        yield
    except BaseException:
        phase["failures"] += 1
        raise
    finally:
        phase["elapsedMs"] += round((time.perf_counter() - started) * 1000, 3)


def retained_usage(store, exclude=(), timings=None):
    """Count retained outputs as well as the shared store; never delete them."""
    with timed_phase(timings, "retainedRootDiscovery"):
        excluded = {str(Path(p)) for p in exclude}
        roots = [store]
        for path in (store / "states").glob("*.json"):
            state = json.loads(path.read_text())
            roots.extend(Path(p) for p in state.get("ownedOutputs", []) if p not in excluded)
    with timed_phase(timings, "retainedAllocation"):
        return allocated(roots)


def check_space(path, policy, extra=0):
    free = available(path)
    if free < policy.reserve + extra:
        raise RuntimeError(f"Storage reserve: {free / GIB:.1f} GiB free; require {(policy.reserve + extra) / GIB:.1f} GiB")
    return free


def ensure_store(store):
    store = Path(store).resolve()
    marker = store / "owner.json"
    if store.exists() and any(store.iterdir()) and not marker.exists():
        raise ValueError("Storage root is not an owned qualification directory")
    store.mkdir(parents=True, exist_ok=True)
    if marker.exists():
        owner = json.loads(marker.read_text())
        if owner.get("schema") != SCHEMA or owner.get("uid") != os.getuid():
            raise ValueError("Qualification storage owner differs")
    else:
        write_json(marker, {"schema": SCHEMA, "uid": os.getuid()})
    return store


def validate_archive(path, limit=12 * GIB):
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        names = [x.filename for x in members]
        if len(names) != len(set(names)) or "metadata.json" not in names:
            raise ValueError("Invalid or duplicate archive entries")
        if archive.getinfo("metadata.json").file_size > 32 * 1024**2:
            raise ValueError("Archive metadata exceeds its limit")
        metadata = json.loads(archive.read("metadata.json"))
        if metadata.get("schema") not in (SCHEMA, LINK_ARCHIVE_SCHEMA):
            raise ValueError("Unknown storage archive schema")
        if "links" in metadata and metadata["schema"] != LINK_ARCHIVE_SCHEMA:
            raise ValueError("Link metadata requires the versioned link archive schema")
        objects = {}
        seen = set()
        for item in metadata["files"]:
            relative = str(safe_relative(item["path"]))
            sha = item["sha256"]
            if relative in seen or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
                raise ValueError("Invalid archive file inventory")
            seen.add(relative)
            if item["size"] < 0 or (sha in objects and objects[sha] != item["size"]):
                raise ValueError("Inconsistent object size")
            objects[sha] = item["size"]
        for item in metadata["directories"]:
            relative = str(safe_relative(item["path"]))
            if relative in seen:
                raise ValueError("Duplicate archive path")
            seen.add(relative)
        link_paths = set()
        for item in metadata.get("links", []):
            relative = str(safe_relative(item["path"]))
            if (relative in seen or not isinstance(item.get("target"), str) or not item["target"]
                    or "\0" in item["target"] or len(os.fsencode(item["target"])) > 16384
                    or type(item.get("mode")) is not int or not 0 <= item["mode"] <= 0o7777
                    or type(item.get("mtimeNs")) is not int):
                raise ValueError("Invalid archive symbolic link")
            seen.add(relative)
            link_paths.add(relative)
        # No archive entry may write through a file or link, regardless of entry order.
        non_directories = link_paths | {item["path"] for item in metadata["files"]}
        if any(str(parent) in non_directories for path in seen for parent in Path(path).parents if str(parent) != "."):
            raise ValueError("Archive path descends through a file or symbolic link")
        if sum(objects.values()) > limit or set(names) != {"metadata.json", *("objects/" + sha for sha in objects)}:
            raise ValueError("Archive exceeds its budget or contains unexpected entries")
        for sha, size in objects.items():
            info = archive.getinfo("objects/" + sha)
            if info.file_size != size or stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFREG):
                raise ValueError("Archive object type or size changed")
            h = hashlib.sha256()
            count = 0
            with archive.open(info) as stream:
                while block := stream.read(1024 * 1024):
                    count += len(block)
                    if count > size:
                        raise ValueError("Archive object exceeds its declared size")
                    h.update(block)
            if count != size or h.hexdigest() != sha:
                raise ValueError("Archive object changed")
    return metadata


def archive_tree(root, store, policy=None, expected=None, retire=False, before_retire=None, policy_provenance=None,
                 retain_unsupported=False, preserve_links=False, timings=None):
    root = Path(root).absolute()
    store = Path(store).resolve()
    if root.is_symlink() or not root.is_dir() or store.is_relative_to(root.resolve()):
        raise ValueError("Archive source must be an independent owned directory")
    store = ensure_store(store)
    policy, provenance = effective_policy(store, policy)
    provenance = policy_provenance or provenance
    assert_policy_scope(root, provenance)
    required = captured_paths(root, required_files(root, expected))
    try:
        contents = inventory(root, required, preserve_links=preserve_links)
    except UnsupportedArchiveEntry as error:
        if not retain_unsupported:
            raise
        # Automated compaction is optional. Preserve an unsupported raw tree
        # and keep it charged to retained storage; never follow or flatten links.
        return {"schema": SCHEMA, "status": "retained-unarchivable", "source": str(root),
                "error": {"type": type(error).__name__, "message": str(error)},
                **policy_report(policy, provenance)}
    metadata = {"schema": LINK_ARCHIVE_SCHEMA if contents.get("links") else SCHEMA, "originalRoot": str(root), **contents,
                "frozenManifestSha256": digest(root / "files.json") if expected else None}
    encoded = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
    identity = hashlib.sha256(encoded).hexdigest()
    history = store / "history"
    history.mkdir(parents=True, exist_ok=True)
    objects = {}
    for item in contents["files"]:
        objects.setdefault(item["sha256"], item)
    unique = sum(x["size"] for x in objects.values())
    if unique > policy.run_limit:
        raise RuntimeError("Archive input exceeds the per-operation budget")
    destination = history / (identity + ".zip")
    existing = retained_usage(store, timings=timings)
    index = store / "index" / (identity + ".json")
    previous = json.loads(index.read_bytes()) if index.exists() else {}
    if previous.get("storage") and not destination.exists():
        from qualification_capacity import archive_file
        with archive_file(store, destination, previous["sha256"], policy) as original:
            if validate_archive(original, policy.run_limit) != metadata:
                raise ValueError("Packed archive differs from the captured tree")
            # Existing callers receive an ordinary ZIP at the expected path.
            os.replace(original, destination)
    if not destination.exists():
        if existing + unique + len(encoded) > policy.history_limit:
            raise RuntimeError("Retained history budget reached; source remains intact")
        check_space(store, policy, unique + len(encoded))
        temporary = destination.with_suffix(".partial-" + str(os.getpid()))
        try:
            with zipfile.ZipFile(temporary, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr("metadata.json", encoded)
                for sha, item in objects.items():
                    check_space(store, policy)
                    archive.write(root / item["path"], "objects/" + sha)
            if validate_archive(temporary, policy.run_limit) != metadata:
                raise ValueError("Archive round trip changed metadata")
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()
    elif validate_archive(destination, policy.run_limit) != metadata:
        raise ValueError("Existing archive differs")
    record = {"schema": SCHEMA, "status": "verified", "source": str(root), "archive": str(destination),
              "sha256": digest(destination), "files": len(contents["files"]), "objects": len(objects),
              "logicalBytes": sum(x["size"] for x in contents["files"]), "archiveBytes": destination.stat().st_size,
              **policy_report(policy, provenance)}
    if contents.get("links"):
        record["symbolicLinks"] = len(contents["links"])
    if previous.get("storage") and previous["sha256"] == record["sha256"]:
        record["storage"] = previous["storage"]
    write_json(index, record)
    if before_retire:
        before_retire()
    if retire:
        if inventory(root, required, preserve_links=preserve_links) != contents:
            raise RuntimeError("Source changed after archiving; it was not retired")
        quarantine = root.with_name(root.name + ".retiring-" + identity[:12])
        if quarantine.exists():
            raise ValueError("Previous retirement needs inspection")
        os.rename(root, quarantine)
        record.update(status="retiring", quarantine=str(quarantine))
        write_json(index, record)
        shutil.rmtree(quarantine)
        record.update(status="archived", quarantine=None)
        write_json(index, record)
    return record


def restore_tree(archive_path, destination, expected_sha, policy=None, restore_links=False):
    archive_path = Path(archive_path)
    policy, provenance = effective_policy(archive_path.resolve().parent.parent, policy)
    destination = Path(destination).absolute()
    assert_policy_scope(destination, provenance)
    if destination.exists() or destination.is_symlink() or digest(archive_path) != expected_sha:
        raise ValueError("Restore refuses existing output or a changed archive")
    metadata = validate_archive(archive_path, policy.run_limit)
    if metadata.get("links") and not restore_links:
        raise ValueError("Archive contains symbolic links; inspect their targets and explicitly choose --restore-links")
    if any(parent.is_symlink() for parent in destination.parents):
        raise ValueError("Restore refuses linked destination ancestors")
    logical = sum(x["size"] for x in metadata["files"])
    if logical > policy.run_limit:
        raise RuntimeError("Restore exceeds the workspace budget")
    destination.parent.mkdir(parents=True, exist_ok=True)
    check_space(destination.parent, policy, logical)
    destination.mkdir()
    with zipfile.ZipFile(archive_path) as archive:
        for item in metadata["files"]:
            path = destination / safe_relative(item["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            check_space(destination, policy)
            with archive.open("objects/" + item["sha256"]) as source, path.open("xb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
            os.chmod(path, item["mode"])
            os.utime(path, ns=(item["mtimeNs"], item["mtimeNs"]))
        for item in metadata["directories"]:
            path = destination / safe_relative(item["path"])
            path.mkdir(parents=True, exist_ok=True)
            os.chmod(path, item["mode"])
        # Links are created last. Never open, chmod or timestamp their targets.
        for item in metadata.get("links", []):
            path = destination / safe_relative(item["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(item["target"])
            if stat.S_IMODE(path.lstat().st_mode) != item["mode"]:
                os.chmod(path, item["mode"], follow_symlinks=False)
            os.utime(path, ns=(item["mtimeNs"], item["mtimeNs"]), follow_symlinks=False)
    retained = captured_paths(destination, required_files(destination, metadata.get("frozenManifestSha256")))
    expected = {key: metadata[key] for key in ("files", "directories", "links") if key in metadata}
    if inventory(destination, retained, preserve_links=bool(metadata.get("links"))) != expected:
        raise ValueError("Restored bytes or metadata differ")
    return metadata


def assert_archive_scope(root, store):
    if ".local" in root.parts:
        return
    owners = [json.loads(path.read_text()) for path in (store / "states").glob("*.json")]
    matching = [state for state in owners if state.get("evidence") == str(root)]
    if (root.resolve() != root or not matching or any(
            state.get("status") not in ("passed", "failed", "interrupted", "storage-limit")
            or not state.get("project")
            or root == Path(state["project"]) / "build-artifacts"
            or not root.is_relative_to(Path(state["project"]) / "build-artifacts")
            for state in matching)):
        raise ValueError("Only private or terminal owner-registered qualification evidence may be archived")


@contextlib.contextmanager
def exclusive(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another managed qualification is active") from None
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def process_table():
    result = {}
    for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True).splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3:
            result[int(fields[0])] = (int(fields[1]), fields[2])
    return result


def assert_quiescent(root):
    rows = process_table()
    if any(str(root) in command for pid, (_, command) in rows.items() if pid not in (os.getpid(), os.getppid())):
        raise RuntimeError("An active process names this evidence root")
    opened = subprocess.run(["lsof", "-nP", "+D", str(root), "-Fp"], capture_output=True, text=True, timeout=60)
    if opened.returncode not in (0, 1) or opened.stdout.strip() or opened.stderr.strip():
        # -Fp contains process IDs only. Keep the actual refusal actionable
        # without retaining command lines or silently treating a probe as idle.
        owners = ", ".join(opened.stdout.splitlines())[:512]
        detail = "; ".join(value for value in (opened.stderr.strip(),
                          f"lsof exit={opened.returncode}", f"processes={owners}" if owners else "") if value)
        raise RuntimeError("Evidence retirement requires no open files or working directories: " + detail)


def prune_owned_lane_caches(root, proof, archive_sha256):
    """Retire only unused dependencies of a completed lane under its live owner."""
    session, nonce = os.environ.get("RNR_STORAGE_SESSION"), os.environ.get("RNR_STORAGE_NONCE")
    if not session or not nonce:
        raise ValueError("Lane cache retirement requires an active storage owner")
    session = Path(session).absolute()
    store = ensure_store(session.parent.parent)
    if session.parent != store / "states" or session.is_symlink() or session.resolve() != session:
        raise ValueError("Lane cache retirement has an invalid owner record")
    state = json.loads(session.read_text())
    if state.get("schema") != SCHEMA or state.get("nonce") != nonce or state.get("status") != "running":
        raise ValueError("Lane cache retirement has a stale or mismatched owner")
    try:
        os.kill(state["ownerPid"], 0)
    except ProcessLookupError:
        raise ValueError("Lane cache retirement owner is no longer alive") from None
    root, proof = Path(root).absolute(), Path(proof).absolute()
    if root.is_symlink() or proof.is_symlink() or root.resolve() != root or proof.resolve() != proof:
        raise ValueError("Lane cache retirement refuses symbolic paths")
    namespaces = [Path(state["tmp"]).resolve(), *map(lambda p: Path(p).resolve(), state.get("ownedOutputs", []))]
    if not all(any(path == parent or path.is_relative_to(parent) for parent in namespaces) for path in (root, proof)):
        raise ValueError("Lane cache retirement escapes the owned output namespaces")
    evidence = json.loads(proof.read_text())
    if evidence.get("status") != "passed" or evidence.get("archiveSha256") != archive_sha256:
        raise ValueError("Lane cache retirement requires a passed exact-archive proof")
    if str(root) not in [evidence.get("consumer"), evidence.get("directory")]:
        raise ValueError("Lane cache retirement root does not match its proof")
    assert_quiescent(root)
    retained = captured_paths(root, required_files(root))
    before = inventory(root, retained)
    removed = prune_dependency_caches(root, retained)
    if inventory(root, retained) != before:
        raise RuntimeError("Retained lane inputs changed during cache retirement")
    return {"schema": SCHEMA, "status": "retired-unretained-dependency-caches", "root": str(root),
            "proof": str(proof), "proofSha256": digest(proof), "archiveSha256": archive_sha256,
            "removed": removed, "retainedFilesVerified": len(before["files"])}


def descendants(pid, rows):
    result = {pid}
    while True:
        more = result | {p for p, (parent, _) in rows.items() if parent in result}
        if result == more:
            return result
        result = more


def inherited_session(store=None):
    """Validate a real descendant's inherited owner instead of creating a second quota."""
    session, nonce = os.environ.get("RNR_STORAGE_SESSION"), os.environ.get("RNR_STORAGE_NONCE")
    if not session or not nonce:
        raise ValueError("An inherited qualification storage session is required")
    session = Path(session).absolute()
    actual_store = ensure_store(session.parent.parent)
    if (session.parent != actual_store / "states" or session.is_symlink() or session.resolve() != session
            or (store is not None and Path(store).resolve() != actual_store)):
        raise ValueError("Invalid inherited qualification storage path")
    state = json.loads(session.read_text())
    temporary = Path(state.get("tmp", ""))
    workspace = Path(state.get("workspace", ""))
    if (state.get("schema") != SCHEMA or state.get("nonce") != nonce
            or state.get("status") not in ("starting", "running", "stopping-for-storage")
            or workspace.parent != actual_store / "workspaces" or workspace.resolve() != workspace
            or temporary != workspace / "tmp" or temporary.resolve() != temporary
            or Path(os.environ.get("TMPDIR", "")).resolve() != temporary
            or type(state.get("ownerPid")) is not int or state["ownerPid"] <= 0
            or os.getpid() not in descendants(state["ownerPid"], process_table())):
        raise ValueError("Stale or mismatched qualification storage session")
    os.kill(state["ownerPid"], 0)
    # A state file and a live unrelated process are insufficient: its heavy lock must be held.
    try:
        with exclusive(actual_store / "active.lock"):
            pass
    except RuntimeError:
        return state
    raise ValueError("Inherited qualification storage owner has no active lock")


def required_available(policy, budget, recovery):
    return max(policy.startup_floor, policy.reserve + budget + recovery)


def admission(project, store, policy, retained_headroom=0, free_space=available, timings=None, retained=None):
    if retained_headroom < 0:
        raise ValueError("Retained recovery headroom cannot be negative")
    free = free_space(project)
    required = required_available(policy, policy.run_limit, retained_headroom)
    if free < required:
        raise RuntimeError("Insufficient space for the startup floor, reserve and complete run/recovery budget; "
                           f"available={free / GIB:.3f} GiB, required={required / GIB:.3f} GiB, "
                           f"shortfall={(required - free) / GIB:.3f} GiB; no process started")
    if retained is None:
        retained = retained_usage(store, timings=timings)
    if retained + policy.run_limit + retained_headroom > policy.history_limit:
        raise RuntimeError("Retained storage cannot accommodate another run budget and recovery headroom; "
                           f"retained={retained / GIB:.3f} GiB, run={policy.run_limit / GIB:.3f} GiB, "
                           f"recovery={retained_headroom / GIB:.3f} GiB, ceiling={policy.history_limit / GIB:.3f} GiB, "
                           f"shortfall={(retained + policy.run_limit + retained_headroom - policy.history_limit) / GIB:.3f} GiB; "
                           "archive or retire verified environments first")
    return {"availableBytes": free, "retainedBytes": retained, "requiredAvailableBytes": required,
            "reservedRunBytes": policy.run_limit, "retainedHeadroomBytes": retained_headroom,
            "projectedRetainedBytes": retained + policy.run_limit + retained_headroom}


def retirement_candidates(store, current):
    states = []
    for path in (store / "states").glob("*.json"):
        state = json.loads(path.read_text())
        workspace = Path(state["workspace"])
        if workspace == current or not workspace.exists():
            continue
        if workspace.parent != store / "workspaces" or workspace.is_symlink():
            raise ValueError("Workspace ownership changed")
        if state.get("status") in ("starting", "running", "stopping-for-storage"):
            try:
                os.kill(state["ownerPid"], 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError("A recorded qualification owner is still active")
        states.append((state.get("finishedAt", state["createdAt"]), workspace, path, state))
    return sorted(states)[:-1]


def retire_stale_workspaces(store, current, policy, *, timings=None, check_retained=True, candidates=None):
    if candidates is None:
        candidates = retirement_candidates(store, current)
    # Compact older terminal environments when lossless archival is supported.
    # Unsupported fixture node types remain raw and count against the same cap.
    for _, workspace, path, state in candidates:
        temporary = workspace / "tmp"
        if temporary.exists():
            def quiescent():
                with timed_phase(timings, "quiescence"):
                    assert_quiescent(temporary)
            quiescent()
            with timed_phase(timings, "temporaryArchive"):
                retained = archive_tree(temporary, store, policy, retire=True,
                                        before_retire=quiescent, retain_unsupported=True,
                                        preserve_links=True, timings=timings)
            if retained["status"] == "retained-unarchivable":
                state["temporaryArchiveRefusal"] = retained
                write_json(path, state)
                continue
            state["temporaryArchive"] = retained
            state.pop("temporaryArchiveRefusal", None)
        if not any(workspace.iterdir()):
            workspace.rmdir()
        state["temporaryEnvironmentRetired"] = True
        write_json(path, state)
    # guard_run immediately performs a stricter post-compaction admission,
    # including the complete new run/recovery budget, under this same lock.
    if check_retained and retained_usage(store, timings=timings) > policy.history_limit:
        raise RuntimeError("Retained qualification storage reached its budget; no new process started")


def terminate_group(child):
    """Retire descendants even if the direct child exited before its workers."""
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        # Group absence does not reap the direct Popen child. Observe its real
        # exit status before recording cleanup, including an exit/probe race.
        child.wait()
        return
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        child.poll()
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        except PermissionError:
            if sys.platform != "darwin" or child.returncode is not None:
                raise
            # Darwin can deny a signal-zero probe during exit after accepting
            # SIGTERM. Reap the direct child, then check for remaining workers.
            try:
                child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass  # The deadline path signals the group with SIGKILL.
            continue
        time.sleep(0.02)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait()


def stop_owned_child(child, project, kind):
    if kind == "runtime-update":
        journal_path = project / ".build-state/roku-runtime-update.json"
        if journal_path.exists():
            journal = json.loads(journal_path.read_text())
            active = (journal.get("activeCommand") or {}).get("pid")
            rows = process_table()
            family = descendants(child.pid, rows)
            if active and active in family and active != child.pid:
                for pid in sorted(descendants(active, rows), reverse=True):
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                return "qualification-child-stopped-for-rollback"
            if journal.get("status") in ("verifying", "rolling-back", "rollingBack"):
                return "waiting-for-active-child-or-rollback"
        rows = process_table()
        direct = [pid for pid, (parent, _) in rows.items() if parent == child.pid]
        if direct:
            for pid in sorted(set().union(*(descendants(p, rows) for p in direct)), reverse=True):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            return "preparation-child-stopped"
        return "waiting-for-active-child-or-rollback"
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    return "owned-process-group-stopped"


def guard_run(project, store, command, evidence=None, tracks=(), dynamic=(), identity="default",
              kind="qualification", cleanup_success=False, policy=None, free_space=available, inputs=(),
              retained_headroom=0, policy_provenance=None, cold_temporary_history=False, lock_wait_seconds=0):
    startup_started, timings = time.perf_counter(), {}
    project, store = Path(project).resolve(), ensure_store(store)
    policy, provenance = effective_policy(store, policy)
    provenance = policy_provenance or provenance
    assert_policy_scope(project, provenance)
    if lock_wait_seconds:
        from qualification_capacity import maintenance_lock
        guard_lock = maintenance_lock(store, lock_wait_seconds)
    else:
        guard_lock = exclusive(store / "active.lock")
    with guard_lock:
        # An explicit cohort resumes its temporary consumers across lane CLIs.
        # Ordinary checks need unique records so a later run cannot erase the
        # cumulative accounting for an earlier run's output directories.
        key = hashlib.sha256(json.dumps([str(project), str(evidence), identity,
                                        None if evidence else secrets.token_hex(16)]).encode()).hexdigest()
        workspace = store / "workspaces" / key
        with timed_phase(timings, "retirementDiscovery"):
            candidates = retirement_candidates(store, workspace)
        registration = store / "maintenance" / "cold-archives.json"
        maintenance = retained_snapshot = None
        if registration.exists():
            from qualification_capacity import maintain_before_run
            with timed_phase(timings, "enrolledColdHistory"):
                retained_snapshot = retained_usage(store, timings=timings)
                try:
                    maintenance = maintain_before_run(store, policy, registration, retained_snapshot)
                except (RuntimeError, ValueError, OSError) as error:
                    # The original or its verified index remains authoritative. Normal
                    # admission still decides whether the device work can proceed.
                    maintenance = {"status": "maintenance-deferred", "reason": str(error)}
                if maintenance:
                    retained_snapshot = None
        # The lock protects the candidate list. Only a mutating retirement needs
        # both pre-admission and a new retained-byte observation afterwards.
        if candidates:
            with timed_phase(timings, "admissionBeforeCompaction"):
                admission(project, store, policy, retained_headroom, free_space, timings=timings, retained=retained_snapshot)
            with timed_phase(timings, "temporaryCompaction"):
                retire_stale_workspaces(store, workspace, policy, timings=timings, check_retained=False, candidates=candidates)
            retained_snapshot = None
        with timed_phase(timings, "admissionAfterCompaction"):
            admitted = admission(project, store, policy, retained_headroom, free_space, timings=timings, retained=retained_snapshot)
        workspace.mkdir(parents=True, exist_ok=True)
        temporary = workspace / "tmp"
        temporary.mkdir(exist_ok=True)
        state_path = store / "states" / (key + ".json")
        nonce = secrets.token_hex(16)
        state = {"schema": SCHEMA, "status": "starting", "ownerPid": os.getpid(), "nonce": nonce,
                 "project": str(project), "workspace": str(workspace), "tmp": str(temporary),
                 "evidence": str(evidence) if evidence else None, "command": command,
                 "kind": kind, **policy_report(policy, provenance), "admission": admitted, "createdAt": time.time()}
        if cold_temporary_history:
            state["coldTemporaryHistory"] = True
        if maintenance:
            state["coldHistoryMaintenance"] = maintenance
        state["ownedOutputs"] = sorted({str(Path(p).absolute()) for p in tracks} |
                                       ({str(Path(evidence).absolute())} if evidence else set()))
        runner = Path(__file__).resolve()
        runner_copy = store / "runner-inputs" / (digest(runner) + ".py")
        runner_copy.parent.mkdir(parents=True, exist_ok=True)
        if not runner_copy.exists():
            shutil.copyfile(runner, runner_copy)
        state["runnerInput"] = {"path": str(runner_copy), "sha256": digest(runner_copy)}
        state["additionalInputs"] = []
        policy_inputs = [provenance["path"]] if provenance.get("path") else []
        if registration.is_file():
            policy_inputs.extend([registration, runner.with_name("qualification_capacity.py")])
        for source in map(Path, [*inputs, *policy_inputs]):
            sha = digest(source)
            target = store / "runner-inputs" / (sha + source.suffix)
            if not target.exists():
                shutil.copyfile(source, target)
            state["additionalInputs"].append({"source": str(source), "captured": str(target), "sha256": sha})
        env = dict(os.environ, TMPDIR=str(temporary), TMP=str(temporary), TEMP=str(temporary),
                   RNR_STORAGE_SESSION=str(state_path), RNR_STORAGE_NONCE=nonce)
        baselines = {str(p): set(p.iterdir()) if p.exists() else set() for p in map(Path, dynamic)}
        tracked = [temporary, *map(Path, tracks)]
        if evidence:
            tracked.append(Path(evidence))
        paths = tracked[:]
        for path, previous in baselines.items():
            parent = Path(path)
            if parent.exists():
                paths.extend(set(parent.iterdir()) - previous)
        with timed_phase(timings, "initialRunAllocation"):
            initial_allocation = allocated(paths)
        state["initialAllocatedBytes"] = initial_allocation
        if initial_allocation > policy.run_limit:
            raise RuntimeError("Existing workspace exceeds its run budget; no process started")
        state["startupTiming"] = {"elapsedMs": round((time.perf_counter() - startup_started) * 1000, 3),
                                  "phases": timings, "scope": "Inclusive monotonic durations; nested phases overlap"}
        write_json(state_path, state)
        child = None
        exceeded = False
        tick = 0
        stopped_at = None
        previous_handler = signal.getsignal(signal.SIGTERM)
        def interrupted(_signal, _frame):
            raise KeyboardInterrupt("Qualification owner was interrupted")
        signal.signal(signal.SIGTERM, interrupted)
        try:
            child = subprocess.Popen(command, cwd=project, env=env, start_new_session=True)
            state.update(status="running", childPid=child.pid)
            write_json(state_path, state)
            while child.poll() is None:
                free = free_space(project)
                state.update(availableBytes=free, minimumObservedBytes=min(free, state.get("minimumObservedBytes", free)))
                paths = tracked[:]
                for path, previous in baselines.items():
                    parent = Path(path)
                    if parent.exists():
                        paths.extend(set(parent.iterdir()) - previous)
                state["ownedOutputs"] = sorted(set(state["ownedOutputs"]) | {
                    str(p.absolute()) for path, previous in baselines.items()
                    if Path(path).exists() for p in set(Path(path).iterdir()) - previous
                })
                if tick % 5 == 0:
                    state["allocatedBytes"] = allocated(paths)
                    state["peakAllocatedBytes"] = max(state["allocatedBytes"], state.get("peakAllocatedBytes", 0))
                reason = "free-space-reserve" if free < policy.reserve else "run-budget" if state.get("allocatedBytes", 0) > policy.run_limit else None
                if reason and (not exceeded or state.get("action") == "waiting-for-active-child-or-rollback"):
                    exceeded = True
                    state.update(status="stopping-for-storage", reason=reason,
                                 action=stop_owned_child(child, project, kind))
                    stopped_at = stopped_at or time.monotonic()
                elif exceeded and free < policy.reserve // 2:
                    state["action"] = stop_owned_child(child, project, "qualification")
                if exceeded and kind != "runtime-update" and time.monotonic() - stopped_at > 5:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                write_json(state_path, state)
                time.sleep(policy.poll_seconds)
                tick += 1
            code = child.wait()
        except BaseException as error:
            state.update(status="interrupted", error=type(error).__name__, finishedAt=time.time())
            write_json(state_path, state)
            raise
        finally:
            # Cleanup failure is an interruption, never a pass. Preserve its
            # evidence and restore the caller's signal handler before raising.
            try:
                if child:
                    terminate_group(child)
            except BaseException as error:
                state.update(status="interrupted", phase="cleanup",
                             cleanupError={"type": type(error).__name__, "message": str(error)},
                             childExitCode=child.poll() if child else None, finishedAt=time.time())
                write_json(state_path, state)
                raise
            finally:
                signal.signal(signal.SIGTERM, previous_handler)
        state.update(status="storage-limit" if exceeded else "passed" if code == 0 else "failed",
                     exitCode=code, finishedAt=time.time())
        # A fast command can create its output between the final two polls.
        state["ownedOutputs"] = sorted(set(state["ownedOutputs"]) | {
            str(p.absolute()) for path, previous in baselines.items()
            if Path(path).exists() for p in set(Path(path).iterdir()) - previous
        })
        state["allocatedBytes"] = allocated([*tracked, *map(Path, state["ownedOutputs"])])
        state["peakAllocatedBytes"] = max(state["allocatedBytes"], state.get("peakAllocatedBytes", 0))
        write_json(state_path, state)
        if state["allocatedBytes"] > policy.run_limit or free_space(project) < policy.reserve:
            exceeded = True
            state.update(status="storage-limit", reason="terminal-storage-check")
        for item in state["additionalInputs"]:
            if digest(item["source"]) != item["sha256"] or digest(item["captured"]) != item["sha256"]:
                raise ValueError("Qualification storage input changed during execution")
        if digest(runner) != state["runnerInput"]["sha256"]:
            raise ValueError("Qualification storage runner changed during execution")
        if code == 0 and not exceeded:
            sealed = evidence and (Path(evidence) / "qualification.json").exists() and (Path(evidence) / "files.json").exists()
            if sealed:
                proof = json.loads((Path(evidence) / "qualification.json").read_text())
                sealed = proof.get("status") == "passed"
                if sealed:
                    retained = captured_paths(Path(evidence), required_files(Path(evidence), digest(Path(evidence) / "files.json")))
                    state["retiredDependencyCaches"] = prune_dependency_caches(Path(evidence), retained)
            if sealed or cleanup_success:
                try:
                    if temporary.is_symlink() or temporary.resolve() != temporary:
                        raise ValueError("Temporary cleanup root changed ownership")
                    if evidence:
                        durable = Path(evidence).resolve()
                        if durable.is_relative_to(temporary) or temporary.is_relative_to(durable):
                            raise ValueError("Retained evidence overlaps disposable temporary data")
                    # The direct child's process group has ended. Detached users
                    # and denied process/open-file inspections still block removal.
                    assert_quiescent(temporary)
                    shutil.rmtree(temporary)
                    state["temporaryEnvironmentRetired"] = True
                    if not any(workspace.iterdir()):
                        workspace.rmdir()
                except BaseException as error:
                    state.update(status="interrupted", phase="temporary-cleanup",
                                 cleanupError={"type": type(error).__name__, "message": str(error)},
                                 finishedAt=time.time())
                    write_json(state_path, state)
                    raise
        write_json(state_path, state)
        if exceeded:
            print("Qualification storage limit reached during execution: " + str(state.get("reason", "unknown")), file=sys.stderr)
        return 75 if exceeded else code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    run = commands.add_parser("run")
    run.add_argument("--project", required=True)
    run.add_argument("--store", required=True)
    run.add_argument("--evidence")
    run.add_argument("--track", action="append", default=[])
    run.add_argument("--dynamic", action="append", default=[])
    run.add_argument("--identity", default="default")
    run.add_argument("--kind", default="qualification")
    run.add_argument("--run-limit-gib", type=int, choices=range(1, 13), default=12,
                     help="Lower this run maximum; retain the effective store policy and startup floor")
    run.add_argument("--retained-headroom-gib", type=int, choices=range(0, 65), default=0)
    run.add_argument("--lock-wait-seconds", type=int, choices=range(121), default=0, metavar="0..120",
                     help="Wait for the serial storage owner before starting a worker")
    run.add_argument("--cleanup-success", action="store_true")
    run.add_argument("--cold-temporary-history", action="store_true",
                     help="Enroll only this run's later archived private temporary tree for exact indexed restore")
    run.add_argument("--input", action="append", default=[])
    run.add_argument("command", nargs=argparse.REMAINDER)
    pack = commands.add_parser("archive")
    pack.add_argument("--root", required=True)
    pack.add_argument("--store", required=True)
    pack.add_argument("--manifest-sha256", required=True)
    pack.add_argument("--retire", action="store_true")
    pack.add_argument("--preserve-links", action="store_true")
    restore = commands.add_parser("restore")
    restore.add_argument("--archive", required=True)
    restore.add_argument("--destination", required=True)
    restore.add_argument("--sha256", required=True)
    restore.add_argument("--store")
    restore.add_argument("--restore-links", action="store_true")
    status = commands.add_parser("status")
    status.add_argument("--store", required=True)
    configure = commands.add_parser("configure")
    configure.add_argument("--store", required=True)
    configure.add_argument("--workspace", required=True)
    configure.add_argument("--history-limit-gib", type=int, choices=range(1, MAX_CONFIGURED_HISTORY_GIB + 1), required=True)
    configure.add_argument("--authorization", required=True)
    admit = commands.add_parser("admit")
    admit.add_argument("--store", required=True)
    admit.add_argument("--project", required=True)
    admit.add_argument("--run-limit-gib", type=int, choices=range(1, 13), default=12)
    admit.add_argument("--retained-headroom-gib", type=int, choices=range(0, 65), default=0)
    session = commands.add_parser("session")
    session.add_argument("--store")
    prune = commands.add_parser("prune-caches")
    prune.add_argument("--root", required=True)
    prune.add_argument("--proof", required=True)
    prune.add_argument("--archive-sha256", required=True)
    args = parser.parse_args()
    if args.action == "run":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            raise ValueError("Choose an explicit qualification command")
        if os.environ.get("RNR_STORAGE_SESSION"):
            state = inherited_session(args.store)
            namespaces = [Path(state["tmp"]), *map(Path, state.get("ownedOutputs", []))]
            for path in [*args.track, *args.dynamic, *([args.evidence] if args.evidence else [])]:
                if not any(Path(path).resolve().is_relative_to(parent.resolve()) for parent in namespaces):
                    raise ValueError("Nested run output escapes its existing storage owner")
            print(json.dumps({"status": "inherited", "policy": state["policy"],
                              "policyProvenance": state.get("policyProvenance", {"kind": "historical-owner-record"})}), flush=True)
            return subprocess.call(command, cwd=args.project)
        policy, provenance = effective_policy(args.store)
        policy = dataclasses.replace(policy, run_limit=args.run_limit_gib * GIB)
        print(json.dumps({"status": "launching", **policy_report(policy, provenance)}), flush=True)
        return guard_run(args.project, args.store, command, args.evidence, args.track, args.dynamic,
                         args.identity, args.kind, args.cleanup_success, policy=policy, inputs=args.input,
                         retained_headroom=args.retained_headroom_gib * GIB, policy_provenance=provenance,
                         cold_temporary_history=args.cold_temporary_history, lock_wait_seconds=args.lock_wait_seconds)
    if args.action == "configure":
        print(json.dumps(configure_policy(args.store, args.workspace, args.history_limit_gib, args.authorization)))
    elif args.action == "session":
        state = inherited_session(args.store)
        print(json.dumps({"status": "inherited", "policy": state["policy"],
                          "policyProvenance": state.get("policyProvenance", {"kind": "historical-owner-record"})}))
    elif args.action == "admit":
        store = ensure_store(args.store)
        policy, provenance = effective_policy(store)
        policy = dataclasses.replace(policy, run_limit=args.run_limit_gib * GIB)
        assert_policy_scope(args.project, provenance)
        timings = {}
        with exclusive(store / "active.lock"):
            with timed_phase(timings, "admission"):
                result = admission(Path(args.project), store, policy, args.retained_headroom_gib * GIB, timings=timings)
        print(json.dumps({"status": "admissible", **result, "timingPhases": timings, **policy_report(policy, provenance)}))
    elif args.action == "prune-caches":
        print(json.dumps(prune_owned_lane_caches(args.root, args.proof, args.archive_sha256)))
    elif args.action == "archive":
        root = Path(args.root).absolute()
        store = ensure_store(args.store)
        with exclusive(store / "active.lock"):
            assert_archive_scope(root, store)
            policy, provenance = effective_policy(store)
            assert_policy_scope(root, provenance)
            if args.retire:
                assert_quiescent(root)
            record = archive_tree(root, store, policy, expected=args.manifest_sha256, retire=args.retire,
                                  before_retire=(lambda: assert_quiescent(root)) if args.retire else None,
                                  policy_provenance=provenance, preserve_links=args.preserve_links)
            print(json.dumps(record))
    elif args.action == "restore":
        store = ensure_store(args.store or Path(args.archive).resolve().parent.parent)
        with exclusive(store / "active.lock"):
            policy, provenance = effective_policy(store)
            assert_policy_scope(args.destination, provenance)
            original = Path(args.archive).absolute()
            source = contextlib.nullcontext(original)
            if not original.exists():
                from qualification_capacity import archive_file
                source = archive_file(store, original, args.sha256, policy)
            with source as original:
                logical = sum(x["size"] for x in validate_archive(original, policy.run_limit)["files"])
                if retained_usage(store) + logical > policy.history_limit:
                    raise RuntimeError("Restoration exceeds the retained history budget")
                restore_tree(original, args.destination, args.sha256, policy, restore_links=args.restore_links)
        print(json.dumps({"status": "restored-and-verified", "destination": args.destination,
                          **policy_report(policy, provenance)}))
    else:
        store = ensure_store(args.store)
        policy, provenance = effective_policy(store)
        print(json.dumps({"availableBytes": available(store), **policy_report(policy, provenance),
                          "retainedBytes": retained_usage(store),
                          "workspaceBytes": allocated(list((store / "workspaces").glob("*"))),
                          "historyBytes": sum(p.stat().st_size for p in (store / "history").glob("*.zip"))}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(75)
