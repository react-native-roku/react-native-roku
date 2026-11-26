import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import qualification_capacity as capacity
import qualification_storage as storage


class CapacityTests(unittest.TestCase):
    def test_serial_stages_include_carry_and_recovery(self):
        p = storage.Policy(history_limit=80*storage.GIB)
        with patch.object(storage, "retained_usage", return_value=74*storage.GIB), patch.object(storage, "available", return_value=34*storage.GIB):
            result = capacity.preview(".", ".", p, [("build", 4, 2048), ("probe", 3, 0)], 2*storage.GIB)
        self.assertEqual(result["stages"][0]["retainedShortfallBytes"], 0)
        self.assertEqual(result["stages"][1]["retainedShortfallBytes"], storage.GIB)
        self.assertTrue(result["maintenanceDue"])

    def test_compaction_round_trip_and_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            store = storage.ensure_store(root/"store")
            policy = storage.Policy(history_limit=80*storage.GIB, reserve=0, startup_floor=0)
            pool, indexes = {}, []
            data = os.urandom(160000)
            for name in ["first", "second"]:
                src = root/name
                src.mkdir()
                (src/"media").write_bytes(data)
                record = storage.archive_tree(src, store, policy, retire=True)
                original = Path(record["archive"])
                raw = original.read_bytes()
                indexes.append(original.stem)
                result = capacity.compact(store, original.stem, record["sha256"], pool, 0, policy)
                if name == "second":
                    self.assertGreater(result["savedBytes"], 100000)
                self.assertFalse(original.exists())
                with capacity.archive_file(store, original, record["sha256"], policy) as rebuilt:
                    self.assertEqual(rebuilt.read_bytes(), raw)
                    storage.restore_tree(rebuilt, root/(name+"-restored"), record["sha256"], policy)
            self.assertEqual((root/"second-restored/media").read_bytes(), data)
            with (store/"index"/(indexes[0]+".json")).open() as file:
                manifest = capacity.read_manifest(store, json.load(file))
            pack = store/"history/zip-chunks"/manifest["segments"][0][0]
            pack.write_bytes(b"damaged")
            with self.assertRaises(ValueError):
                with capacity.archive_file(store, original, record["sha256"], policy):
                    self.fail("corrupted archive was opened")

    def test_rearchiving_a_packed_tree_keeps_its_exact_raw_zip_and_skips_future_automatic_retirement(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            store = storage.ensure_store(root / "store")
            policy = storage.Policy(reserve=0, startup_floor=0)
            src = root / "original"
            src.mkdir()
            (src / "data").write_bytes(b"abc" * 8192)
            record = storage.archive_tree(src, store, policy, retire=True)
            archive = Path(record["archive"])
            capacity.compact(store, archive.stem, record["sha256"], {}, 0, policy)
            with capacity.archive_file(store, archive, record["sha256"], policy) as exact:
                storage.restore_tree(exact, src, record["sha256"], policy)
            repeated = storage.archive_tree(src, store, policy, retire=True)
            self.assertEqual(storage.digest(archive), record["sha256"])
            self.assertEqual(repeated["sha256"], record["sha256"])
            selection = {"store": str(store), "archives": [{"identity": archive.stem, "sha256": record["sha256"]}]}
            self.assertEqual(list(capacity.next_selected(store, selection)), [])

    def test_trigger_stays_active_until_low_water(self):
        with tempfile.TemporaryDirectory() as d:
            store = storage.ensure_store(Path(d).resolve() / "store")
            registration = store / "maintenance" / "cold-archives.json"
            storage.write_json(registration, {"store": str(store), "archives": []})
            cycle = registration.with_name("cold-history-cycle.json")
            policy = storage.Policy(history_limit=80 * storage.GIB)
            for gib, expected in [(71, None), (72, True), (71, True), (70, False)]:
                capacity.maintain_before_run(store, policy, registration, gib * storage.GIB)
                self.assertEqual(json.loads(cycle.read_bytes())["active"] if cycle.exists() else None, expected)

    def test_native_zip_selection_rejects_a_different_digest(self):
        import qualification_cache_macos as compression
        with tempfile.TemporaryDirectory() as d:
            store = storage.ensure_store(Path(d).resolve() / "store")
            raw = store / "history" / ("a" * 64 + ".zip")
            raw.parent.mkdir()
            raw.write_bytes(b"sample")
            storage.write_json(store / "index" / ("a" * 64 + ".json"), {"archive": str(raw), "sha256": storage.digest(raw)})
            selection = Path(d) / "selection.json"
            storage.write_json(selection, {"store": str(store), "roots": [str(raw.parent)],
                                          "files": [{"path": str(raw), "sha256": "b" * 64}]})
            with self.assertRaisesRegex(ValueError, "differs from indexed"):
                compression.cold_files(store, selection, {})

    def test_future_scratch_needs_opt_in_terminal_state_and_matching_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            store = storage.ensure_store(Path(d).resolve() / "store")
            key = "a" * 64
            tmp = store / "workspaces" / key / "tmp"
            tmp.mkdir(parents=True)
            (tmp / "captured").write_bytes(b"evidence")
            record = storage.archive_tree(tmp, store, storage.Policy(reserve=0), retire=True)
            state = {"status": "failed", "coldTemporaryHistory": True, "tmp": str(tmp),
                     "temporaryEnvironmentRetired": True, "temporaryArchive": record}
            path = store / "states" / (key + ".json")
            storage.write_json(path, state)
            selection = {"store": str(store), "archives": []}
            self.assertEqual(list(capacity.next_selected(store, selection)), [])
            selection["includeManagedScratch"] = True
            self.assertEqual([r["sha256"] for r in capacity.next_selected(store, selection)], [record["sha256"]])
            state["status"] = "running"
            storage.write_json(path, state)
            self.assertEqual(list(capacity.next_selected(store, selection)), [])

    def test_waiting_guard_acquires_after_a_short_contention_without_relaunching(self):
        import threading
        with tempfile.TemporaryDirectory() as tmp:
            store = storage.ensure_store(Path(tmp) / "store")
            ready = threading.Event()

            def hold_lock():
                with storage.exclusive(store / "active.lock"):
                    ready.set()
                    threading.Event().wait(0.15)

            thread = threading.Thread(target=hold_lock)
            thread.start()
            try:
                self.assertTrue(ready.wait(3))
                with self.assertRaisesRegex(RuntimeError, "Another managed qualification"):
                    with capacity.maintenance_lock(store):
                        self.fail("the existing owner still holds this lock")
                with capacity.maintenance_lock(store, 3):
                    with self.assertRaisesRegex(RuntimeError, "Another managed qualification"):
                        with storage.exclusive(store / "active.lock"):
                            self.fail("a queued guard must hold the single owner lock")
            finally:
                thread.join(3)
