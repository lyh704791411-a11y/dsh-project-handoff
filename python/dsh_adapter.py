"""DSH lifecycle -> project-handoff state machine adapter (Python side).

The JS plugin (`lib/count.js` etc.) is the event plumbing. This module is the
Python half of the hybrid route: it feeds the vendored, host-agnostic state
machine (`handoff_state.py`) from normalized DSH facts and is called by the
Agent (or a future bridge), never per hook event.

Counting parity with `lib/count.js::shouldCount`:
  compaction/end AND no data.error AND data.turn non-null (number, or non-empty
  string) AND header.origin !== 'subagent' AND no header.parentSession
A manual `/compact` has `turn: null` and must not count; a settlement that
carries an error changed no history and must not count either (2026-10-20 real
sample: transport-failed start/end pair).
"""
from pathlib import Path
import importlib.util

_HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("handoff_state", _HERE / "handoff_state.py")
_STATE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_STATE)

AUTO = "auto"


def _is_countable_turn(turn):
    if turn is None or isinstance(turn, bool):
        return False
    if isinstance(turn, (int, float)):
        return True
    return isinstance(turn, str) and turn.strip() != ""


def count_auto(root, session_id, turn, origin=None, parent_session=None, error=None):
    """Record one automatic compaction. Returns True when it was counted.

    `origin` is the session header origin ('subagent' for delegated sessions);
    `parent_session` is set for child sessions. Both suppress counting.
    `error` is the `compaction/end` error field: a failed settlement changed no
    history, so it must not be counted (parity with the JS rule).
    """
    if error not in (None, ""):
        return False
    if not _is_countable_turn(turn):
        return False
    if origin == "subagent" or parent_session:
        return False
    _STATE.process(
        {
            "session_id": session_id,
            "turn_id": None,
            "hook_event_name": "PostCompact",
            "trigger": AUTO,
        },
        Path(root),
    )
    return True


def on_stop(root, session_id, last_assistant_message, turn_id=None):
    """Feed a turn stop; returns the upstream decision dict (or {})."""
    return _STATE.process(
        {
            "session_id": session_id,
            "turn_id": turn_id,
            "hook_event_name": "Stop",
            "last_assistant_message": last_assistant_message,
        },
        Path(root),
    )


def prepare(root, session_id, turn_id, reason="count", **options):
    """Create a proposal (requires the current host turn)."""
    return _STATE.process(
        {"session_id": session_id, "turn_id": turn_id},
        Path(root),
        "prepare",
        reason=reason,
        **options,
    )


def respond(root, session_id, turn_id, response, proposal_id=None, **options):
    return _STATE.process(
        {"session_id": session_id, "turn_id": turn_id},
        Path(root),
        "respond",
        response=response,
        proposal_id=proposal_id,
        **options,
    )


def status(root, session_id):
    return _STATE.process({"session_id": session_id, "turn_id": None}, Path(root), "status")
