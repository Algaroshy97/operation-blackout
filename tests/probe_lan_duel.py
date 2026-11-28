"""Two real browser tabs, one LAN relay: join, move, hit, die, respawn, score.

Run: python -m pytest tests/probe_lan_duel.py -x -q      (or python tests/probe_lan_duel.py)

This is automation evidence, not physical play: headless Chromium on loopback
proves the netcode contract, not how two phones feel on a home Wi-Fi.
"""
import json
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_relay(port):
    proc = subprocess.Popen(
        ["node", "tools/lan-host.mjs", "--port", str(port), "--max", "4"],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return proc
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("relay exited: " + (proc.stdout.read() if proc.stdout else ""))
            time.sleep(0.15)
    proc.terminate()
    raise RuntimeError("relay did not listen on %d" % port)


def wait_for(page, expr, timeout_ms=60000, what=""):
    page.wait_for_function(expr, timeout=timeout_ms)


CHROME_ARGS = [
    "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    # Headless Chromium throttles a background tab to ~1 fps, which starves the
    # netcode tick. Two separate browsers (as two machines would be) keep both
    # tabs foregrounded.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
]


def open_page(browser, port, query="", tag=""):
    ctx = browser.new_context(viewport={"width": 480, "height": 320})
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.type + ": " + m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.goto("http://127.0.0.1:%d/%s" % (port, query), wait_until="load")
    wait_for(page, "() => window.__obLan && !document.getElementById('btn-start').classList.contains('disabled')",
             timeout_ms=150000, what="assets")
    return page, errors


def hybrid_detail(state):
    return {"guest": state.get("guest"), "playerKills": state.get("playerKills")}


def host_state(page):
    return page.evaluate(
        "() => { const g = window.__obLan.guestActor;"
        "  return { role: window.__obLan.role, status: window.__obLan.status,"
        "    over: window.__obLan.over, winner: window.__obLan.winner,"
        "    playerKills: window.__obLanGame.player.kills, playerHp: window.__obLanGame.player.health,"
        "    playerDead: window.__obLanGame.player.dead,"
        "    guest: g ? { hp: g.health, dead: g.dead, kills: g.kills,"
        "      x: g.pos.x, z: g.pos.z, net: !!g.netActor } : null }; }"
    )


def guest_state(page):
    return page.evaluate(
        "() => { const a = window.__obLan.hostAvatar;"
        "  return { role: window.__obLan.role, slot: window.__obLan.slot,"
        "    corrections: window.__obLan.corrections,"
        "    hp: window.__obLanGame.player.health, dead: window.__obLanGame.player.dead, kills: window.__obLanGame.player.kills,"
        "    x: window.__obLanGame.player.pos.x, z: window.__obLanGame.player.pos.z, tick: window.__obLan.tick,"
        "    avatar: a ? { x: a.pos.x, z: a.pos.z, hp: a.health } : null }; }"
    )


def run():
    port = free_port()
    return _run(port)


def _run(port):
    relay = start_relay(port)
    failures = []
    log = []

    def check(name, ok, detail=""):
        log.append(("PASS" if ok else "FAIL") + " " + name + (" — " + str(detail) if detail else ""))
        if not ok:
            failures.append(name + " — " + str(detail))

    try:
      try:
        with sync_playwright() as p:
            host_browser = p.chromium.launch(headless=True, args=CHROME_ARGS)
            guest_browser = p.chromium.launch(headless=True, args=CHROME_ARGS)
            host, host_errs = open_page(host_browser, port)
            host.click("#btn-lan-host")
            wait_for(host, "() => window.__obLan.connected", 20000)
            check("host relays a welcome and starts the arena", host_state(host)["role"] == "host", host_state(host)["status"])

            guest, guest_errs = open_page(guest_browser, port, "?lan=join")
            wait_for(guest, "() => window.__obLanGame.started === true && window.__obLan.connected", 150000)
            wait_for(host, "() => !!window.__obLan.guestActor", 30000)
            wait_for(guest, "() => !!window.__obLan.hostAvatar", 30000)
            hs, gs = host_state(host), guest_state(guest)
            check("a guest joins as a slot-1 body on the host",
                  hs["guest"] is not None and hs["guest"]["net"] and hs["status"].startswith("CHALLENGER"), hs["status"])
            check("the guest renders the host and is in the match",
                  gs["avatar"] is not None and gs["role"] == "guest", gs)

            # --- movement travels guest -> host -------------------------------
            before = host_state(host)["guest"]
            guest.evaluate("() => { window.__obLanGame.player.yaw = Math.PI; }")
            guest.keyboard.down("w")
            time.sleep(1.6)
            guest.keyboard.up("w")
            time.sleep(0.6)
            after = host_state(host)["guest"]
            moved = ((after["x"] - before["x"]) ** 2 + (after["z"] - before["z"]) ** 2) ** 0.5
            check("walking on the guest moves the host's copy of it", moved > 0.5, "moved %.2f m (software GL runs a few fps)" % moved)
            gpos = guest_state(guest)
            drift = ((gpos["x"] - after["x"]) ** 2 + (gpos["z"] - after["z"]) ** 2) ** 0.5
            check("both copies agree on where the guest stands", drift < 3.0, "drift %.2f m" % drift)

            # --- host shoots the guest: damage, death, respawn -----------------
            aim = host.evaluate(
                "() => { const g = window.__obLan.guestActor; const p = window.__obLanGame.player;"
                "  const dx = g.pos.x - p.pos.x, dz = g.pos.z - p.pos.z;"
                "  p.yaw = Math.atan2(-dx, -dz); p.pitch = -0.02;"
                "  return { dist: Math.hypot(dx, dz), hp: g.health }; }"
            )
            check("host can see the guest body it must shoot", aim["dist"] > 0.5, aim)
            hp_before = aim["hp"]
            for _ in range(10):
                host.evaluate("() => { const g = window.__obLan.guestActor; const p = window.__obLanGame.player;"
                              "  if (!g || g.dead) return;"
                              "  const dx = g.pos.x - p.pos.x, dz = g.pos.z - p.pos.z;"
                              "  p.yaw = Math.atan2(-dx, -dz); p.pitch = -0.02; }")
                host.evaluate("() => window.__obLanApi.pressFire(true)")
                time.sleep(1.0)
                host.evaluate("() => window.__obLanApi.pressFire(false)")
                time.sleep(0.4)
                if host_state(host)["guest"] and host_state(host)["guest"]["hp"] < hp_before:
                    break
            hs2 = host_state(host)
            wait_for(guest, "() => window.__obLanGame.player.health < 100 || window.__obLanGame.player.dead", 12000)
            check("guest damage is decided by the host and mirrored to the guest",
                  (hs2["guest"] and hs2["guest"]["hp"] < hp_before) or guest_state(guest)["hp"] < 100,
                  "host sees hp=%s, guest sees hp=%s" % (hs2["guest"] and hs2["guest"]["hp"], guest_state(guest)["hp"]))

            # --- guest shoots the host ---------------------------------------
            guest.evaluate(
                "() => { const a = window.__obLan.hostAvatar; const p = window.__obLanGame.player;"
                "  const dx = a.pos.x - p.pos.x, dz = a.pos.z - p.pos.z;"
                "  p.yaw = Math.atan2(-dx, -dz); p.pitch = 0; return true; }"
            )
            host_hp_before = host_state(host)["playerHp"]
            shots = 0
            for _ in range(14):
                guest.evaluate("() => { const a = window.__obLan.hostAvatar; const p = window.__obLanGame.player;"
                               "  const dx = a.pos.x - p.pos.x, dz = a.pos.z - p.pos.z;"
                               "  p.yaw = Math.atan2(-dx, -dz); p.pitch = 0; }")
                guest.evaluate("() => window.__obLanApi.pressFire(true)")
                shots += 1
                time.sleep(1.0)
                guest.evaluate("() => window.__obLanApi.pressFire(false)")
                time.sleep(0.4)
                if host_state(host)["playerHp"] < host_hp_before:
                    break
            hs3 = host_state(host)
            check("a guest shot is re-tested by the host before it damages anyone",
                  hs3["playerHp"] < host_hp_before,
                  "after %d clicks host hp %s -> %s" % (shots, host_hp_before, hs3["playerHp"]))

            # --- a kill, a respawn and a score change, all host-decided --------
            guest_before = host_state(host)["guest"]
            kills_before = host_state(host)["playerKills"]
            died = False
            for _ in range(14):
                host.evaluate(
                    "() => { const g = window.__obLan.guestActor; const p = window.__obLanGame.player;"
                    "  if (!g || g.dead) return;"
                    "  const dx = g.pos.x - p.pos.x, dz = g.pos.z - p.pos.z;"
                    "  p.yaw = Math.atan2(-dx, -dz); p.pitch = -0.02; }")
                host.evaluate("() => window.__obLanApi.pressFire(true)")
                time.sleep(1.0)
                host.evaluate("() => window.__obLanApi.pressFire(false)")
                time.sleep(0.4)
                st = host_state(host)
                if st["guest"] is None or st["guest"]["dead"] or (st["guest"]["hp"] <= 0):
                    died = True
                    break
            hs4 = host_state(host)
            check("the host can kill the guest body it owns", died, hybrid_detail(hs4))
            check("the kill is credited to the host's score", hs4["playerKills"] > kills_before,
                  "%s -> %s" % (kills_before, hs4["playerKills"]))
            # respawn is the host's call and must reach the guest as health again
            wait_for(host, "() => { const g = window.__obLan.guestActor; return !g || (!g.dead && g.health > 0); }", 45000)
            wait_for(guest, "() => !window.__obLanGame.player.dead && window.__obLanGame.player.health > 0", 45000)
            hs5 = host_state(host)
            check("the guest respawns alive and both sides agree",
                  hs5["guest"] and not hs5["guest"]["dead"] and guest_state(guest)["hp"] > 0, hybrid_detail(hs5))

            # --- score settles through the host ------------------------------
            settled = host.evaluate(
                "() => { const p = window.__obLanGame.player; const g = window.__obLan.guestActor;"
                "  return window.__obLanApi.settle(10, 3, 10); }"
            )
            check("the duel settles at the target score", settled == "host", settled)

            check("no console errors on the host", len(host_errs) == 0, str(host_errs[:4]))
            check("no console errors on the guest", len(guest_errs) == 0, str(guest_errs[:4]))
            host_browser.close()
            guest_browser.close()
      except Exception:
        print("\n".join(log))
        raise
    finally:
        relay.terminate()
        try:
            relay.wait(timeout=5)
        except Exception:
            relay.kill()

    print("\n".join(log))
    if failures:
        print("\n%d FAILED" % len(failures))
        return 1
    print("\nALL LAN DUEL PROBES PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(2)
