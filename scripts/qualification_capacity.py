"""Capacity preview and bounded lossless maintenance for the qualification owner."""
import argparse
import base64
import contextlib
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import struct
import tempfile
import time
import zipfile

import qualification_storage as owner

MIB = 1024**2
MIN_SHARED_PAYLOAD = 4096
SCHEMA = "rnr-exact-history-zip-chunks/v1"
HEX = re.compile(r"[a-f0-9]{64}")


def canonical(path, root):
    if path.resolve() != path or not path.is_relative_to(root):
        raise ValueError(f"Unexpected storage path {path}")
    return path


@contextlib.contextmanager
def preview_lock(path):
    # A configured store already has the normal owner lock. Shared readers use
    # a read-only descriptor and yield immediately to an exclusive runner.
    try:
        stream = path.open("rb")
    except FileNotFoundError:
        with owner.exclusive(path):
            yield
        return
    with stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another managed qualification is active") from None
        yield


@contextlib.contextmanager
def maintenance_lock(store, wait_seconds=0, acquire=owner.exclusive):
    deadline = time.monotonic() + wait_seconds
    with contextlib.ExitStack() as stack:
        while True:
            try:
                stack.enter_context(acquire(store / "active.lock"))
                break
            except RuntimeError as error:
                if str(error) != "Another managed qualification is active" or time.monotonic() >= deadline:
                    raise
                time.sleep(1)
        yield


def read_manifest(store, record):
    storage = record["storage"]
    root = store / "history" / "zip-chunks"
    path = canonical(Path(storage["manifest"]), root)
    if storage["format"] != SCHEMA or owner.digest(path) != storage["manifestSha256"]:
        raise ValueError("Changed archive manifest")
    manifest = json.loads(gzip.decompress(path.read_bytes()))
    if (manifest["schema"] != SCHEMA or manifest["archiveSha256"] != record["sha256"]
            or manifest["originalArchive"] != record["archive"] or manifest["archiveBytes"] != record["archiveBytes"]):
        raise ValueError("Archive identity differs from its index")
    return manifest


def replay(store, manifest, output=None):
    root = store / "history" / "zip-chunks"
    whole = hashlib.sha256()
    size = 0
    with contextlib.ExitStack() as stack:
        streams = {}
        for name, offset, length, expected in manifest["segments"]:
            if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts or offset < 0 or length <= 0:
                raise ValueError("Invalid archive segment")
            if name not in streams:
                streams[name] = stack.enter_context(canonical(root / name, root).open("rb"))
            stream = streams[name]
            stream.seek(offset)
            piece = hashlib.sha256()
            remaining = length
            while remaining:
                data = stream.read(min(MIB, remaining))
                if not data:
                    raise ValueError("Truncated archive segment")
                piece.update(data)
                whole.update(data)
                if output is not None:
                    output.write(data)
                remaining -= len(data)
            if piece.hexdigest() != expected:
                raise ValueError("Archive segment digest mismatch")
            size += length
    if size != manifest["archiveBytes"] or whole.hexdigest() != manifest["archiveSha256"]:
        raise ValueError("Reconstruction differs from the captured ZIP")


@contextlib.contextmanager
def archive_file(store, path, sha, policy):
    if path.exists():
        yield path
        return
    canonical(path, store / "history")
    if path.parent != store / "history" or not HEX.fullmatch(path.stem) or path.suffix != ".zip":
        raise ValueError("Unknown archive identity")
    record = json.loads(canonical(store / "index" / (path.stem + ".json"), store).read_bytes())
    if record["archive"] != str(path) or record["sha256"] != sha:
        raise ValueError("Unexpected original ZIP or digest")
    manifest = read_manifest(store, record)
    size = manifest["archiveBytes"]
    owner.check_space(store, policy, size)
    if size > policy.run_limit or owner.retained_usage(store) + size > policy.history_limit:
        raise RuntimeError("Insufficient capacity to materialize the archive")
    with tempfile.TemporaryDirectory(dir=store, prefix="restore-zip-") as temporary:
        original = Path(temporary) / path.name
        with original.open("xb") as target:
            replay(store, manifest, target)
            target.flush()
            os.fsync(target.fileno())
        yield original


