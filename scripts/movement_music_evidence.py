"""Analysis of simultaneous pre-duck score and post-graph capture.

These checks are diagnostic, not a substitute for calibrated listening.  Reference
quiet blocks are excluded rather than being misclassified as dropouts.
"""
import math


def analyze_scheduler(frames, scheduled, step_seconds):
    if len(frames) < 2 or len(scheduled) < 2 or step_seconds <= 0:
        raise ValueError('insufficient scheduler evidence')
    frame_gaps = [b['t'] - a['t'] for a, b in zip(frames, frames[1:])]
    note_gaps = [b['t'] - a['t'] for a, b in zip(scheduled, scheduled[1:])]
    return {'max_frame_gap': max(frame_gaps),
            'overdue_steps': sum(s['now'] > s['t'] for s in scheduled),
            'schedule_gaps': sum(g > step_seconds * 1.5 for g in note_gaps),
            'max_lateness': max(s['now'] - s['t'] for s in scheduled)}


def validate_continuity(blocks, min_ratio=0.0):
    if len(blocks) < 20:
        raise ValueError('insufficient capture blocks')
    previous = None
    gap_start = None
    eligible = 0
    longest = 0.0
    low_count = 0
    for block in blocks:
        t, reference, output = (block[k] for k in ('t', 'reference', 'output'))
        if not all(math.isfinite(v) and v >= 0 for v in (t, reference, output)):
            raise ValueError('invalid capture sample')
        if previous is not None and (t <= previous or t - previous > 0.2):
            raise ValueError('capture timestamp gap or disorder')
        if reference >= 0.001:
            eligible += 1
            low_count = low_count + 1 if min_ratio and output < reference * min_ratio else 0
            if low_count >= 3:
                raise ValueError(f'deep attenuation at {t:.3f}s')
            if output < reference * 0.02:
                if gap_start is None:
                    gap_start = t
                longest = max(longest, t - gap_start)
            else:
                gap_start = None
        else:
            gap_start = None
            low_count = 0
        previous = t
    if eligible < 10:
        raise ValueError('insufficient audible reference evidence')
    if longest >= 0.2:
        raise ValueError(f'score output gap of at least {longest:.3f}s')
    return {'eligible_blocks': eligible, 'longest_gap': longest}
