import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import zipfile

MODULE = Path(__file__).with_name("qualification_storage.py")
SPEC = importlib.util.spec_from_file_location("qualification_storage", MODULE)
storage = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = storage
SPEC.loader.exec_module(storage)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.environment = mock.patch.dict(os.environ)
        self.environment.start()
        # Small isolated owner fixtures are independent of the outer production monitor.
        for key in ("RNR_STORAGE_SESSION", "RNR_STORAGE_NONCE", "RNR_QUALIFICATION_RUN_LIMIT_GIB"):
            os.environ.pop(key, None)
        self.scratch = tempfile.TemporaryDirectory(prefix="rnr-storage-test-")
        self.root = Path(self.scratch.name).resolve()
        self.policy = storage.Policy(reserve=0, run_limit=8 * 1024**2, history_limit=32 * 1024**2, poll_seconds=0.02, startup_floor=0)

    def tearDown(self):
        self.scratch.cleanup()
        self.environment.stop()

    def fixture(self):
        root = self.root / "evidence"
        (root / "nested").mkdir(parents=True)
        (root / "nested/a.bin").write_bytes(b"retained\0bytes" * 100)
        (root / "copy.bin").write_bytes((root / "nested/a.bin").read_bytes())
        (root / ".hidden").write_text("hidden input")
        files = [{"path": str(p.relative_to(root)), "sha256": storage.digest(p)} for p in sorted(root.rglob("*")) if p.is_file()]
        (root / "files.json").write_text(json.dumps(files))
        return root, storage.digest(root / "files.json")

    def configured_store(self):
        store = self.root / "store"
        storage.configure_policy(store, self.root, 64, "Owner-approved fixture policy")
        return store

    def test_open_file_refusal_reports_ids_and_keeps_denied_probes_closed(self):
        for result, expected in ((subprocess.CompletedProcess([], 0, "p4321\np9876\n", ""), "processes=p4321, p9876"),
                                 (subprocess.CompletedProcess([], 2, "", "inspection denied"), "inspection denied")):
            with self.subTest(expected=expected), mock.patch.object(storage, "process_table", return_value={}), \
                    mock.patch.object(storage.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(RuntimeError, expected):
                    storage.assert_quiescent(self.root)

    def test_fresh_processes_resolve_only_the_configured_store_and_report_provenance(self):
        store = self.configured_store()
        reports = [json.loads(subprocess.check_output(
            [sys.executable, str(MODULE), "status", "--store", str(store)], text=True)) for _ in range(2)]
        self.assertEqual(reports[0]["policy"], reports[1]["policy"])
        self.assertEqual(reports[0]["policy"]["history_limit"], 64 * storage.GIB)
        self.assertEqual(reports[0]["policy"]["reserve"], 20 * storage.GIB)
        self.assertEqual(reports[0]["policy"]["startup_floor"], 32 * storage.GIB)
        self.assertEqual(reports[0]["policyProvenance"]["sha256"], storage.digest(store / "policy.json"))
        conservative, provenance = storage.effective_policy(self.root / "other-store")
        self.assertEqual(conservative.history_limit, 20 * storage.GIB)
        self.assertEqual(provenance["kind"], "conservative-default")
        explicit, provenance = storage.effective_policy(store, self.policy)
        self.assertEqual(explicit, self.policy)
        self.assertEqual(provenance["kind"], "explicit-policy")

    def test_malformed_foreign_and_symlinked_configuration_fail_closed(self):
        store = self.configured_store()
        path = store / "policy.json"
        original = json.loads(path.read_text())
        for key, value in (("historyLimitGiB", 81), ("historyLimitGiB", True), ("historyLimitGiB", "64"),
                           ("workspace", "relative"), ("workspace", str(self.root / "missing")),
                           ("store", str(self.root)), ("uid", -1), ("authorization", ""), ("schema", "old")):
            with self.subTest(key=key, value=value):
                storage.write_json(path, {**original, key: value})
                with self.assertRaises(ValueError):
                    storage.effective_policy(store)
        for value in ([], {}, {**original, "unknown": 1}):
            storage.write_json(path, value)
            with self.assertRaises(ValueError):
                storage.effective_policy(store)
        path.write_text("{broken")
        with self.assertRaises(ValueError):
            storage.effective_policy(store)
        path.unlink()
        target = self.root / "foreign-policy.json"
        storage.write_json(target, original)
        path.symlink_to(target)
        with self.assertRaises(ValueError):
            storage.effective_policy(store)
        with self.assertRaises(ValueError):
            storage.configure_policy(store, self.root, 64, "still no symlinks")

    def test_configuration_refuses_competing_or_nonterminal_owner_and_preserves_history(self):
        store = self.configured_store()
        original = (store / "policy.json").read_bytes()
        with storage.exclusive(store / "active.lock"):
            with self.assertRaises(RuntimeError):
                storage.configure_policy(store, self.root, 63, "competing")
        state = store / "states/historical.json"
        historical = {"status": "passed", "policy": {"history_limit": 20 * storage.GIB}}
        storage.write_json(state, historical)
        storage.configure_policy(store, self.root, 64, "renewed approval")
        self.assertEqual(json.loads(state.read_text()), historical)
        storage.write_json(state, {**historical, "status": "running"})
        with self.assertRaises(RuntimeError):
            storage.configure_policy(store, self.root, 63, "nonterminal")
        self.assertNotEqual((store / "policy.json").read_bytes(), original)

    def test_explicit_eighty_gib_ceiling_keeps_other_limits_and_stores_unchanged(self):
        store = self.configured_store()
        subprocess.run([sys.executable, str(MODULE), "configure", "--store", str(store),
                        "--workspace", str(self.root), "--history-limit-gib=80",
                        "--authorization=Explicit workspace cycle approval"], check=True, capture_output=True)
        report = json.loads(subprocess.check_output(
            [sys.executable, str(MODULE), "status", "--store", str(store)], text=True))
        self.assertEqual(report["policy"], {**storage.dataclasses.asdict(storage.Policy()),
                                          "history_limit": 80 * storage.GIB})
        self.assertEqual(report["policyProvenance"]["authorization"], "Explicit workspace cycle approval")
        other, provenance = storage.effective_policy(self.root / "unconfigured")
        self.assertEqual(other, storage.Policy())
        self.assertEqual(provenance["kind"], "conservative-default")
        original = (store / "policy.json").read_bytes()
        for value in (81, 0, True, "80"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                storage.configure_policy(store, self.root, value, "Cannot exceed authorization")
        self.assertEqual((store / "policy.json").read_bytes(), original)

    def test_admission_budgets_complete_recovery_and_keeps_floor_for_small_runs(self):
        store = self.configured_store()
        policy, provenance = storage.effective_policy(store)
        with mock.patch.object(storage, "retained_usage", return_value=51 * storage.GIB):
            with self.assertRaises(RuntimeError):
                storage.admission(self.root, store, policy, 2 * storage.GIB, lambda _: 100 * storage.GIB)
        with mock.patch.object(storage, "retained_usage", return_value=50 * storage.GIB):
            admitted = storage.admission(self.root, store, policy, 2 * storage.GIB, lambda _: 34 * storage.GIB)
            self.assertEqual(admitted["projectedRetainedBytes"], 64 * storage.GIB)
            with self.assertRaises(RuntimeError):
                storage.admission(self.root, store, policy, 2 * storage.GIB, lambda _: 34 * storage.GIB - 1)
            small = storage.dataclasses.replace(policy, run_limit=storage.GIB)
            with self.assertRaises(RuntimeError):
                storage.admission(self.root, store, small, 0, lambda _: 32 * storage.GIB - 1)
        with self.assertRaises(ValueError):
            storage.assert_policy_scope(self.root.parent, provenance)

    def test_allocated_counts_actual_blocks_once_across_overlaps_hardlinks_and_sparse_files(self):
        first = self.root / "first"
        second = self.root / "second"
        (first / "nested").mkdir(parents=True)
        second.mkdir()
        payload = first / "nested/payload"
        payload.write_bytes(b"data" * 10000)
        os.link(payload, second / "hardlink")
        sparse = second / "sparse"
        with sparse.open("wb") as stream:
            stream.seek(8 * 1024**2)
            stream.write(b"x")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "must-not-count").write_bytes(b"z" * 65536)
        (first / "directory-link").symlink_to(outside)
        (first / "file-link").symlink_to(outside / "must-not-count")
        (first / "dangling").symlink_to(self.root / "missing")
        os.mkfifo(first / "pipe")
        expected = (payload.stat().st_blocks + sparse.stat().st_blocks) * 512
        roots = [first, first / "nested", payload, second, first, first / "directory-link", self.root / "missing"]
        self.assertEqual(storage.allocated(roots), expected)
        before = storage.allocated(roots)
        (second / "new").write_bytes(b"growth" * 10000)
        self.assertGreater(storage.allocated(roots), before)
        (second / "new").unlink()
        self.assertEqual(storage.allocated(roots), before)

    def test_allocation_refuses_incomplete_directory_inspection_and_closes_descriptors(self):
        directory = self.root / "private"
        directory.mkdir()
        with mock.patch.object(storage.os, "open", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(PermissionError, "denied"):
                storage.allocated([directory])
        close = storage.os.close
        with mock.patch.object(storage.os, "scandir", side_effect=OSError("I/O failure")), \
                mock.patch.object(storage.os, "close", wraps=close) as closed:
            with self.assertRaisesRegex(OSError, "I/O failure"):
                storage.allocated([directory])
            closed.assert_called_once()

    def test_post_compaction_admission_is_fresh_and_refuses_growth_without_starting(self):
        marker = self.root / "must-not-start"
        store, _ = self.stale_workspaces_fixture()
        values = iter([0, self.policy.history_limit])
        with mock.patch.object(storage, "retire_stale_workspaces") as compact, \
                mock.patch.object(storage, "retained_usage", side_effect=lambda *a, **kw: next(values)) as measured:
            with self.assertRaisesRegex(RuntimeError, "Retained storage.*shortfall="):
                storage.guard_run(self.root, store, [sys.executable, "-c", f"open({str(marker)!r},'w').close()"], policy=self.policy)
        compact.assert_called_once()
        self.assertEqual(measured.call_count, 2)
        self.assertFalse(marker.exists())

    def test_no_compaction_admits_the_exact_ceiling_and_refuses_one_byte_over(self):
        recovery = 512
        limit = self.policy.history_limit - self.policy.run_limit - recovery
        for extra in (0, 1):
            store = self.root / ("boundary-" + str(extra))
            marker = self.root / ("child-" + str(extra))
            command = [sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"]
            with self.subTest(extra=extra), mock.patch.object(storage, "retained_usage", return_value=limit + extra) as scan:
                if extra:
                    with self.assertRaisesRegex(RuntimeError, "Retained storage"):
                        storage.guard_run(self.root, store, command, policy=self.policy, retained_headroom=recovery)
                else:
                    self.assertEqual(storage.guard_run(self.root, store, command, policy=self.policy, retained_headroom=recovery), 0)
                scan.assert_called_once()
                self.assertEqual(marker.exists(), extra == 0)

    def test_enrolled_cold_history_rescans_after_any_maintenance_activity(self):
        for active in (False, True):
            store = storage.ensure_store(self.root / ("enrolled-" + str(active)))
            registration = store / "maintenance/cold-archives.json"
            storage.write_json(registration, {"store": str(store), "archives": []})
            if active:
                storage.write_json(registration.with_name("cold-history-cycle.json"), {"active": True})
            samples = [0, self.policy.history_limit] if active else [0]
            with self.subTest(active=active), mock.patch.object(storage, "retained_usage", side_effect=samples) as scan:
                cmd = [sys.executable, "-c", "pass"]
                if active:
                    with self.assertRaisesRegex(RuntimeError, "Retained storage"):
                        storage.guard_run(self.root, store, cmd, policy=self.policy)
                else:
                    self.assertEqual(storage.guard_run(self.root, store, cmd, policy=self.policy), 0)
                self.assertEqual(scan.call_count, len(samples))

    def test_owner_retains_phase_timings_without_counting_child_work_as_startup(self):
        store = self.root / "store"
        self.assertEqual(storage.guard_run(self.root, store, [sys.executable, "-c", "pass"], policy=self.policy, cleanup_success=True), 0)
        state = json.loads(next((store / "states").glob("*.json")).read_text())
        timing = state["startupTiming"]
        self.assertGreaterEqual(timing["elapsedMs"], 0)
        self.assertEqual(timing["phases"]["retainedAllocation"]["calls"], 1)
        self.assertNotIn("admissionBeforeCompaction", timing["phases"])
        self.assertNotIn("temporaryCompaction", timing["phases"])
        for phase in ("retirementDiscovery", "admissionAfterCompaction", "initialRunAllocation"):
            self.assertEqual(timing["phases"][phase]["calls"], 1)
            self.assertEqual(timing["phases"][phase]["failures"], 0)

    def test_real_owner_children_inherit_policy_and_reject_tampered_sessions(self):
        store = self.root / "store"
        result_path = self.root / "session-results.json"
        entry = MODULE.with_name("qualificationStorage.mjs").as_uri()
        code = '''import json,os,subprocess,sys
from pathlib import Path
module,entry,result_path=sys.argv[1:]
command=[sys.executable,module,'session']
results={}
results['valid']=json.loads(subprocess.check_output(command,text=True))
program=f"const {{ensureQualificationStorage}}=await import({json.dumps(entry)});await ensureQualificationStorage({{projectRoot:process.cwd()}})"
results['javascript']=subprocess.run(['node','--input-type=module','-e',program],capture_output=True,text=True).returncode
for key,value in [('RNR_STORAGE_NONCE','wrong'),('TMPDIR',str(Path.cwd())),('RNR_STORAGE_SESSION',str(Path.cwd()/'missing.json'))]:
 env={**os.environ,key:value}
 results[key]=subprocess.run(command,env=env,capture_output=True,text=True).returncode
Path(result_path).write_text(json.dumps(results))
'''
        self.assertEqual(storage.guard_run(self.root, store, [sys.executable, "-c", code, str(MODULE), entry, str(result_path)],
                                          policy=self.policy, cleanup_success=True), 0)
        results = json.loads(result_path.read_text())
        self.assertEqual(results["valid"]["policy"]["history_limit"], self.policy.history_limit)
        self.assertEqual(results["valid"]["policyProvenance"]["kind"], "explicit-policy")
        self.assertEqual(results["javascript"], 0)
        self.assertTrue(all(results[key] != 0 for key in ("RNR_STORAGE_NONCE", "TMPDIR", "RNR_STORAGE_SESSION")))
        # A terminal record cannot authorize a later child, even with its exact nonce.
        session = next((store / "states").glob("*.json"))
        state = json.loads(session.read_text())
        with mock.patch.dict(os.environ, RNR_STORAGE_SESSION=str(session), RNR_STORAGE_NONCE=state["nonce"], TMPDIR=state["tmp"]):
            with self.assertRaises(ValueError):
                storage.inherited_session()

    def test_inherited_record_requires_live_ancestry_and_held_lock(self):
        store = storage.ensure_store(self.root / "store")
        workspace = store / "workspaces/fixture"
        temporary = workspace / "tmp"
        temporary.mkdir(parents=True)
        session = store / "states/fixture.json"
        state = {"schema": storage.SCHEMA, "status": "running", "nonce": "fixture-only",
                 "workspace": str(workspace), "tmp": str(temporary), "ownerPid": os.getpid()}
        storage.write_json(session, state)
        with mock.patch.dict(os.environ, RNR_STORAGE_SESSION=str(session), RNR_STORAGE_NONCE=state["nonce"], TMPDIR=str(temporary)):
            with self.assertRaisesRegex(ValueError, "no active lock"):
                storage.inherited_session()
            with storage.exclusive(store / "active.lock"):
                with mock.patch.object(storage, "process_table", return_value={os.getpid(): (os.getppid(), "fixture")}):
                    storage.write_json(session, {**state, "ownerPid": os.getppid() + 100000})
                    with self.assertRaisesRegex(ValueError, "mismatched"):
                        storage.inherited_session()

    def test_configured_cli_run_admit_archive_and_restore_report_same_policy(self):
        store = self.configured_store()
        root, anchor = self.fixture()
        commands = [
            ["admit", "--project", str(self.root), "--run-limit-gib=1"],
            ["run", "--project", str(self.root), "--run-limit-gib=1", "--cleanup-success", "--", sys.executable, "-c", "pass"],
            ["archive", "--root", str(root), "--manifest-sha256", anchor]]
        # The public archive CLI intentionally restricts retirement to private .local evidence.
        private = self.root / ".local/evidence"
        private.parent.mkdir()
        root.rename(private)
        commands[-1][2] = str(private)
        reports = []
        # These tiny private fixtures test CLI policy propagation, not the host's
        # current free capacity. Production admission/floor tests stay separate.
        launcher = "import runpy,sys;from types import SimpleNamespace;from unittest.mock import patch;sys.argv=sys.argv[1:];\nwith patch('os.statvfs',return_value=SimpleNamespace(f_bavail=128*1024**3,f_frsize=1)):runpy.run_path(sys.argv[0],run_name='__main__')"
        cli = [sys.executable, "-c", launcher, str(MODULE)]
        for command in commands:
            command[1:1] = ["--store", str(store)]
            reports.append(json.loads(subprocess.check_output([*cli, *command], text=True)))
        packed = reports[-1]
        reports.append(json.loads(subprocess.check_output([*cli, "restore", "--store", str(store),
            "--archive", packed["archive"], "--sha256", packed["sha256"], "--destination", str(self.root / "restored")], text=True)))
        policy, provenance = storage.effective_policy(store)
        for report in reports:
            self.assertEqual(report["policy"]["history_limit"], policy.history_limit)
            self.assertEqual(report["policy"]["reserve"], policy.reserve)
            self.assertEqual(report["policyProvenance"], provenance)

    def test_archive_deduplicates_bytes_and_restores_independent_files(self):
        root, anchor = self.fixture()
        result = storage.archive_tree(root, self.root / "store", self.policy, expected=anchor, retire=True)
        self.assertFalse(root.exists())
        self.assertLess(result["objects"], result["files"])
        output = self.root / "restored"
        storage.restore_tree(result["archive"], output, result["sha256"], self.policy)
        storage.required_files(output, anchor)
        self.assertNotEqual((output / "copy.bin").stat().st_ino, (output / "nested/a.bin").stat().st_ino)
        (output / "copy.bin").write_text("later mutation")
        self.assertTrue((output / "nested/a.bin").read_bytes().startswith(b"retained\0"))

    def test_retained_node_modules_namespace_is_not_mistaken_for_a_cache(self):
        root, _ = self.fixture()
        captured = root / "application-sources/node_modules/runtime/source.ts"
        captured.parent.mkdir(parents=True)
        captured.write_text("retained installed input")
        disposable = root / "consumer/node_modules/dependency.js"
        disposable.parent.mkdir(parents=True)
        disposable.write_text("reinstallable cache")
        files = [{"path": str(p.relative_to(root)), "sha256": storage.digest(p)} for p in sorted(root.rglob("*"))
                 if p.is_file() and p != root / "files.json" and p != disposable]
        (root / "files.json").write_text(json.dumps(files))
        result = storage.archive_tree(root, self.root / "store", self.policy, expected=storage.digest(root / "files.json"))
        metadata = storage.validate_archive(result["archive"], self.policy.run_limit)
        paths = {x["path"] for x in metadata["files"]}
        self.assertIn("application-sources/node_modules/runtime/source.ts", paths)
        self.assertNotIn("consumer/node_modules/dependency.js", paths)
        storage.restore_tree(result["archive"], self.root / "restored", result["sha256"], self.policy)

    def test_changed_manifest_or_source_is_not_retired(self):
        root, anchor = self.fixture()
        with self.assertRaises(ValueError):
            storage.archive_tree(root, self.root / "store", self.policy, expected="0" * 64, retire=True)
        with self.assertRaises(ValueError):
            storage.archive_tree(root, self.root / "store", self.policy, expected=anchor, retire=True,
                                 before_retire=lambda: (root / ".hidden").write_text("changed"))
        self.assertTrue(root.exists())
        self.assertEqual((root / ".hidden").read_text(), "changed")

    def lane_cache_fixture(self):
        root, _ = self.fixture()
        store = storage.ensure_store(self.root / "store")
        temporary = store / "workspaces/run/tmp"
        temporary.mkdir(parents=True)
        state = {"schema": storage.SCHEMA, "status": "running", "nonce": "test-nonce",
                 "ownerPid": os.getpid(), "tmp": str(temporary), "ownedOutputs": [str(self.root)]}
        session = store / "states/run.json"
        storage.write_json(session, state)
        proof = self.root / "passed-proof.json"
        storage.write_json(proof, {"status": "passed", "archiveSha256": "a" * 64, "consumer": str(root)})
        dependency = root / "consumer/node_modules/dependency.js"
        dependency.parent.mkdir(parents=True)
        dependency.write_text("reinstallable")
        return root, session, proof, dependency

    def test_lane_retirement_preserves_captured_node_modules_and_remaining_inputs(self):
        root, session, proof, dependency = self.lane_cache_fixture()
        captured = root / "application-sources/node_modules/runtime/input.ts"
        captured.parent.mkdir(parents=True)
        captured.write_text("preserved installed source")
        files = json.loads((root / "files.json").read_text())
        files.append({"path": str(captured.relative_to(root)), "sha256": storage.digest(captured)})
        storage.write_json(root / "files.json", files)
        with mock.patch.dict(os.environ, RNR_STORAGE_SESSION=str(session), RNR_STORAGE_NONCE="test-nonce"), \
             mock.patch.object(storage, "assert_quiescent") as quiescent:
            result = storage.prune_owned_lane_caches(root, proof, "a" * 64)
        self.assertFalse(dependency.exists())
        self.assertEqual(captured.read_text(), "preserved installed source")
        self.assertEqual(result["removed"], ["consumer/node_modules"])
        self.assertEqual(storage.required_files(root), {row["path"]: row["sha256"] for row in files})
        quiescent.assert_called_once_with(root)

    def test_lane_retirement_refuses_failed_mismatched_unowned_or_open_inputs(self):
        root, session, proof, dependency = self.lane_cache_fixture()
        state = json.loads(session.read_text())
        passed = json.loads(proof.read_text())
        with mock.patch.dict(os.environ, RNR_STORAGE_SESSION=str(session), RNR_STORAGE_NONCE="test-nonce"), \
             mock.patch.object(storage, "assert_quiescent") as quiescent:
            for failure in ("nonce", "owner-status", "proof-status", "archive", "root", "namespace", "open"):
                with self.subTest(failure=failure):
                    storage.write_json(session, {**state, **({"nonce": "other"} if failure == "nonce" else {}) ,
                                                **({"status": "failed"} if failure == "owner-status" else {}),
                                                **({"ownedOutputs": []} if failure == "namespace" else {})})
                    storage.write_json(proof, {**passed, **({"status": "running"} if failure == "proof-status" else {}),
                                              **({"consumer": str(self.root / "other")} if failure == "root" else {})})
                    quiescent.side_effect = RuntimeError("open input") if failure == "open" else None
                    with self.assertRaises((ValueError, RuntimeError)):
                        storage.prune_owned_lane_caches(root, proof, "b" * 64 if failure == "archive" else "a" * 64)
                    self.assertTrue(dependency.exists())

    def test_links_are_not_followed(self):
        root, anchor = self.fixture()
        (root / "outside").symlink_to(self.root)
        with self.assertRaises(ValueError):
            storage.archive_tree(root, self.root / "store", self.policy, expected=anchor, retire=True)
        self.assertTrue(root.exists())

    def test_build_artifact_retirement_requires_a_terminal_exact_evidence_owner(self):
        store = storage.ensure_store(self.root / "store")
        project = self.root / "project"
        root = project / "build-artifacts/run"
        root.mkdir(parents=True)
        state = {"project": str(project), "evidence": str(root), "status": "passed"}
        for changes in ({"status": "running"}, {"evidence": str(root.parent)}, {"project": str(self.root / "foreign")}):
            storage.write_json(store / "states/test.json", {**state, **changes})
            with self.assertRaisesRegex(ValueError, "owner-registered"):
                storage.assert_archive_scope(root, store)
        storage.write_json(store / "states/test.json", state)
        storage.assert_archive_scope(root, store)
        storage.write_json(store / "states/test.json", {**state, "evidence": str(project)})
        with self.assertRaises(ValueError):
            storage.assert_archive_scope(project, store)

    def test_explicit_link_archives_round_trip_broken_external_and_directory_links(self):
        root, anchor = self.fixture()
        external = self.root / "external"
        external.write_text("must never be archived, touched or removed")
        (root / "external-link").symlink_to(external)
        (root / "broken").symlink_to("missing")
        (root / "directory-link").symlink_to("nested", target_is_directory=True)
        before = external.stat()
        original = storage.inventory(root, preserve_links=True)
        receipt = storage.archive_tree(root, self.root / "store", self.policy, expected=anchor,
                                       preserve_links=True, retire=True)
        self.assertFalse(root.exists())
        metadata = storage.validate_archive(receipt["archive"], self.policy.run_limit)
        self.assertEqual(len(metadata["links"]), 3)
        self.assertNotIn(storage.digest(external), {item["sha256"] for item in metadata["files"]})
        output = self.root / "restored"
        storage.restore_tree(receipt["archive"], output, receipt["sha256"], self.policy, restore_links=True)
        self.assertEqual(storage.inventory(output, preserve_links=True), original)
        self.assertEqual(external.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(external.read_text(), "must never be archived, touched or removed")

    def test_link_archives_reject_descendant_writes_duplicates_and_unversioned_metadata(self):
        for patch in [
            {"directories": [{"path": "link/child", "mode": 0o755}]},
            {"directories": [{"path": "link", "mode": 0o755}]},
            {"schema": storage.SCHEMA},
            {"links": [{"path": "../escape", "target": "outside", "mode": 0o777, "mtimeNs": 0}]},
        ]:
            with self.subTest(patch=patch):
                metadata = {"schema": storage.LINK_ARCHIVE_SCHEMA, "files": [], "directories": [],
                            "links": [{"path": "link", "target": str(self.root), "mode": 0o777, "mtimeNs": 0}], **patch}
                archive = self.root / "malicious.zip"
                with zipfile.ZipFile(archive, "w") as z:
                    z.writestr("metadata.json", json.dumps(metadata))
                with self.assertRaises(ValueError):
                    storage.restore_tree(archive, self.root / "restored", storage.digest(archive), self.policy, restore_links=True)
                self.assertFalse((self.root / "restored").exists())

    def test_restore_refuses_linked_parent_without_writing_outside(self):
        root, anchor = self.fixture()
        receipt = storage.archive_tree(root, self.root / "store", self.policy, expected=anchor)
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "parent").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ancestors"):
            storage.restore_tree(receipt["archive"], self.root / "parent/new", receipt["sha256"], self.policy)
        self.assertFalse((outside / "new").exists())

    def stale_workspaces_fixture(self):
        store = storage.ensure_store(self.root / "stale-store")
        rows = []
        for number in range(3):
            workspace = store / "workspaces" / str(number)
            temporary = workspace / "tmp"
            temporary.mkdir(parents=True)
            (temporary / "input.txt").write_text("retained fixture " + str(number))
            state = {"schema": storage.SCHEMA, "status": "passed", "createdAt": number,
                     "finishedAt": number, "workspace": str(workspace), "tmp": str(temporary)}
            path = store / "states" / (str(number) + ".json")
            storage.write_json(path, state)
            rows.append((temporary, path))
        (rows[0][0] / "probe.html").symlink_to(rows[0][0] / "input.txt")
        return store, rows

    def test_automatic_compaction_preserves_link_metadata_without_following_targets(self):
        store, rows = self.stale_workspaces_fixture()
        target = os.readlink(rows[0][0] / "probe.html")
        with mock.patch.object(storage, "assert_quiescent") as quiescent:
            storage.retire_stale_workspaces(store, store / "workspaces/current", self.policy)
        self.assertFalse(rows[0][0].exists())
        archived = json.loads(rows[0][1].read_text())
        self.assertTrue(archived["temporaryEnvironmentRetired"])
        self.assertNotIn("temporaryArchiveRefusal", archived)
        receipt = archived["temporaryArchive"]
        metadata = storage.validate_archive(receipt["archive"], self.policy.run_limit)
        self.assertEqual(metadata["schema"], storage.LINK_ARCHIVE_SCHEMA)
        self.assertEqual(metadata["links"][0]["target"], target)
        with self.assertRaisesRegex(ValueError, "restore-links"):
            storage.restore_tree(receipt["archive"], self.root / "restored", receipt["sha256"], self.policy)
        storage.restore_tree(receipt["archive"], self.root / "restored", receipt["sha256"], self.policy, restore_links=True)
        self.assertEqual(os.readlink(self.root / "restored/probe.html"), target)
        self.assertEqual((self.root / "restored/input.txt").read_text(), "retained fixture 0")
        self.assertTrue(rows[2][0].exists())
        self.assertEqual(quiescent.call_count, 4)

    def test_unarchivable_raw_fixtures_still_enforce_the_retained_ceiling(self):
        store, rows = self.stale_workspaces_fixture()
        policy = storage.dataclasses.replace(self.policy, history_limit=1)
        # Keep this fixture's other old tree unsupported too, so no archive
        # overlap rather than the final retained-ceiling check fails first.
        (rows[0][0] / "probe.html").unlink()
        os.mkfifo(rows[0][0] / "pipe")
        os.mkfifo(rows[1][0] / "pipe")
        with mock.patch.object(storage, "assert_quiescent"), self.assertRaisesRegex(RuntimeError, "Retained qualification storage"):
            storage.retire_stale_workspaces(store, store / "workspaces/current", policy)
        self.assertTrue((rows[0][0] / "pipe").exists())
        self.assertTrue((rows[1][0] / "pipe").exists())

    def test_unarchivable_fixture_cannot_bypass_quiescence_or_changed_source_errors(self):
        store, rows = self.stale_workspaces_fixture()
        with mock.patch.object(storage, "assert_quiescent", side_effect=PermissionError("cannot inspect")), \
             self.assertRaises(PermissionError):
            storage.retire_stale_workspaces(store, store / "workspaces/current", self.policy)
        self.assertNotIn("temporaryArchiveRefusal", json.loads(rows[0][1].read_text()))
        with mock.patch.object(storage, "inventory", side_effect=ValueError("source changed")), \
             self.assertRaisesRegex(ValueError, "source changed"):
            storage.archive_tree(rows[0][0], store, self.policy, retire=True, retain_unsupported=True)
        self.assertTrue((rows[0][0] / "probe.html").is_symlink())

    def test_unsupported_mutation_after_archiving_remains_a_fatal_retirement_error(self):
        root, anchor = self.fixture()
        with self.assertRaises(storage.UnsupportedArchiveEntry):
            storage.archive_tree(root, self.root / "store", self.policy, expected=anchor, retire=True,
                                 retain_unsupported=True,
                                 before_retire=lambda: (root / "late-link").symlink_to(root / "copy.bin"))
        self.assertTrue(root.exists())
        self.assertTrue((root / "late-link").is_symlink())

    def test_corrupt_archive_and_existing_destination_are_refused(self):
        root, anchor = self.fixture()
        result = storage.archive_tree(root, self.root / "store", self.policy, expected=anchor)
        with self.assertRaises(ValueError):
            storage.restore_tree(result["archive"], root, result["sha256"], self.policy)
        Path(result["archive"]).write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            storage.restore_tree(result["archive"], self.root / "restored", result["sha256"], self.policy)
        self.assertFalse((self.root / "restored").exists())

    def test_history_budget_preserves_original_when_full(self):
        root, anchor = self.fixture()
        policy = storage.Policy(reserve=0, run_limit=8 * 1024**2, history_limit=1)
        with self.assertRaises(RuntimeError):
            storage.archive_tree(root, self.root / "store", policy, expected=anchor, retire=True)
        self.assertTrue(root.exists())

    def test_malicious_archive_paths_are_rejected_before_restore(self):
        archive = self.root / "bad.zip"
        metadata = {"schema": storage.SCHEMA, "files": [{"path": "../escape", "sha256": "a" * 64, "size": 1}], "directories": []}
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("metadata.json", json.dumps(metadata))
            z.writestr("objects/" + "a" * 64, b"x")
        with self.assertRaises(ValueError):
            storage.restore_tree(archive, self.root / "restored", storage.digest(archive), self.policy)
        self.assertFalse((self.root / "escape").exists())
        self.assertFalse((self.root / "restored").exists())

    def test_cli_cannot_raise_or_disable_the_run_maximum(self):
        marker = self.root / "must-not-execute"
        for limit in ("0", "13", "-1", "1.5"):
            result = subprocess.run([sys.executable, str(MODULE), "run", "--project", str(self.root),
                "--store", str(self.root / "store"), "--run-limit-gib=" + limit, "--", sys.executable,
                "-c", f"from pathlib import Path;Path({str(marker)!r}).write_text('unsafe')"],
                capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--run-limit-gib", result.stderr)
            self.assertFalse(marker.exists())
            self.assertFalse((self.root / "store").exists())

    def test_lower_cli_budget_preserves_startup_reserve_and_retained_limits(self):
        argv = [str(MODULE), "run", "--project", str(self.root), "--store", str(self.root / "store"),
                "--run-limit-gib=4", "--", sys.executable, "-c", "pass"]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(storage, "guard_run", return_value=0) as run, \
             mock.patch.object(storage, "admission", return_value={}) as admission:
            self.assertEqual(storage.main(), 0)
        policy = run.call_args.kwargs["policy"]
        self.assertEqual(policy.run_limit, 4 * storage.GIB)
        self.assertEqual(policy.reserve, 20 * storage.GIB)
        self.assertEqual(policy.history_limit, 20 * storage.GIB)
        self.assertEqual(policy.startup_floor, 32 * storage.GIB)

    def test_low_space_refuses_before_any_process_starts(self):
        marker = self.root / "should-not-exist"
        with self.assertRaises(RuntimeError):
            storage.guard_run(self.root, self.root / "store", [sys.executable, "-c", f"open({str(marker)!r},'w').write('x')"],
                              policy=self.policy, free_space=lambda _: 1)
        self.assertFalse(marker.exists())

    def test_live_budget_stops_writer_and_preserves_partial_workspace(self):
        code = "import os,time; from pathlib import Path; p=Path(os.environ['TMPDIR'])/'growing'; f=p.open('wb'); [(f.write(b'x'*65536),f.flush(),time.sleep(.01)) for _ in range(200)]"
        policy = storage.Policy(reserve=0, run_limit=256 * 1024, history_limit=8 * 1024**2, poll_seconds=0.01, startup_floor=0)
        result = storage.guard_run(self.root, self.root / "store", [sys.executable, "-c", code], policy=policy)
        self.assertEqual(result, 75)
        state = json.loads(next((self.root / "store/states").glob("*.json")).read_text())
        self.assertEqual(state["status"], "storage-limit")
        self.assertGreater(state["peakAllocatedBytes"], policy.run_limit)
        self.assertGreaterEqual(state["peakAllocatedBytes"], state["allocatedBytes"])
        self.assertTrue((Path(state["tmp"]) / "growing").exists())
        self.assertLess((Path(state["tmp"]) / "growing").stat().st_size, 8 * 1024**2)

    def test_success_disposes_only_owned_temporary_environment(self):
        unrelated = self.root / "unrelated"
        unrelated.write_text("keep")
        result = storage.guard_run(self.root, self.root / "store", [sys.executable, "-c", "import os;from pathlib import Path;(Path(os.environ['TMPDIR'])/'owned').write_text('x')"],
                                   cleanup_success=True, policy=self.policy)
        self.assertEqual(result, 0)
        state = json.loads(next((self.root / "store/states").glob("*.json")).read_text())
        self.assertFalse(Path(state["tmp"]).exists())
        self.assertEqual(unrelated.read_text(), "keep")

    def test_success_cleanup_refuses_busy_or_uninspectable_temporary_data(self):
        for error in [RuntimeError("still open"), PermissionError("inspection denied")]:
            with self.subTest(error=type(error).__name__):
                store = self.root / type(error).__name__
                evidence = self.root / (type(error).__name__ + "-evidence")
                evidence.mkdir()
                (evidence / "capture.png").write_bytes(b"retained original")
                with mock.patch.object(storage, "assert_quiescent", side_effect=error):
                    with self.assertRaisesRegex(type(error), str(error)):
                        storage.guard_run(self.root, store, [sys.executable, "-c",
                            "import os;from pathlib import Path;(Path(os.environ['TMPDIR'])/'diagnostic').write_text('keep')"],
                            evidence=evidence, cleanup_success=True, policy=self.policy)
                state = json.loads(next((store / "states").glob("*.json")).read_text())
                self.assertEqual(state["status"], "interrupted")
                self.assertEqual(state["phase"], "temporary-cleanup")
                self.assertEqual((Path(state["tmp"]) / "diagnostic").read_text(), "keep")
                self.assertEqual((evidence / "capture.png").read_bytes(), b"retained original")
                self.assertFalse(state.get("temporaryEnvironmentRetired", False))
                with storage.exclusive(store / "active.lock"):
                    pass

    def test_success_cleanup_preserves_external_evidence_and_failed_run_diagnostics(self):
        for exit_code in [0, 1]:
            store = self.root / ("store-" + str(exit_code))
            evidence = self.root / ("evidence-" + str(exit_code))
            evidence.mkdir()
            capture = evidence / "original.png"
            capture.write_bytes(b"original PNG fixture")
            code = "import os,sys;from pathlib import Path;(Path(os.environ['TMPDIR'])/'diagnostic').write_text('keep');sys.exit(" + str(exit_code) + ")"
            self.assertEqual(storage.guard_run(self.root, store, [sys.executable, "-c", code],
                evidence=evidence, cleanup_success=True, policy=self.policy), exit_code)
            state = json.loads(next((store / "states").glob("*.json")).read_text())
            self.assertEqual(Path(state["tmp"]).exists(), exit_code != 0)
            self.assertEqual(capture.read_bytes(), b"original PNG fixture")

    def test_success_cleanup_detects_a_real_detached_file_user_without_signalling_it(self):
        inspect = storage.assert_quiescent
        holders = []
        def hold_then_inspect(temporary):
            holder = subprocess.Popen([sys.executable, "-c",
                "import sys,time;f=open(sys.argv[1],'rb');print('ready',flush=True);time.sleep(30)",
                str(temporary / "diagnostic")], stdout=subprocess.PIPE, text=True, start_new_session=True)
            holders.append(holder)
            self.assertEqual(holder.stdout.readline().strip(), "ready")
            inspect(temporary)
        store = self.root / "busy-store"
        try:
            with mock.patch.object(storage, "assert_quiescent", side_effect=hold_then_inspect):
                with self.assertRaisesRegex(RuntimeError, "active process|open files"):
                    storage.guard_run(self.root, store, [sys.executable, "-c",
                        "import os;from pathlib import Path;(Path(os.environ['TMPDIR'])/'diagnostic').write_text('keep')"],
                        cleanup_success=True, policy=self.policy)
            self.assertIsNone(holders[0].poll())
            state = json.loads(next((store / "states").glob("*.json")).read_text())
            self.assertEqual((Path(state["tmp"]) / "diagnostic").read_text(), "keep")
            self.assertEqual(state["status"], "interrupted")
        finally:
            for holder in holders:
                holder.terminate()
                holder.wait(timeout=5)
                holder.stdout.close()

    def test_success_cleanup_refuses_evidence_linked_into_temporary_data(self):
        evidence = self.root / "evidence-link"
        code = f"import os;from pathlib import Path;p=Path(os.environ['TMPDIR']);(p/'capture').write_text('keep');Path({str(evidence)!r}).symlink_to(p)"
        store = self.root / "linked-store"
        with self.assertRaisesRegex(ValueError, "overlaps"):
            storage.guard_run(self.root, store, [sys.executable, "-c", code],
                evidence=evidence, cleanup_success=True, policy=self.policy)
        state = json.loads(next((store / "states").glob("*.json")).read_text())
        self.assertEqual(state["status"], "interrupted")
        self.assertEqual((evidence / "capture").read_text(), "keep")

    def test_cumulative_outputs_refuse_another_run_before_starting(self):
        store = storage.ensure_store(self.root / "store")
        old = self.root / "old-evidence"
        old.write_bytes(os.urandom(131072))
        storage.write_json(store / "states/old.json", {"workspace": str(store / "workspaces/old"), "ownedOutputs": [str(old)]})
        policy = storage.Policy(reserve=0, run_limit=131072, history_limit=229376, startup_floor=0)
        with self.assertRaises(RuntimeError):
            storage.guard_run(self.root, store, [sys.executable, "-c", "raise Exception('must not execute')"], policy=policy)
        self.assertTrue(old.exists())

    def test_existing_explicit_inputs_remain_in_cumulative_accounting_after_each_run(self):
        retained = self.root / "reused-candidate"
        retained.mkdir()
        (retained / "retained").write_bytes(os.urandom(32768))
        store = self.root / "store"
        for _ in range(2):
            self.assertEqual(storage.guard_run(self.root, store, [sys.executable, "-c", "pass"],
                                              tracks=[retained], cleanup_success=True, policy=self.policy), 0)
        states = [json.loads(p.read_text()) for p in (store / "states").glob("*.json")]
        self.assertEqual(len(states), 2)
        self.assertTrue(all(str(retained) in s["ownedOutputs"] for s in states))
        self.assertEqual(storage.retained_usage(store), storage.allocated([store, retained]))

    def test_only_one_heavy_qualification_can_own_the_store(self):
        lock = self.root / "store/active.lock"
        with storage.exclusive(lock):
            with self.assertRaises(RuntimeError):
                with storage.exclusive(lock):
                    self.fail("concurrent qualification acquired the lock")

    def test_repeated_checks_keep_each_runs_output_in_cumulative_accounting(self):
        for name in ("first", "second"):
            output = self.root / "outputs" / name
            code = f"from pathlib import Path;p=Path({str(output)!r});p.mkdir(parents=True);(p/'retained').write_text('evidence')"
            result = storage.guard_run(self.root, self.root / "store", [sys.executable, "-c", code],
                                       dynamic=[self.root / "outputs"], cleanup_success=True, policy=self.policy)
            self.assertEqual(result, 0)
        states = [json.loads(p.read_text()) for p in (self.root / "store/states").glob("*.json")]
        self.assertEqual(len(states), 2)
        self.assertEqual({p for s in states for p in s["ownedOutputs"]},
                         {str(self.root / "outputs/first"), str(self.root / "outputs/second")})

    def assert_process_gone(self, pid):
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(.02)
        self.fail(f"Owned writer {pid} survived qualification retirement")

    def test_success_kills_a_term_ignoring_grandchild(self):
        pid_file = self.root / "writer.pid"
        writer = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"
        code = f"import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c',{writer!r}]);Path({str(pid_file)!r}).write_text(str(p.pid));time.sleep(.1)"
        storage.guard_run(self.root, self.root / "store", [sys.executable, "-c", code], cleanup_success=True, policy=self.policy)
        self.assert_process_gone(int(pid_file.read_text()))

    def test_interruption_retires_writer_and_records_terminal_state(self):
        pid_file = self.root / "writer.pid"
        code = f"import os,time;from pathlib import Path;Path({str(pid_file)!r}).write_text(str(os.getpid()));time.sleep(30)"
        owner = f"import runpy;s=runpy.run_path({str(MODULE)!r});s['guard_run']({str(self.root)!r},{str(self.root / 'store')!r},{[sys.executable, '-c', code]!r},policy=s['Policy'](reserve=0,run_limit=8388608,history_limit=33554432,poll_seconds=.02,startup_floor=0))"
        monitor = subprocess.Popen([sys.executable, "-c", owner], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(pid_file.exists())
            monitor.send_signal(signal.SIGTERM)
            self.assertNotEqual(monitor.wait(timeout=5), 0)
            self.assert_process_gone(int(pid_file.read_text()))
            state = json.loads(next((self.root / "store/states").glob("*.json")).read_text())
            self.assertEqual(state["status"], "interrupted")
        finally:
            if monitor.poll() is None:
                monitor.kill()
                monitor.wait()

    def test_runtime_limit_allows_transaction_owner_to_roll_back(self):
        (self.root / ".build-state").mkdir()
        rolled_back = self.root / "rolled-back"
        writer = "import os,time;from pathlib import Path;f=(Path(os.environ['TMPDIR'])/'growing').open('wb');[(f.write(b'x'*65536),f.flush(),time.sleep(.01)) for _ in range(200)]"
        code = f"import subprocess,sys,json;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c',{writer!r}]);Path('.build-state/roku-runtime-update.json').write_text(json.dumps({{'status':'verifying','activeCommand':{{'pid':p.pid}}}}));p.wait();Path({str(rolled_back)!r}).write_text('restored');sys.exit(1)"
        policy = storage.Policy(reserve=0, run_limit=262144, history_limit=8388608, poll_seconds=.01, startup_floor=0)
        result = storage.guard_run(self.root, self.root / "store", [sys.executable, "-c", code], kind="runtime-update", policy=policy)
        self.assertEqual(result, 75)
        self.assertEqual(rolled_back.read_text(), "restored")


    def test_termination_reaps_direct_child_after_process_group_disappears(self):
        for signals in ((ProcessLookupError(),), (None, ProcessLookupError())):
            with self.subTest(signals=len(signals)):
                child = mock.Mock(pid=43127)
                child.poll.return_value = None
                child.wait.return_value = 3
                with mock.patch.object(storage.os, "killpg", side_effect=signals):
                    storage.terminate_group(child)
                child.wait.assert_called_once_with()

    def test_termination_does_not_treat_a_denied_group_signal_as_absence(self):
        child = mock.Mock(pid=43127)
        with mock.patch.object(storage.os, "killpg", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(PermissionError, "denied"):
                storage.terminate_group(child)
        child.wait.assert_not_called()

    def test_cleanup_exception_preserves_interruption_and_restores_handler(self):
        original = storage.terminate_group
        def failed_probe(child):
            original(child)
            raise PermissionError("synthetic cleanup probe")
        for code in [0, 3]:
            with self.subTest(code=code):
                store = self.root / ("cleanup-" + str(code))
                previous = signal.getsignal(signal.SIGTERM)
                with mock.patch.object(storage, "terminate_group", side_effect=failed_probe):
                    with self.assertRaisesRegex(PermissionError, "cleanup probe"):
                        storage.guard_run(self.root, store, [sys.executable, "-c", f"import sys;sys.exit({code})"],
                                          policy=self.policy, cleanup_success=True)
                state = json.loads(next((store / "states").glob("*.json")).read_text())
                self.assertEqual(state["status"], "interrupted")
                self.assertEqual(state["phase"], "cleanup")
                self.assertEqual(state["cleanupError"]["type"], "PermissionError")
                self.assertEqual(state["childExitCode"], code)
                self.assertTrue(Path(state["tmp"]).exists())
                self.assertFalse(state.get("temporaryEnvironmentRetired", False))
                self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
                with storage.exclusive(store / "active.lock"):
                    pass

    def test_cleanup_exception_keeps_the_primary_monitor_error(self):
        original = storage.terminate_group
        def failed_probe(child):
            original(child)
            raise PermissionError("synthetic secondary cleanup failure")
        calls = 0
        def interrupted_monitor(_path):
            nonlocal calls
            calls += 1
            if calls >= 3:
                raise RuntimeError("synthetic primary monitor failure")
            return 64 * 1024**2
        store = self.root / "cleanup-primary"
        previous = signal.getsignal(signal.SIGTERM)
        with mock.patch.object(storage, "terminate_group", side_effect=failed_probe):
            with self.assertRaises(PermissionError):
                storage.guard_run(self.root, store, [sys.executable, "-c", "import time;time.sleep(60)"],
                                  policy=self.policy, free_space=interrupted_monitor)
        state = json.loads(next((store / "states").glob("*.json")).read_text())
        self.assertEqual(state["status"], "interrupted")
        self.assertEqual(state["error"], "RuntimeError")
        self.assertEqual(state["cleanupError"]["type"], "PermissionError")
        self.assertIsNotNone(state["childExitCode"])
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)

    def test_cleanup_failure_after_sigterm_retains_primary_exception_and_inputs(self):
        original = storage.terminate_group
        store = self.root / "cleanup-signal"
        calls = 0

        def interrupted_monitor(_path):
            nonlocal calls
            calls += 1
            if calls >= 3:
                state = json.loads(next((store / "states").glob("*.json")).read_text())
                (Path(state["tmp"]) / "retained-input.txt").write_text("original input")
                os.kill(os.getpid(), signal.SIGTERM)
            return 64 * 1024**2

        def failed_cleanup(child):
            original(child)
            raise PermissionError("synthetic cleanup after SIGTERM")

        previous = signal.getsignal(signal.SIGTERM)
        caller_handler = lambda _signal, _frame: None
        signal.signal(signal.SIGTERM, caller_handler)
        try:
            with mock.patch.object(storage, "terminate_group", side_effect=failed_cleanup):
                with self.assertRaises(PermissionError) as caught:
                    storage.guard_run(self.root, store, [sys.executable, "-c", "import time;time.sleep(60)"],
                                      policy=self.policy, free_space=interrupted_monitor, cleanup_success=True)
            self.assertIsInstance(caught.exception.__context__, KeyboardInterrupt)
            self.assertEqual(str(caught.exception.__context__), "Qualification owner was interrupted")
            state = json.loads(next((store / "states").glob("*.json")).read_text())
            self.assertEqual(state["status"], "interrupted")
            self.assertEqual(state["error"], "KeyboardInterrupt")
            self.assertEqual(state["phase"], "cleanup")
            self.assertEqual(state["cleanupError"]["type"], "PermissionError")
            self.assertEqual((Path(state["tmp"]) / "retained-input.txt").read_text(), "original input")
            self.assertFalse(state.get("temporaryEnvironmentRetired", False))
            self.assertEqual(signal.getsignal(signal.SIGTERM), caller_handler)
            with storage.exclusive(store / "active.lock"):
                pass
        finally:
            signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    unittest.main()
