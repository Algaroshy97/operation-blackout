#!/usr/bin/env python3
"""Compound optic spread comparison matches real stationary aimed bullet spread."""
from pathlib import Path
from playwright.sync_api import sync_playwright
BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1280,'height':720})
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate('STATS.xp = CORE.xpForRank(CORE.MAX_RANK); saveStats()')
        page.click('#btn-gunsmith')
        text = page.get_by_role('button', name='PRECISION OPTIC', exact=False).inner_text()
        assert 'aimed spread (stationary first shot) 0.004 → 0.0026' in text, text
        browser.close()


if __name__ == '__main__':
    main()
