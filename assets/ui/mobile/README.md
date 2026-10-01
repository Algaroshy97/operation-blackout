# Generated mobile control artwork

Generated with the image-generation tool for Operation Blackout: a 4×4 monochrome tactical icon sheet. Pure-black background was converted to alpha, then individual icons were normalized into 128×128 cells with 108px maximum artwork bounds. RGB is (240,246,252); alpha retains antialiased edges. `controls-atlas.png` is 512×512 and embedded once in `src/00_head.html` as a CSS data URI so the release remains self-contained/offline.

Row-major cells: fire, ads, reload, jump; crouch, sprint, grenade, swap; interact, melee, heal, pause; move, ammo, armor, settings.

The generated source sheet was visually inspected. Buttons use CSS pseudo-elements so settings/HUD label updates cannot erase the artwork. Artwork does not define hitboxes; labels and accessibility names remain separate. Existing tactical/streak actions reuse applicable generated equipment icons rather than adding external requests.

`tests/test_mobile_optimization.js` verifies the embedded atlas bytes against this file as well as touch lifecycle behavior.
