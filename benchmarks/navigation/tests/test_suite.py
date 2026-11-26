import json
import sys
import subprocess
from zipfile import ZipFile
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from burst import Unmeasured, epochs, frames, score, score_moves, trace_clean
from catalog import ACTIVE, REST, expected, title, validate_replay
from compare import compare
from warm import linked_moves, post_apply_frame
from holdout_timing import complete_state


def catalog_xml(card, offset=0):
    root = ET.Element("app-ui")
    top = ET.SubElement(root, "topscreen")
    ET.SubElement(top, "plugin", id="dev")
    screen = ET.SubElement(top, "screen")
    n = expected(card, offset)
    ET.SubElement(screen, "Label", name="selection", text=n["text"], bounds=f"{{0, 0, 1050, {n['height']}}}")
    window = ET.SubElement(screen, "Group", name="catalog-window")
    content = ET.SubElement(window, "Group", translation=f"{{0, {-offset}}}")
    for i in range(24):
        item = ET.SubElement(content, "Group", name=f"shelf-{i}", focusable="true",
                             focused="true" if i == card else "false")
        ET.SubElement(item, "Rectangle", color=f"#{n[f'color{i}']:08x}")
    return ET.tostring(root, encoding="unicode")


def replay():
    detail = '<app-ui><topscreen><plugin id="dev"/><Label name="details" text="Details for Selected Card 2"/><Group name="back-to-catalog" focused="true"/></topscreen></app-ui>'
    return dict(origin=0, originOffset=0, commands=[{"key": "Right"}, {"key": "Select"}],
                intendedOrder=[1], intendedOffsets=[0], activatedTitle="Details for Selected Card 2",
                restoredOffset=0, observations=[dict(tag="settled Card 1", xml=catalog_xml(0)),
                    dict(tag="Detail after immediate Select", xml=detail),
                    dict(tag="restored", xml=catalog_xml(1))], **{"pass": True})


def fields():
    return [dict(kind="focus", index=1, value=True), dict(kind="color", index=0, value=REST),
            dict(kind="color", index=1, value=ACTIVE),
            dict(kind="title", index=-1, value=dict(text=title(1), width=1050, height=117, lines=3, wrap=True))]


class Burst(unittest.TestCase):
    def moves(self, groups, pairs=((25, 29),)):
        return score_moves([(1, 0)], expected(0, 0), [0, 42, 180], groups, pairs)

    def test_one_two_and_four_native_transactions(self):
        fs = fields()
        for parts in ([fs], [fs[:1], fs[1:]], [[f] for f in fs]):
            with self.subTest(parts=len(parts)):
                groups = [(i * 3 + 2, i * 3 + 4, part) for i, part in enumerate(parts)]
                self.assertEqual(self.moves(groups)["status"], "PASS")

    def test_early_render_and_stale_state_are_rejected(self):
        fs = fields()
        groups = [(2, 4, fs[:2]), (20, 24, fs[2:])]
        self.assertEqual(self.moves(groups, [(12, 26)])["status"], "MISS")
        fs[-1]["value"]["text"] = title(0)
        self.assertEqual(self.moves(groups)["status"], "MISS")

    def test_stale_paint_or_wrong_lines_is_rejected(self):
        fs = fields()
        fs[-1]["value"]["lines"] = 1
        self.assertEqual(self.moves([(2, 4, fs)])["status"], "MISS")
        self.assertEqual(self.moves([(2, 4, fields()[0:1] + fields()[2:])])["status"], "MISS")

    def test_disordered_focus_fails(self):
        fs = fields()
        fs[0]["index"] = 2
        self.assertEqual(self.moves([(2, 4, fs)])["status"], "FAIL")

    def test_coalesced_focus_cannot_earn_an_intermediate_frame(self):
        fs = fields()
        gs = [(4, 7, [dict(kind="focus", index=2, value=True)] + fs)]
        result = score_moves([(2, 0), (1, 0)], expected(0, 0), [0, 3, 42, 100], gs, [(9, 12)])
        self.assertEqual([m["beforeNextKey"] for m in result["moves"]], [False, True])

    def test_historical_cross_row_miss(self):
        data = json.loads((HERE / "cross-row.json").read_text())
        r = score_moves(data["expectedMoves"], data["initialState"], data["keys"], data["updates"], data["frames"])
        self.assertEqual((r["status"], r["beforeNextKey"], r["beforeNextFocusOrSelect"], r["total"]),
                         ("MISS", 0, 1, 11))

    def test_wrong_detail_fails_even_with_passing_runner_summary(self):
        r = replay()
        validate_replay(r)
        r["observations"][1]["xml"] = r["observations"][1]["xml"].replace("Card 2", "Card 3")
        with self.assertRaisesRegex(ValueError, "Detail"):
            validate_replay(r)

    def test_missing_native_evidence_or_trace_loss_is_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "replay").mkdir()
            (root / "replay/summary.json").write_text(json.dumps(replay()))
            r = score(root)
            self.assertEqual((r["status"], r["settledActivationAndBack"]), ("UNKNOWN", "PASS"))
            for text in ("", "name,idx,severity,value\ndrops,1,data_loss,1\n"):
                (root / "trace-stats.csv").write_text(text)
                with self.assertRaises(Unmeasured):
                    trace_clean(root / "trace-stats.csv")
        with self.assertRaises(Unmeasured):
            epochs([], {"available": True, "droppedLines": 1, "lines": []})
        with self.assertRaises(Unmeasured):
            frames([dict(track="RenderThr:Main", name="render", ts=1, dur=2)])


