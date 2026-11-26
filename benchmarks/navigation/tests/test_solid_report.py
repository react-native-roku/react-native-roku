import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from solid_report import balanced, configuration, verify_settled, verify_trace


class PublicComparison(unittest.TestCase):
    def test_counterbalance_uses_launch_pairs(self):
        forward, reverse = {"order": ["control", "candidate"]}, {"order": ["candidate", "control"]}
        balanced([forward, reverse, reverse, forward])
        for blocks in ([forward, reverse], [forward, reverse, forward, forward],
                       [forward, reverse, reverse, {"order": ["candidate", "candidate"]}]):
            with self.assertRaisesRegex(ValueError, "per order"):
                balanced(blocks)

    def test_replay_identity_and_schedule_are_checked_before_comparison(self):
        step = {"key": "Right", "from": 0, "to": 1}
        route = {"warmup": [], "schedule": [step]}
        facts = dict(model="4850X", firmware="16", firmwareBuild="853", uiResolution="1080p",
                     outputMode="1080p UI")
        replay = dict(route, mode="solid", artifact={"sha256": "abc"}, facts=facts, spacingMs=200,
                      pollMs=75, deadlineMs=6000, failedInputs=0, unattemptedInputs=0,
                      results=[dict(step, **{"pass": True})], **{"pass": True})
        self.assertEqual(configuration(replay, "solid", "abc", route)["device"], facts)
        for changes in ({"mode": "react"}, {"artifact": {"sha256": "xyz"}}, {"warmup": [step]},
                        {"results": []}, {"results": [dict(step, to=2, **{"pass": True})]}):
            with self.assertRaises(ValueError):
                configuration(dict(replay, **changes), "solid", "abc", route)

    def test_stale_or_absent_trees_do_not_pass_a_completed_step(self):
        step = {"key": "Right", "from": 0, "to": 1}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "replay").mkdir()
            (root / "replay/step-01.json").write_text(json.dumps(dict(step, polls=[{"xml": "<app/>"}])))
            with self.assertRaisesRegex(ValueError, "settled title"):
                verify_settled(root, {"warmup": [], "schedule": [step]})

    def test_saved_export_must_come_from_the_raw_trace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "device.perfetto-trace").write_bytes(b"trace")
            (root / "trace-stats.csv").write_bytes(b"changed")
            with patch("solid_report.subprocess.run") as processor:
                processor.return_value.returncode = 0
                processor.return_value.stdout = b"actual"
                with self.assertRaisesRegex(ValueError, "trace-stats"):
                    verify_trace(root, Path("processor"))

    def test_published_ultra_report_can_be_recalculated_from_its_moves(self):
        from itertools import combinations
        from math import ceil
        from statistics import median
        from catalog import offset_for

        path = Path(__file__).resolve().parents[1] / "results/2026-11-25-solid-shelf/scorecard.json"
        report = json.loads(path.read_text())
        offsets = [0]
        for step in report["route"]:
            offsets.append(offset_for(step["to"], offsets[-1]))
        strata = {
            "overall": range(len(report["route"])),
            "scrolling": [i for i in range(len(offsets)-1) if offsets[i+1] != offsets[i]],
            "nonScrolling": [i for i in range(len(offsets)-1) if offsets[i+1] == offsets[i]],
        }
        runs = report["launches"]
        self.assertEqual(report["scoredInputs"], sum(len(r["postApplySwapMs"]) for r in runs))
        self.assertEqual(len(set(r["traceSha256"] for r in runs)), len(runs))
        for s, indices in strata.items():
            for r in runs:
                values = sorted(r["postApplySwapMs"][j] for j in indices)
                self.assertEqual(r["metricsMs"][s], {"n": len(values), "median": median(values),
                                 "p95": values[ceil(len(values)*.95)-1], "worst": values[-1]})
            for i, block in enumerate(report["pairs"]):
                pair = runs[2*i:2*i+2]
                self.assertEqual([r["renderer"] for r in pair], block["order"])
                react, solid = sorted(pair, key=lambda r: r["renderer"])
                gap = block["reactMinusSolidMs"][s]
                self.assertAlmostEqual(gap["matchedMedian"], median(
                    react["postApplySwapMs"][j] - solid["postApplySwapMs"][j] for j in indices))
                self.assertAlmostEqual(gap["launchP95Difference"],
                                       react["metricsMs"][s]["p95"] - solid["metricsMs"][s]["p95"])
            for framework in ("react", "solid"):
                pairs = combinations([r["postApplySwapMs"] for r in runs if r["renderer"] == framework], 2)
                noise = max(median(abs(a[j] - b[j]) for j in indices) for a, b in pairs)
                self.assertAlmostEqual(noise, report["maxSameBuildMedianAbsoluteMatchedMs"][framework][s])

    def test_required_apply_follows_native_state_across_frameworks(self):
        from warm import observed_ordinal, post_apply_frame
        a, b, c = [(10, 12), (13, 14), (17, 18)]
        focus = {"kind": "focus", "index": 1, "value": True}
        height = {"kind": "height", "index": -1, "value": 117}
        target = dict(focus=1, height=117)
        self.assertEqual(observed_ordinal([a], [(*a, [focus, height])], {}, target), 1)
        self.assertEqual(observed_ordinal([a, b, c], [(*a, [focus]), (*b, [height])], {}, target), 2)
        stale = dict(height, value=39)
        self.assertEqual(observed_ordinal([a, b, c], [(*a, [focus, height]), (*b, [stale]),
                                                      (*c, [height])], {}, target), 3)
        frames = [(11, 13), (15, 19), (20, 23)]
        self.assertEqual(post_apply_frame([a, b, c], 2, frames), (15, 19))
        self.assertEqual(post_apply_frame([a, b, c], 3, frames), (20, 23))
        with self.assertRaisesRegex(ValueError, "required state"):
            observed_ordinal([a, b], [(*a, [focus, height]), (*b, [stale])], {}, target)
