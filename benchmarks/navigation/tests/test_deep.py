import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deep"))
from directions import assess


class SustainedNavigation(unittest.TestCase):
    def test_correct_second_key_cannot_mask_wrong_final_destination(self):
        trial = dict(route="long", complete=True, detail={"title": "Mountain route 64"},
                     back={"offset": 2520}, finalWindow={"rows": [8, 9]}, SelectGesture=True,
                     moves=[{"linkedSwapCandidateMs": 95}] * 9, expectedFocusOrder=list(range(9)),
                     settledBeforeSelect={"error": "observed Card 52 instead of Card 64"})
        self.assertFalse(assess(trial, False))
        trial["settledBeforeSelect"] = {"offset": 2520}
        self.assertTrue(assess(trial, False))
        trial["moves"][3] = {"linkedSwapCandidateMs": None}
        self.assertFalse(assess(trial, False))

    def test_marked_pair_requires_callback_and_both_swaps(self):
        step = dict(detail=True, back=True, SelectGesture=True, first={"keyToCorrectSwapMs": 104},
                    second={"keyToCorrectSwapMs": 95}, activation=False)
        self.assertTrue(assess([step], False))
        self.assertFalse(assess([step], True))
        step["activation"] = True
        self.assertTrue(assess([step], True))
        step["second"]["keyToCorrectSwapMs"] = None
        self.assertFalse(assess([step], True))