class HoldoutVisibleState(unittest.TestCase):
    def test_requires_the_focused_row_and_the_two_other_visible_rows(self):
        rows = {}
        for i in (6, 7, 8):
            title = ("Long ridge walk past the lakes and back to the valley" if i == 8 else "Valley walk")
            rows[f"route-{i}"] = {
                "y": (i - 1) * 96,
                "color": 0x3456C0FF if i == 8 else 0x303040FF,
                "title": f"Route {i} — {title}",
                "titlewidth": 600,
                "poster": "pkg:/images/canvas.png",
                "posterwidth": 96,
                "posterheight": 96,
            }
        state = {"focus": 8, "offset": 480, "rows": rows}
        self.assertTrue(complete_state(state, 8))
        self.assertFalse(complete_state(dict(state, offset=384), 8))
        rows["route-7"]["color"] = 0x3456C0FF
        self.assertFalse(complete_state(state, 8))
        rows["route-7"]["color"] = 0x303040FF
        rows["route-6"]["poster"] = ""
        self.assertFalse(complete_state(state, 8))


class WarmApplyTiming(unittest.TestCase):
    def test_requires_the_render_to_begin_after_the_linked_second_apply(self):
        def row(id, name, time, track="RenderThr:Main", dur=0, flow="[NULL]", apply="[NULL]"):
            return dict(id=id, name=name, ts=time, track=track, dur=dur,
                        flow_from=flow, apply_id=apply)

        rows = [
            row("a", "transaction.commit", 110, "ts_event_dev"),
            row("b", "transaction.update", 120, flow="a", apply="a1"),
            row("c", "transaction.end", 130, flow="b", apply="a1"),
            row("d", "render", 140, dur=5),
            row("e", "swapBuffers", 160, dur=5),
            row("f", "transaction.commit", 150, "ts_event_dev"),
            row("g", "transaction.update", 151, flow="f", apply="a2"),
            row("h", "transaction.end", 155, flow="g", apply="a2"),
            row("i", "render", 170, dur=5),
            row("j", "swapBuffers", 180, dur=5),
        ]
        samples = [{"deviceKeyMs": .0001, "keyToSwapCompleteMs": .000065}]
        _, _, applies, first, candidates = linked_moves(samples, rows)[0]
        self.assertEqual(applies, [(120, 130), (151, 155)])
        self.assertEqual(first, 165)
        self.assertEqual(post_apply_frame(applies, 2, candidates), (170, 185))
        rows[7]["flow_from"] = "different update"
        with self.assertRaisesRegex(Unmeasured, "ambiguous SDK apply"):
            linked_moves(samples, rows)



class LaunchComparison(unittest.TestCase):
    def test_crossover_noise_and_invalid_reused_launch(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            step = dict(key="Right", **{"from": 0}, to=1)
            for i, ms in enumerate([62, 51, 52, 63]):
                run = root / str(i)
                (run / "replay").mkdir(parents=True)
                (run / "trace-stats.csv").write_text("name,idx,severity,value\n")
                sample = dict(step, keyToRenderMs=ms-1, keyToSwapCompleteMs=ms)
                record = dict(samples=[sample], deviceClock="device", missingTailMoves=0)
                (run / "device-summary.json").write_text(json.dumps(record))
                facts = dict(model="Ultra", firmware="16", firmwareBuild="1", uiResolution="1080p")
                r = dict(cohort="trace", artifact={"sha256": ("a" if i in (0, 3) else "b") * 64},
                         warmup=[], schedule=[step], facts=facts, failedInputs=0, unattemptedInputs=0,
                         spacingMs=200, **{"pass": True})
                (run / "replay/summary.json").write_text(json.dumps(r))
            manifest = root / "blocks.json"
            spec = {"blocks": [dict(order=["control","candidate"], control="0", candidate="1"),
                               dict(order=["candidate","control"], control="3", candidate="2")]}
            manifest.write_text(json.dumps(spec))
            result = compare(manifest)
            self.assertEqual(len(result["launches"]), 4)
            self.assertEqual(result["sameBuildMatchedNoise"][0]["medianAbsMatchedMs"]["overall"]["keyToSwapCompleteMs"], 1)
            self.assertEqual(result["blocks"][0]["matchedMedianSavedMs"]["overall"]["keyToSwapCompleteMs"], 11)
            self.assertEqual(result["withinBuildLaunchMedianRangeMs"]["candidate"]["overall"]["keyToSwapCompleteMs"], 1)
            spec["blocks"][1]["control"] = "0"
            manifest.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "reused"):
                compare(manifest)


class ProbeArchive(unittest.TestCase):
    def test_exclusive_output_and_unchanged_non_probe_members(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source, out = root / "source.zip", root / "probe.zip"
            scene = "components/ReactShelfScene.brs"
            with ZipFile(source, "w") as archive:
                archive.writestr(scene, "sub init()\nend sub\n")
                archive.writestr("manifest", "title=Control\n")
            before = source.read_bytes()
            command = [sys.executable, str(HERE.parent / "probe.py"), str(source), str(out), "react"]
            subprocess.run(command, check=True)
            with ZipFile(out) as marked:
                self.assertIn(b"probeCatalogWrap", marked.read(scene))
                self.assertEqual(marked.read("manifest"), b"title=Control\n")
            first = out.read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(out.read_bytes(), first)
            self.assertEqual(source.read_bytes(), before)
