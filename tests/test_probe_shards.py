"""Exercise the real probe CLI routing without launching slow browser fixtures."""
from contextlib import redirect_stderr, redirect_stdout
import importlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


class ProbeShardsTest(unittest.TestCase):
    def invoke(self, *args, fail=None):
        calls = []

        def core(args, checks, errors):
            calls.append(('gameplay', args.build))
            checks.append(('core-check', fail != 'gameplay'))
            if fail == 'gameplay':
                errors.append('test console error')

        def lifecycle(args, checks):
            calls.append(('lifecycle', args.build))
            if fail == 'lifecycle':
                raise RuntimeError('lifecycle probe failed')
            checks.append(('lifecycle-check', True))

        def progression(args, checks):
            calls.append(('progression', args.build))
            checks.append(('progression-check', True))

        scripts = str(Path(__file__).resolve().parents[1] / 'scripts')
        with patch.object(sys, 'path', [scripts, *sys.path]):
            probe = importlib.import_module('probe_live')
        out = io.StringIO()
        with patch.object(probe, 'run_gameplay', core), patch.object(probe, 'run_lifecycle', lifecycle), \
             patch.object(probe, 'run_progression', progression), \
             patch.object(sys, 'argv', ['probe_live.py', '--build', 'fixture.html', *args]), \
             redirect_stdout(out), redirect_stderr(io.StringIO()):
            status = probe.main()
        self.assertTrue(all(build == Path('fixture.html') for _, build in calls))
        return status, json.loads(out.getvalue()), [name for name, _ in calls]

    def test_shards_partition_default_report(self):
        status, full, calls = self.invoke()
        self.assertEqual(status, 0)
        self.assertEqual(calls, ['gameplay', 'lifecycle', 'progression'])
        combined = []
        for shard in ('gameplay', 'lifecycle', 'progression'):
            status, report, calls = self.invoke('--shard', shard)
            self.assertEqual(status, 0)
            self.assertEqual(calls, [shard])
            self.assertEqual(report['passed'], report['total'])
            combined.extend(report['checks'])
        self.assertEqual(combined, full['checks'])

    def test_gameplay_failure_preserves_exit_code_and_diagnostics(self):
        status, report, _ = self.invoke('--shard', 'gameplay', fail='gameplay')
        self.assertEqual(status, 1)
        self.assertEqual(report['console_errors'], ['test console error'])
        self.assertEqual(report['passed'], 0)

    def test_lifecycle_failure_propagates(self):
        with self.assertRaisesRegex(RuntimeError, 'lifecycle probe failed'):
            self.invoke('--shard', 'lifecycle', fail='lifecycle')

    def test_reject_unknown_shard_or_combination_with_filter(self):
        for args in (('--shard', 'unknown'), ('--shard', 'gameplay', '-k', 'checkpoint')):
            with self.subTest(args=args), self.assertRaises(SystemExit) as raised:
                self.invoke(*args)
            self.assertEqual(raised.exception.code, 2)