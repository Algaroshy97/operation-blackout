"""Analysis of simultaneous pre-duck score and post-graph capture.

These checks are diagnostic, not a substitute for calibrated listening.  Reference
quiet blocks are excluded rather than being misclassified as dropouts.
"""
import math
import statistics

FRAME_GAP_BOUND = 0.5
STALL_RATIO = 2.0
SMOOTH_FRAME_GAP = 0.05
MIN_CADENCE_FRAMES = 8


def frame_gap_bound(frame_gaps):
    """Absolute stall bound, widened only for captures that are renderer-bound.

    A software-GL capture of a moving scene delivers frames every few hundred
    milliseconds evenly; an absolute 0.5s bound then measures the renderer, not
    the scheduler.  With enough samples to know the cadence, the bound becomes
    twice the median gap so a genuine stall (one gap far above the rest) still
    fails, while small samples keep the strict absolute bound.
    """
    if len(frame_gaps) < MIN_CADENCE_FRAMES:
        return FRAME_GAP_BOUND
    median = statistics.median(frame_gaps)
    if median <= SMOOTH_FRAME_GAP:
        return FRAME_GAP_BOUND
    return max(FRAME_GAP_BOUND, median * STALL_RATIO)


def validate_scheduler(frames, scheduled, step_seconds):
    metrics = analyze_scheduler(frames, scheduled, step_seconds)
    if metrics['max_frame_gap'] > metrics['max_frame_gap_bound'] or metrics['max_lateness'] > 0.08:
        raise ValueError(f'scheduler timing exceeded engineering bound: {metrics}')
    if metrics['schedule_gaps']:
        raise ValueError(f'scheduler skipped score interval: {metrics}')
    return metrics


def analyze_scheduler(frames, scheduled, step_seconds):
    if len(frames) < 2 or len(scheduled) < 2 or step_seconds <= 0:
        raise ValueError('insufficient scheduler evidence')
    frame_gaps = [b['t'] - a['t'] for a, b in zip(frames, frames[1:])]
    note_gaps = [b['t'] - a['t'] for a, b in zip(scheduled, scheduled[1:])]
    return {'max_frame_gap': max(frame_gaps),
            'max_frame_gap_bound': frame_gap_bound(frame_gaps),
            'median_frame_gap': statistics.median(frame_gaps),
            'max_note_gap': max(note_gaps),
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
    upstream_count = 0
    for block in blocks:
        t, reference, output = (block[k] for k in ('t', 'reference', 'output'))
        if not all(math.isfinite(v) and v >= 0 for v in (t, reference, output)):
            raise ValueError('invalid capture sample')
        if previous is not None and (t <= previous or t - previous > 0.2):
            raise ValueError('capture timestamp gap or disorder')
        expected = block.get('expected')
        if expected is not None:
            if not math.isfinite(expected) or expected < 0:
                raise ValueError('invalid independent score sample')
            upstream_count = upstream_count + 1 if expected >= 0.001 and reference < 0.000001 else 0
            if upstream_count >= 3:
                raise ValueError(f'upstream score interruption at {t:.3f}s')
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
