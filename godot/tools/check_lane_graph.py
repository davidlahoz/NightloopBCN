#!/usr/bin/env python3
"""Post-build validation for out/lane_graph.bin.

Answers, from the artifacts alone:
  1. lanes with zero successors, classified boundary vs interior
     (interior dead-ends are where cars will pile up)
  2. whether any conflict entry dangles past the connection count
  3. which junctions have no conflict data, and whether any sit on a
     major street the player will actually see
  4. what junction type the discarded traffic lights fell back to

Usage: python3 tools/check_lane_graph.py [--boundary-margin 100]
Run from godot/ (reads out/lane_graph.bin, work/barcelona.net.xml,
work/netconvert.log).
"""
import argparse
import re
import struct
import sys
from array import array
from pathlib import Path

from lxml import etree

MAJOR_STREETS = ("Gran Via", "Diagonal", "Arag", "Consell de Cent",
                 "Meridiana", "Passeig de Gr")


def load_bin(path):
    buf = Path(path).read_bytes()
    magic, ver, flags = struct.unpack_from("<4sHH", buf, 0)
    assert magic == b"NLG1" and ver == 1, "not an NLG1 v1 file"
    L, P, C, J, T, PH, S, X, SB, STB = struct.unpack_from("<10I", buf, 8)
    off = 48

    def take(typecode, count):
        nonlocal off
        a = array(typecode)
        a.frombytes(buf[off:off + a.itemsize * count])
        off += a.itemsize * count
        return a

    g = {"L": L, "P": P, "C": C, "J": J, "T": T}
    g["lane_point_start"] = take("I", L + 1)
    g["points"] = take("f", 4 * P)
    g["lane_speed"] = take("f", L)
    g["lane_length"] = take("f", L)
    g["lane_flags"] = take("H", L)
    g["lane_spawn"] = take("f", L)
    g["succ_start"] = take("I", L + 1)
    g["succ_conn"] = take("I", S)
    g["conn_from"] = take("I", C)
    g["conn_to"] = take("I", C)
    g["conn_via"] = take("I", C)
    g["conn_dir"] = take("B", C)
    g["conn_tls"] = take("H", C)
    g["conn_link"] = take("H", C)
    g["conflict_start"] = take("I", C + 1)
    g["conflicts"] = take("I", X)
    off += 4 * T                       # tls_offset
    off += 4 * (T + 1)                 # tls_phase_start
    off += 4 * PH + 4 * PH + 2 * PH    # phase_dur, state_off, state_len
    off += STB                         # state blob
    g["lane_id_off"] = take("I", L + 1)
    g["strings"] = buf[off:off + SB].decode("utf-8")
    return g


def lane_id(g, i):
    return g["strings"][g["lane_id_off"][i]:g["lane_id_off"][i + 1]]


