"""DSH mapping checks for `dsh_adapter.py` (replaces the 9 host-adapter cases)."""
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1]))
import dsh_adapter  # noqa: E402


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ph-dsh-")) / "state"
        self.sid = "main-session"

    def count(self, **kw):
        return dsh_adapter.count_auto(self.root, self.sid, **kw)

    def auto_count(self):
        return dsh_adapter.status(self.root, self.sid)["auto_count"]

    def test_numeric_turn_counts(self):
        self.assertTrue(self.count(turn=3))
        self.assertEqual(self.auto_count(), 1)

    def test_manual_compaction_turn_null_does_not_count(self):
        self.assertFalse(self.count(turn=None))
        self.assertEqual(self.auto_count(), 0)

    def test_numeric_string_turn_counts(self):
        self.assertTrue(self.count(turn="7"))
        self.assertEqual(self.auto_count(), 1)

    def test_subagent_session_does_not_count(self):
        self.assertFalse(self.count(turn=2, origin="subagent"))
        self.assertEqual(self.auto_count(), 0)

    def test_child_session_does_not_count(self):
        self.assertFalse(self.count(turn=2, parent_session="parent-1"))
        self.assertEqual(self.auto_count(), 0)

    def test_missing_or_boolean_turn_does_not_count(self):
        for bad in (None, True, False, "", "   "):
            self.assertFalse(self.count(turn=bad), repr(bad))
        self.assertEqual(self.auto_count(), 0)

    def test_failed_compaction_does_not_count(self):
        # Real 2026-10-20 sample: `compaction/end` carries an error and the
        # history was never replaced, so it must not count.
        self.assertFalse(self.count(turn=1, error="DeepSeek Messages transport failed"))
        self.assertEqual(self.auto_count(), 0)

    def test_manual_compactions_never_reset_the_cooldown(self):
        self.assertTrue(self.count(turn=1))
        for _ in range(5):
            self.assertFalse(self.count(turn=None))
        self.assertEqual(self.auto_count(), 1)

    def test_status_is_readonly_for_missing_state(self):
        self.assertEqual(self.auto_count(), 0)
        self.assertFalse(self.root.exists())

    def test_stop_after_nine_compactions_blocks_for_missing_evaluation(self):
        for _ in range(9):
            self.count(turn=1)
        result = dsh_adapter.on_stop(self.root, self.sid, "普通任务已完成", turn_id="t1")
        self.assertEqual(result["decision"], "block")


if __name__ == "__main__":
    unittest.main()
