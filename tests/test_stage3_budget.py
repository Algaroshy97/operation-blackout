"""Contract for the comparative software-renderer regression guard."""
import importlib.util
import subprocess
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stage3_budget', ROOT / 'scripts/measure_stage3_budget.py')
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class Stage3BudgetTest(unittest.TestCase):
    def test_real_browser_errors_are_captured_and_rejected_for_both_cases(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            builds = {
                'base-urban': subprocess.check_output(['git', 'show', budget.BASE + ':dist/Operation Blackout.html'], cwd=ROOT),
                'night-urban': (ROOT / 'dist/Operation Blackout.html').read_bytes(),
            }
            for case, content in builds.items():
                for kind in ('page', 'console'):
                    page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
                    page_errors, console_errors = budget.capture_errors(page)
                    page.route('https://blackout.test/**', lambda route: route.fulfill(status=200, content_type='text/html', body=content))
                    page.goto('https://blackout.test/', wait_until='domcontentloaded')
                    page.wait_for_function('() => assetsReady', timeout=60000)
                    page.evaluate("setSetting('quality','low'); setSetting('effects','reduced'); setSetting('postProcessing','off')")
                    page.click('#btn-start'); page.click('#map-btn-urban')
                    if case == 'night-urban':
                        page.select_option('#weather-select', 'night')
                    page.click('#gun-select .gun-card:not(.locked)'); page.click('#gun-select .gun-card:not(.locked)')
                    page.evaluate('() => { waveActive = false; betweenWaveT = 100000; }')
                    budget.assert_browser_errors(case, page_errors, console_errors)
                    if kind == 'page':
                        page.evaluate("setTimeout(() => { throw new Error('injected unrelated page error'); }, 0)")
                    else:
                        page.evaluate("console.error('injected unrelated console error')")
                    for _ in range(30):
                        if 'injected unrelated' in str(page_errors + console_errors):
                            break
                        page.wait_for_timeout(200)
                    self.assertIn('injected unrelated', str(page_errors + console_errors))
                    with self.assertRaises(AssertionError):
                        budget.assert_browser_errors(case, page_errors, console_errors)
                    page.close()
            browser.close()

    def test_only_exact_single_baseline_pointer_lock_error_is_allowed(self):
        expected = 'A user gesture is required to request Pointer Lock.'
        budget.assert_browser_errors('base-urban', [expected], [])
        budget.assert_browser_errors('base-urban', [], [])
        for case, pages, console in (
            ('night-urban', [expected], []),
            ('base-urban', [expected, expected], []),
            ('base-urban', [expected + ' unrelated'], []),
            ('base-urban', [], [expected]),
            ('base-urban', [expected, 'unrelated'], []),
        ):
            with self.assertRaises(AssertionError):
                budget.assert_browser_errors(case, pages, console)

    def test_comparison_rejects_unmatched_or_excessive_timings(self):
        self.assertTrue(hasattr(budget, 'check_budget'), 'matched frame comparison must enforce an engineering bound')
        base = dict(frames=60, medianMs=100, p95Ms=120, renderer='software', enemies=0,
                    quality='low', effects='reduced', map='urban', pixelRatio=0.7)
        good = dict(base, medianMs=149, p95Ms=203)
        budget.check_budget(base, good)
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, medianMs=151))
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, p95Ms=205))
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, map='snowy'))
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, frames=0))
        with self.assertRaises(AssertionError):
            budget.check_budget(dict(base, enemies=1), dict(good, enemies=1))


if __name__ == '__main__':
    unittest.main()