def lane_end(g, i):
    p = (g["lane_point_start"][i + 1] - 1) * 4
    return g["points"][p], g["points"][p + 2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--boundary-margin", type=float, default=100.0)
    args = ap.parse_args()

    g = load_bin("out/lane_graph.bin")
    L, C = g["L"], g["C"]

    # graph AABB from every point
    xs = g["points"][0::4]
    zs = g["points"][2::4]
    minx, maxx, minz, maxz = min(xs), max(xs), min(zs), max(zs)
    print(f"graph AABB x[{minx:.1f},{maxx:.1f}] z[{minz:.1f},{maxz:.1f}]")

    net = Path("work/barcelona.net.xml")
    tree = etree.parse(str(net))
    edge_name = {}
    lane_edge = {}
    lane_access = {}
    for e in tree.iter("edge"):
        edge_name[e.get("id")] = e.get("name") or ""
        for ln in e.iter("lane"):
            lane_edge[ln.get("id")] = e.get("id")
            lane_access[ln.get("id")] = (ln.get("allow") or "",
                                         ln.get("disallow") or "")
    junctions = {}
    for j in tree.iter("junction"):
        junctions[j.get("id")] = j
    out_conns = {}
    edges_with_out = set()
    for c in tree.iter("connection"):
        if c.get("from").startswith(":"):
            continue
        out_conns.setdefault(
            f'{c.get("from")}_{c.get("fromLane")}', []).append(c)
        edges_with_out.add(c.get("from"))

    def passenger_ok(lid):
        a, d = lane_access.get(lid, ("", ""))
        if a and "passenger" not in a and "all" not in a:
            return False
        return "passenger" not in d

    # --- 1. zero-successor lanes: boundary / genuine dead end / SEVERED ---
    # A lane with zero successors is fine when the net.xml itself gives it
    # nowhere for a passenger car to go (cul-de-sac, lane-drop pocket,
    # bus-only continuation). It is a build bug (SEVERED) only when the
    # net offered a passenger-legal continuation that the export lost.
    kinds = {"boundary": 0, "cul-de-sac": 0, "dead-lane-on-live-edge": 0,
             "bus-only-continuation": 0, "SEVERED": 0}
    severed = []
    for i in range(L):
        if g["lane_flags"][i] & 1:            # junction-internal: successors
            continue                           # are implicit via connections
        if g["succ_start"][i + 1] != g["succ_start"][i]:
            continue
        ex, ez = lane_end(g, i)
        edge_d = min(ex - minx, maxx - ex, ez - minz, maxz - ez)
        lid = lane_id(g, i)
        cl = out_conns.get(lid, [])
        if edge_d < args.boundary_margin:
            kinds["boundary"] += 1
        elif any(passenger_ok(f'{c.get("to")}_{c.get("toLane")}')
                 for c in cl):
            kinds["SEVERED"] += 1
            severed.append((lid, ex, ez))
        elif cl:
            kinds["bus-only-continuation"] += 1
        elif lid.rsplit("_", 1)[0] in edges_with_out:
            kinds["dead-lane-on-live-edge"] += 1
        else:
            kinds["cul-de-sac"] += 1
    print(f"\nzero-successor normal lanes ({sum(kinds.values())}):")
    for k, v in kinds.items():
        print(f"  {k:24s} {v}")
    for lid, ex, ez in severed:
        print(f"  SEVERED {lid:40s} end=({ex:8.1f},{ez:8.1f})")

    # --- 2. dangling conflict references ----------------------------------
    dangling = sum(1 for x in g["conflicts"] if x >= C)
    print(f"\nconflict entries: {len(g['conflicts'])}, "
          f"dangling (>= C): {dangling}")

    # --- 3 + 4. net.xml: conflict-less junctions, discarded tls -----------

    # replicate the builder's bad-junction test: link indices derived from
    # via ids (edge number + lane sub-index, continuations from internal
    # lanes excluded) must be exactly the permutation 0..nreq-1
    jconn = {}
    for c in tree.iter("connection"):
        via = c.get("via")
        if via and not c.get("from").startswith(":"):
            jid, en, ls = via[1:].rsplit("_", 2)
            jconn.setdefault(jid, {})[int(en) + int(ls)] = c
    bad = []
    for jid, li_map in jconn.items():
        j = junctions.get(jid)
        nreq = len(j.findall("request")) if j is not None else -1
        if j is None or sorted(li_map) != list(range(nreq)):
            bad.append((jid, j, nreq, len(li_map)))
    print(f"\njunctions with via-connections: {len(jconn)}, "
          f"without usable conflict data: {len(bad)}")
    hits = []
    for jid, j, nreq, ncon in bad:
        names = set()
        if j is not None:
            for lid in (j.get("incLanes") or "").split():
                names.add(edge_name.get(lane_edge.get(lid, ""), ""))
        names.discard("")
        major = [n for n in names if any(m in n for m in MAJOR_STREETS)]
        if major:
            hits.append((jid, j, major))
        jtype = j.get("type") if j is not None else "?"
        x = j.get("x") if j is not None else "?"
        y = j.get("y") if j is not None else "?"
        print(f"  {jid:24s} type={jtype:16s} req={nreq:3d} conn={ncon:3d} "
              f"net=({x},{y}) {sorted(names) if names else ''}")
    print(f"\nconflict-less junctions touching major streets: {len(hits)}")
    for jid, j, major in hits:
        print(f"  ** {jid}  net=({j.get('x')},{j.get('y')})  {major}")

    # discarded traffic lights: what did those junctions become?
    log = Path("work/netconvert.log").read_text()
    tls_ids = [t for t in re.findall(
        r"traffic light '([^']+)' does not control", log) if t != "%"]
    prog_ids = [t for t in re.findall(
        r"Could not build program '[^']*' for traffic light '([^']+)'",
        log) if t != "%"]
    print(f"\ndiscarded tls (no links): {sorted(set(tls_ids))}")
    print(f"unbuildable tls programs:  {sorted(set(prog_ids))}")
    for tid in sorted(set(tls_ids) | set(prog_ids)):
        for jid in tid.split("_joined_") if "_joined_" in tid else [tid]:
            j = junctions.get(jid)
            if j is not None:
                print(f"  junction {jid:24s} -> type={j.get('type')}")

    ok = dangling == 0 and not severed and not bad
    print(f"\n{'OK' if ok else 'ISSUES FOUND'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
