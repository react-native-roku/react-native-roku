"""Path-preserving compression of private cache objects and enrolled cold evidence on macOS."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

import qualification_storage as owner
from qualification_capacity import SCHEMA, maintenance_lock, maintenance_band, read_manifest


def xattrs(path):
    # macOS Python distributions do not all expose os.listxattr.
    libc = ctypes.CDLL(None, use_errno=True)
    name = os.fsencode(path)
    def call(func, *args):
        value = func(*args)
        if value < 0:
            raise OSError(ctypes.get_errno(), "unable to verify extended attributes")
        return value
    length = call(libc.listxattr, name, None, 0, 1)
    names = ctypes.create_string_buffer(length)
    call(libc.listxattr, name, names, length, 1)
    values = {}
    for key in names.raw.split(b"\0"):
        if not key:
            continue
        size = call(libc.getxattr, name, key, None, 0, 0, 1)
        value = ctypes.create_string_buffer(size)
        call(libc.getxattr, name, key, value, size, 0, 1)
        values[key] = value.raw
    return values


def file_hash(path, algorithm):
    digest = hashlib.new(algorithm)
    with path.open("rb") as f:
        while block := f.read(1024**2):
            digest.update(block)
    return digest.hexdigest()


def compress_file(store, path, algorithm, digest, policy, headroom):
    before = path.lstat()
    if before.st_uid != os.getuid() or before.st_dev != store.stat().st_dev or before.st_nlink != 1 or before.st_flags or not stat.S_ISREG(before.st_mode) or path.resolve() != path:
        return 0
    # Retain existing forks, ACLs, immutable flags, and linked entries in-place.
    attrs = xattrs(path)
    if set(attrs) - {b"com.apple.provenance"}:
        return 0
    acl = subprocess.check_output(["/bin/ls", "-lde", str(path)])
    if len(acl.splitlines()) > 1:
        return 0
    size = before.st_size
    # This operation only keeps smaller representations. Bound the temporary coexistence.
    if size + 2*1024**2 > headroom:
        return 0
    if owner.available(store) - size - 2*1024**2 < max(policy.reserve, policy.startup_floor):
        return 0
    with tempfile.TemporaryDirectory(dir=store, prefix="compress-cache-") as work:
        dst = Path(work) / "payload"
        subprocess.run(["/usr/bin/ditto", "--noclone", "--hfsCompression", str(path), str(dst)], check=True)
        after = dst.stat()
        gain = (before.st_blocks - after.st_blocks) * 512
        if gain <= 0 or not after.st_flags & 0x20:
            return 0
        if (before.st_size, before.st_mode, before.st_uid, before.st_gid, before.st_mtime_ns) != (
                after.st_size, after.st_mode, after.st_uid, after.st_gid, after.st_mtime_ns):
            return 0
        dest_attrs = xattrs(dst)
        for internal in (b"com.apple.decmpfs", b"com.apple.ResourceFork"):
            dest_attrs.pop(internal, None)
        if dest_attrs != attrs:
            return 0
        if file_hash(dst, algorithm) != digest or file_hash(path, algorithm) != digest:
            raise ValueError("Candidate differs from its verified content digest")
        current = path.lstat()
        if current.st_ino != before.st_ino or current.st_ctime_ns != before.st_ctime_ns:
            raise ValueError("Candidate changed during compaction")
        with dst.open("rb") as f:
            os.fsync(f.fileno())
        os.replace(dst, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return gain


def cache_rows(root):
    if root.resolve() != root or not root.is_dir():
        raise ValueError("No canonical content-addressed cache")
    rows = []
    for path in root.glob("*/*"):
        info = path.lstat()
        if (path.resolve() == path and re.fullmatch("[0-9a-f]{2}", path.parent.name)
                and re.fullmatch("[0-9a-f]{126}(-exec)?", path.name)
                and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and info.st_flags == 0 and info.st_size >= 32768):
            rows.append((info.st_blocks, path, (path.parent.name + path.name).removesuffix("-exec")))
    return [(path, "sha512", digest) for _, path, digest in sorted(rows, reverse=True)]


def cold_files(store, selection, provenance):
    value = json.loads(selection.read_bytes())
    if value["store"] != str(store):
        raise ValueError("Cold file selection belongs to a different store")
    roots = [Path(p) for p in value["roots"]]
    history = store / "history"
    if roots == [history]:
        rows = []
        referenced_packs = set()
        if any(Path(item["path"]).suffix == ".pack" for item in value["files"]):
            for index in (store / "index").glob("*.json"):
                record = json.loads(index.read_bytes())
                if record.get("storage", {}).get("format") == SCHEMA:
                    manifest = read_manifest(store, record)
                    referenced_packs.update(history / "zip-chunks" / seg[0] for seg in manifest["segments"])
        for item in value["files"]:
            path = Path(item["path"])
            if not re.fullmatch("[a-f0-9]{64}", item["sha256"]):
                raise ValueError("Invalid selected file digest")
            if path in referenced_packs:
                if not path.is_relative_to(history / "zip-chunks") or path.resolve() != path or path.suffix != ".pack":
                    raise ValueError("Unexpected referenced pack location")
            else:
                if path.parent != history or not re.fullmatch(r"[0-9a-f]{64}\.zip", path.name):
                    raise ValueError("Expected a standalone indexed ZIP or referenced immutable pack")
                record_path = store / "index" / (path.stem + ".json")
                if record_path.resolve() != record_path:
                    raise ValueError("Linked archive index")
                record = json.loads(record_path.read_bytes())
                if record["archive"] != str(path) or record["sha256"] != item["sha256"]:
                    raise ValueError("Selection differs from indexed archive")
            if path.exists() and path.resolve() == path and not path.lstat().st_flags:
                rows.append((path, "sha256", item["sha256"]))
        return rows
    registered = set()
    dependency_roots = set()
    for state in (store / "states").glob("*.json"):
        r = json.loads(state.read_bytes())
        if r["status"] in ("passed", "failed", "interrupted", "storage-limit"):
            registered.update(r["ownedOutputs"])
            project = Path(r["project"])
            if str(project / "node_modules") in r["ownedOutputs"]:
                dependency_roots.add(project / "node_modules")
    for root in roots:
        owner.assert_policy_scope(root, provenance)
        if root.resolve() != root or (".local" not in root.parts and root not in dependency_roots):
            raise ValueError("Cold output must be an exact private cohort or terminal registered dependency tree")
    rows = []
    for row in value["files"]:
        path = Path(row["path"])
        if (not any(path.is_relative_to(root) for root in roots) or not re.fullmatch("[a-f0-9]{64}", row["sha256"])
                or not any(str(p) in registered for p in [path, *path.parents])):
            raise ValueError("File is outside reviewed terminal owner outputs")
        if path.exists() and path.resolve() == path and not path.lstat().st_flags:
            rows.append((path, "sha256", row["sha256"]))
    return rows


def compress_cache(store, limit, selection=None, offset=0, wait_seconds=0, user_cache=False, to_target=False):
    if sys.platform != "darwin":
        raise ValueError("Path-preserving compression uses the macOS filesystem")
    policy, provenance = owner.effective_policy(store)
    high, low = maintenance_band(policy)
    cache = store / "caches/pnpm/v11/files"
    if user_cache:
        cache = Path.home() / "Library/pnpm/store/v11/files"
        if not any(str(cache.parent) in state.get("ownedOutputs", []) and state["status"] in
                   ("passed", "failed", "interrupted", "storage-limit") for state in
                   (json.loads(p.read_bytes()) for p in (store / "states").glob("*.json"))):
            raise ValueError("The user's pnpm store is not a terminal registered output")
    rows = None if selection else cache_rows(cache)
    with maintenance_lock(store, wait_seconds):
        if selection:
            rows = cold_files(store, selection, provenance)
        retained = owner.retained_usage(store)
        if retained < low:
            return {"status": "below-target", "retainedBytes": retained}
        if retained < high and not selection and not to_target:
            return {"status": "below-trigger", "retainedBytes": retained}
        saved = changed = examined = 0
        selected = rows[offset:offset + limit]
        if user_cache:
            owner.assert_quiescent(cache.parent)
        if selection:
            for root in map(Path, json.loads(selection.read_bytes())["roots"]):
                if any(path.is_relative_to(root) for path, _, _ in selected):
                    owner.assert_quiescent(root)
        for path, algorithm, digest in selected:
            if retained - saved <= low:
                break
            gain = compress_file(store, path, algorithm, digest, policy, policy.history_limit - retained + saved)
            saved += gain
            changed += int(gain > 0)
            examined += 1
    return {"status": "finished-batch", "examined": examined, "changed": changed, "savedBytes": saved,
            "retainedBytesBefore": retained}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--limit", required=True, type=int, choices=range(1, 10001), metavar="1..10000")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--user-pnpm-cache", action="store_true", help="Explicitly select the idle, terminal-registered per-user v11 cache")
    parser.add_argument("--to-target", action="store_true", help="Continue an existing campaign below its trigger")
    group.add_argument("--selection", type=Path, help="Reviewed SHA-256 inventory of terminal private outputs")
    parser.add_argument("--offset", type=int, default=0, help="Skip rows in the current uncompressed inventory")
    parser.add_argument("--wait-seconds", type=int, choices=range(121), default=0, metavar="0..120")
    args = parser.parse_args()
    if args.offset < 0:
        parser.error("Expected a nonnegative offset")
    try:
        print(json.dumps(compress_cache(owner.ensure_store(args.store), args.limit, args.selection, args.offset, args.wait_seconds, args.user_pnpm_cache, args.to_target)))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(75)