def maintenance_band(policy):
    # The maintenance band is advisory. Ordinary guards retain the full policy.
    return (policy.history_limit * 9 // 10, policy.history_limit * 7 // 8)


def preview(project, store, policy, stages, recovery):
    retained = owner.retained_usage(store)
    free = owner.available(project)
    high, low = maintenance_band(policy)
    result = []
    carry = 0
    for name, budget, kept in stages:
        if not name or not 1 <= budget <= 12 or not 0 <= kept <= budget * 1024:
            raise ValueError("Stage needs a name, a 1..12 GiB budget and 0..budget MiB retained")
        budget *= owner.GIB
        required = owner.required_available(policy, budget, recovery)
        result.append({"stage": name, "runBytes": budget, "additionalRetainedBeforeBytes": carry,
                       "retainAfterStageMiB": kept, "volumeShortfallBytes": max(0, required + carry - free),
                       "retainedShortfallBytes": max(0, retained + carry + budget + recovery - policy.history_limit)})
        carry += kept * MIB
    return {"status": "capacity-refused" if any(r["volumeShortfallBytes"] or r["retainedShortfallBytes"] for r in result)
            else "capacity-available", "retainedBytes": retained, "availableBytes": free, "recoveryBytes": recovery,
            "maintenanceDue": retained >= high, "maintenanceTriggerBytes": high, "maintenanceTargetBytes": low,
            "stages": result}


def pool_from_indexes(store):
    pool = {}
    for index in (store / "index").glob("*.json"):
        r = json.loads(index.read_bytes())
        if r.get("storage", {}).get("format") == SCHEMA:
            for seg in read_manifest(store, r)["segments"]:
                if seg[2] >= MIN_SHARED_PAYLOAD:
                    pool.setdefault((seg[3], seg[2]), seg)
    return pool


def spans(path):
    # Preserve local headers, descriptors, central directory, and compressed payload bytes.
    cursor = 0
    with zipfile.ZipFile(path) as archive, path.open("rb") as source:
        for member in sorted(archive.infolist(), key=lambda item: item.header_offset):
            if member.compress_size < MIN_SHARED_PAYLOAD:
                continue
            source.seek(member.header_offset)
            header = source.read(30)
            if header[:4] != b"PK\x03\x04":
                raise ValueError("Invalid local file header")
            name, extra = struct.unpack_from("<HH", header, 26)
            start = member.header_offset + 30 + name + extra
            if not cursor <= start <= start + member.compress_size <= path.stat().st_size:
                raise ValueError("Overlapping ZIP members")
            if start > cursor:
                yield cursor, start - cursor
            yield start, member.compress_size
            cursor = start + member.compress_size
    if cursor < path.stat().st_size:
        yield cursor, path.stat().st_size - cursor


def copy_span(source, offset, length, target=None):
    h = hashlib.sha256()
    source.seek(offset)
    remaining = length
    while remaining:
        block = source.read(min(remaining, MIB))
        if not block:
            raise ValueError("Source ZIP changed")
        h.update(block)
        if target is not None:
            target.write(block)
        remaining -= len(block)
    return h.hexdigest()


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def compact(store, identity, expected, pool, retained, policy):
    if not HEX.fullmatch(identity) or not HEX.fullmatch(expected):
        raise ValueError("Invalid archive identity or digest")
    index = canonical(store / "index" / (identity + ".json"), store)
    original = canonical(store / "history" / (identity + ".zip"), store)
    original_index = index.read_bytes()
    r = json.loads(original_index)
    if r.get("status") != "archived" or r["sha256"] != expected or r["archive"] != str(original):
        raise ValueError("Selection differs from the terminal archive index")
    if "storage" in r:
        manifest = read_manifest(store, r)
        if original.exists():
            replay(store, manifest)
            if owner.digest(original) != expected:
                raise ValueError("Interrupted retirement has a changed ZIP")
            original.unlink()
            sync_directory(original.parent)
        return {"identity": identity, "status": "already-packed", "savedBytes": 0}
    before = original.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != r["archiveBytes"]:
        raise ValueError("Unexpected source ZIP type or size")
    cas = canonical(store / "history" / "zip-chunks", store)
    cas.mkdir(exist_ok=True)
    directory = cas / ("capacity-" + identity)
    canonical(directory, cas)
    # Private staging from an interrupted pre-commit attempt contains no authoritative files.
    # Keep such a directory for inspection. A new attempt uses a new exclusive directory.
    directory = Path(tempfile.mkdtemp(prefix=directory.name + "-", dir=cas))
    pack = directory / "archive.pack"
    manifest_path = directory / "archive.json.gz"
    committed = False
    try:
        segs = []
        additions = {}
        slack = min(policy.history_limit - retained, owner.available(store) - max(policy.reserve, policy.startup_floor), policy.run_limit)
        with original.open("rb") as source, pack.open("xb") as out:
            for offset, length in spans(original):
                sha = copy_span(source, offset, length)
                key = (sha, length)
                seg = pool.get(key) or additions.get(key)
                if seg is None:
                    if out.tell() + length + 8 * MIB > slack:
                        raise RuntimeError("Insufficient temporary space for verified compaction")
                    seg = [str(pack.relative_to(cas)), out.tell(), length, sha]
                    copy_span(source, offset, length, out)
                    additions[key] = seg
                segs.append(seg)
            out.flush()
            os.fsync(out.fileno())
        manifest = {"schema": SCHEMA, "archiveSha256": expected, "archiveBytes": before.st_size,
                    "originalArchive": str(original), "originalMode": stat.S_IMODE(before.st_mode),
                    "originalMtimeNs": before.st_mtime_ns, "sourceIndexBase64": base64.b64encode(original_index).decode(),
                    "segments": segs}
        encoded = gzip.compress(json.dumps(manifest, separators=(",", ":")).encode(), mtime=0)
        if len(encoded) + pack.stat().st_size + MIB > slack:
            raise RuntimeError("Insufficient capacity for packed manifest")
        with manifest_path.open("xb") as out:
            out.write(encoded)
            out.flush()
            os.fsync(out.fileno())
        after = pack.stat().st_blocks * 512 + manifest_path.stat().st_blocks * 512
        r["storage"] = {"format": SCHEMA, "manifest": str(manifest_path), "manifestSha256": owner.digest(manifest_path),
                        "originalZipBytesVerifiedBeforeRetirement": True}
        replay(store, read_manifest(store, r))
        observed = original.stat()
        if index.read_bytes() != original_index or (observed.st_dev, observed.st_ino, observed.st_mtime_ns,
                observed.st_size, observed.st_mode) != (before.st_dev, before.st_ino, before.st_mtime_ns,
                before.st_size, before.st_mode):
            raise ValueError("Archive or index changed during verification")
        if owner.digest(original) != expected:
            raise ValueError("Original ZIP differs from its indexed digest")
        sync_directory(directory)
        sync_directory(cas)
        owner.write_json(index, r)
        committed = True
        with index.open("rb") as stream:
            os.fsync(stream.fileno())
        sync_directory(index.parent)
        original.unlink()
        sync_directory(original.parent)
        pool.update({k: v for k, v in additions.items() if k[1] >= MIN_SHARED_PAYLOAD})
        return {"identity": identity, "status": "exact-zip-verified", "sha256": expected,
                "savedBytes": before.st_blocks * 512 - after}
    finally:
        if not committed:
            for path in (manifest_path, pack):
                path.unlink(missing_ok=True)
            directory.rmdir()


def managed_scratch(store):
    for path in (store / "states").glob("*.json"):
        state = json.loads(path.read_bytes())
        if (state.get("coldTemporaryHistory") is not True or not state.get("temporaryEnvironmentRetired")
                or state.get("status") not in ("passed", "failed", "interrupted", "storage-limit")):
            continue
        record = state.get("temporaryArchive") or {}
        tmp = store / "workspaces" / path.stem / "tmp"
        archive = Path(record.get("archive", ""))
        if (state.get("tmp") == str(tmp) and record.get("source") == str(tmp)
                and record.get("status") == "archived" and archive.parent == store / "history"
                and HEX.fullmatch(archive.stem) and archive.suffix == ".zip"):
            yield {"identity": archive.stem, "sha256": record["sha256"], "source": str(tmp)}


def next_selected(store, selection):
    if selection["store"] != str(store):
        raise ValueError("Selection belongs to another store")
    from itertools import chain
    future = managed_scratch(store) if selection.get("includeManagedScratch") is True else ()
    seen = set()
    for item in chain(selection["archives"], future):
        identity = item["identity"]
        if not HEX.fullmatch(identity) or not HEX.fullmatch(item["sha256"]):
            raise ValueError("Invalid enrolled archive identity")
        if identity in seen:
            continue
        seen.add(identity)
        if (store / "history" / (identity + ".zip")).exists():
            record = json.loads(canonical(store / "index" / (identity + ".json"), store).read_bytes())
            if "source" in item and record.get("source") != item["source"]:
                raise ValueError("Enrolled archive source differs from its index")
            # A previously packed archive may have been explicitly made hot again.
            if "storage" not in record:
                yield item


def maintain_before_run(store, policy, registration, retained):
    # Called under the existing owner lock. Enrollment explicitly opts in specific
    # cold archive hashes. Limit work on the launch path to one small archive.
    high, low = maintenance_band(policy)
    cycle = canonical(store / "maintenance" / "cold-history-cycle.json", store)
    active = cycle.exists() and json.loads(cycle.read_bytes()).get("active") is True
    if retained <= low:
        if active:
            owner.write_json(cycle, {"active": False, "retainedBytes": retained})
            return {"status": "maintenance-cycle-closed"}
        return None
    if retained < high and not active:
        return None
    if not active:
        owner.write_json(cycle, {"active": True, "retainedBytes": retained})
    selection = json.loads(canonical(registration, store).read_bytes())
    for item in next_selected(store, selection):
        archive = store / "history" / (item["identity"] + ".zip")
        if archive.stat().st_size <= 96 * MIB:
            return compact(store, item["identity"], item["sha256"], pool_from_indexes(store), retained, policy)
    # Selection may have inspected many retained outputs or opened a new cycle.
    # Refresh the measurement before admitting a child.
    return {"status": "no-eligible-cold-archive"}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--wait-seconds", type=int, choices=range(121), default=0, metavar="0..120")
    sub = parser.add_subparsers(dest="command", required=True)
    size = sub.add_parser("footprint")
    size.add_argument("--project", type=Path, required=True)
    size.add_argument("--path", type=Path, action="append", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--project", type=Path, required=True)
    plan.add_argument("--stage", nargs=3, action="append", required=True, metavar=("NAME", "RUN_GIB", "RETAIN_MIB"))
    plan.add_argument("--recovery-gib", type=int, choices=range(65), default=2)
    verify = sub.add_parser("verify-restore")
    verify.add_argument("--identity", required=True)
    verify.add_argument("--sha256", required=True)
    maintenance = sub.add_parser("maintain")
    maintenance.add_argument("--selection", type=Path, required=True, help="Reviewed cold archive IDs and original SHA-256")
    maintenance.add_argument("--limit", type=int, choices=range(1, 101), default=4)
    args = parser.parse_args()
    store = owner.ensure_store(args.store)
    policy, provenance = owner.effective_policy(store)
    if args.command == "footprint":
        project = args.project.resolve()
        owner.assert_policy_scope(project, provenance)
        roots = [canonical(project / p, project) for p in args.path]
        print(json.dumps({"allocatedBytes": owner.allocated(roots)}))
        return 0
    if args.command == "plan":
        owner.assert_policy_scope(args.project, provenance)
        with maintenance_lock(store, args.wait_seconds, preview_lock):
            values = preview(args.project, store, policy, [(n, int(b), int(k)) for n, b, k in args.stage], args.recovery_gib * owner.GIB)
        print(json.dumps(values))
        return 0 if values["status"] == "capacity-available" else 75
    if args.command == "verify-restore":
        if not HEX.fullmatch(args.identity) or not HEX.fullmatch(args.sha256):
            raise ValueError("Expected the original archive identity and SHA-256")
        archive = store / "history" / (args.identity + ".zip")
        with maintenance_lock(store, args.wait_seconds), archive_file(store, archive, args.sha256, policy) as original:
            metadata = owner.validate_archive(original, policy.run_limit)
            logical = sum(r["size"] for r in metadata["files"])
            if owner.retained_usage(store) + logical > policy.history_limit:
                raise RuntimeError("Restoration exceeds the retained history budget")
            with tempfile.TemporaryDirectory(dir=store, prefix="restore-check-") as tmp:
                owner.restore_tree(original, Path(tmp) / "tree", args.sha256, policy, restore_links=True)
        print(json.dumps({"status": "restored-and-verified", "archiveSha256": args.sha256,
                          "files": len(metadata["files"]), "logicalBytes": logical}))
        return 0
    selection = json.loads(args.selection.read_bytes())
    if selection["store"] != str(store):
        raise ValueError("Selection belongs to another store")
    high, low = maintenance_band(policy)
    with maintenance_lock(store, args.wait_seconds):
        retained = owner.retained_usage(store)
        pool = pool_from_indexes(store) if retained > low else {}
    count = 0
    if retained >= high or selection.get("continueToTarget") is True:
        pending = iter(next_selected(store, selection))
        while count < args.limit and retained > low:
            # Recheck once per bounded group under the normal owner. Leave a window
            # for queued device work before trying to acquire another group.
            with maintenance_lock(store, args.wait_seconds):
                retained = owner.retained_usage(store)
                processed = 0
                started = time.monotonic()
                while count < args.limit and retained > low and processed < 8 and time.monotonic() - started < 4:
                    item = next(pending, None)
                    if item is None:
                        break
                    result = compact(store, item["identity"], item["sha256"], pool, retained, policy)
                    print(json.dumps(result), flush=True)
                    retained += MIB - result["savedBytes"]  # bound index/metadata allocation until the next scan
                    count += 1
                    processed += 1
            if not processed:
                break
            time.sleep(2)
    with maintenance_lock(store, args.wait_seconds):
        final_retained = owner.retained_usage(store)
    print(json.dumps({"archives": count, "retainedBytes": final_retained, "targetBytes": low}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(75)
