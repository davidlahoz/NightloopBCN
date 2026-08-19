#!/usr/bin/env python3
"""NightLoop lane-graph builder: OSM PBF -> SUMO netconvert -> lane_graph.bin

Pipeline (run from the godot/ project root):
  A1  osmium cat work/barcelona.osm.pbf -> work/barcelona.osm, then netconvert
      -> work/barcelona.net.xml (stderr captured to work/netconvert.log)
  A2  stream-parse net.xml with lxml iterparse (lanes incl. internal junction
      paths, connections, junctions with right-of-way, tls programs)
  A3  net coords -> true UTM (undo netOffset) -> mesh-local Godot frame from
      barcelona/manifest.json:  gx = E - oE, gy = 0, gz = -(N - oN)
  A4  arc-length resample (~2 m), successor/predecessor sets, per-connection
      conflict lists from the junction response matrices, spawn weights
  A5  out/lane_graph.bin (little-endian, versioned; spec written alongside to
      out/lane_graph_format.md) + out/lane_graph_debug.geojson (WGS84)

Requirements: requirements.txt (eclipse-sumo provides netconvert), plus the
osmium CLI (brew install osmium-tool).
"""

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import time
from lxml import etree

# --------------------------------------------------------------------------
# CONFIG — every netconvert flag lives here so imports are tunable without
# touching code. Values of None mean "flag without value".
# --------------------------------------------------------------------------
CONFIG = {
    # Flags per spec. --xml-type-files (base osmNetconvert.typ.xml ONLY — no
    # German urban typemap) supplies OSM's implied speed/lane/priority
    # defaults; --keep-edges.by-vclass passenger is a WHITELIST (not a
    # blacklist); --keep-edges.components deliberately absent. The typemap
    # path is resolved from $SUMO_HOME at runtime ("{SUMO_HOME}" placeholder).
    "netconvert_flags": {
        "--xml-type-files": "{SUMO_HOME}/data/typemap/osmNetconvert.typ.xml",
        "--geometry.remove": None,
        "--roundabouts.guess": None,
        "--ramps.guess": None,
        "--junctions.join": None,
        "--tls.guess-signals": None,
        "--tls.discard-simple": None,
        "--tls.join": None,
        "--osm.turn-lanes": None,
        "--no-turnarounds": None,
        "--keep-edges.by-vclass": "passenger",
        "--output.street-names": None,   # names for stuck-car logs/debug
        "--verbose": None,
    },
    # default slice: central Eixample (Passeig de Gracia / Arago / Gran Via)
    "default_bbox": (2.145, 41.380, 2.195, 41.410),
    "resample_spacing_m": 2.0,
    "geojson_point_stride": 2,      # thin the debug geojson a little
}

MANIFEST_DEFAULT = "barcelona/manifest.json"
MAGIC = b"NLG1"
VERSION = 1
NONE_U32 = 0xFFFFFFFF
NONE_U16 = 0xFFFF
DIR_CODE = {"s": 0, "l": 1, "r": 2, "t": 3}

# GRS80 / ETRS89 UTM (matches EPSG:258xx)
_A = 6378137.0
_F = 1.0 / 298.257222101
_K0 = 0.9996
_FE = 500000.0
_E2 = _F * (2.0 - _F)
_EP2 = _E2 / (1.0 - _E2)


def utm_inverse(easting, northing, zone):
    """UTM -> (lon, lat) degrees. Snyder's inverse transverse Mercator."""
    lon0 = math.radians(zone * 6 - 183)
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    m = northing / _K0
    mu = m / (_A * (1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
            + (151 * e1**3 / 96) * math.sin(6 * mu)
            + (1097 * e1**4 / 512) * math.sin(8 * mu))
    sin1, cos1, tan1 = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1 = _EP2 * cos1 * cos1
    t1 = tan1 * tan1
    n1 = _A / math.sqrt(1 - _E2 * sin1 * sin1)
    r1 = _A * (1 - _E2) / (1 - _E2 * sin1 * sin1) ** 1.5
    d = (easting - _FE) / (n1 * _K0)
    phi = phi1 - (n1 * tan1 / r1) * (
        d * d / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * _EP2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * _EP2 - 3 * c1 * c1) * d**6 / 720)
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d**3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * _EP2 + 24 * t1 * t1) * d**5 / 120) / cos1
    return math.degrees(lon), math.degrees(phi)


def die(msg):
    print(f"\nFATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def find_netconvert():
    from shutil import which
    p = which("netconvert")
    if p:
        return p
    try:
        import sumo  # eclipse-sumo pip package
        p = os.path.join(os.path.dirname(sumo.__file__), "bin", "netconvert")
        if os.path.exists(p):
            return p
    except ImportError:
        pass
    die("netconvert not found. Install Eclipse SUMO:\n"
        "  python3 -m pip install eclipse-sumo==1.27.1   (bundles the binary)\n"
        "  or: brew tap dlr-ts/sumo && brew install sumo")


# --------------------------------------------------------------------------
# A1 — convert
# --------------------------------------------------------------------------
def resolve_sumo_home():
    home = os.environ.get("SUMO_HOME", "")
    if not home:
        try:
            import sumo
            home = os.path.dirname(sumo.__file__)
            os.environ["SUMO_HOME"] = home
            print(f"[A1] $SUMO_HOME unset — using the eclipse-sumo package: {home}")
        except ImportError:
            die("$SUMO_HOME is not set and eclipse-sumo is not installed.\n"
                "  python3 -m pip install -r tools/requirements.txt")
    typemap = os.path.join(home, "data", "typemap", "osmNetconvert.typ.xml")
    if not os.path.exists(typemap):
        die(f"typemap missing at {typemap} — is $SUMO_HOME correct?")
    return home


def stage_convert(args):
    from shutil import which
    if which("osmium") is None:
        die("osmium CLI not found — brew install osmium-tool")
    nc = find_netconvert()
    ver = subprocess.run([nc, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    print(f"[A1] {ver}")
    sumo_home = resolve_sumo_home()

    # --bbox slice (default: the Eixample; "full" processes the whole extract)
    if args.bbox == "full":
        src_osm = os.path.join(args.work, "barcelona.osm")
        if args.force or not os.path.exists(src_osm) or \
                os.path.getmtime(src_osm) < os.path.getmtime(args.pbf):
            print(f"[A1] osmium cat {args.pbf} -> {src_osm}")
            subprocess.run(["osmium", "cat", args.pbf, "-o", src_osm, "--overwrite"], check=True)
        net_xml = os.path.join(args.work, "barcelona.net.xml")
    else:
        bb = tuple(float(v) for v in args.bbox.split(",")) if args.bbox \
            else CONFIG["default_bbox"]
        src_osm = os.path.join(args.work, "slice.osm")
        print(f"[A1] osmium extract bbox {bb} -> {src_osm}")
        subprocess.run(["osmium", "extract",
                        "-b", ",".join(str(v) for v in bb),
                        args.pbf, "-o", src_osm, "--overwrite"], check=True)
        net_xml = os.path.join(args.work, "barcelona.net.xml")

    cmd = [nc, "--osm-files", src_osm, "--output-file", net_xml]
    for flag, val in CONFIG["netconvert_flags"].items():
        cmd.append(flag)
        if val is not None:
            cmd.append(str(val).replace("{SUMO_HOME}", sumo_home))
    log = os.path.join(args.work, "netconvert.log")
    print(f"[A1] netconvert -> {net_xml}  (stderr -> {log})")
    t0 = time.time()
    with open(log, "w") as lf:
        r = subprocess.run(cmd, stderr=lf, stdout=subprocess.DEVNULL)
    if r.returncode != 0:
        die(f"netconvert failed (rc={r.returncode}) — see {log}")
    # surface a warning summary: these junctions deadlock later
    kinds = {}
    for line in open(log, errors="replace"):
        if "Warning" in line:
            key = line.split("Warning:")[-1].strip()[:60]
            kinds[key] = kinds.get(key, 0) + 1
    print(f"[A1] done in {time.time()-t0:.1f}s — {sum(kinds.values())} warnings, "
          f"top kinds:")
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1])[:6]:
        print(f"       {n:5d}x {k}")
    return net_xml


# --------------------------------------------------------------------------
# A2 — parse net.xml (streaming)
# --------------------------------------------------------------------------
def stage_parse(net_xml):
    print(f"[A2] parsing {net_xml}")
    location = None
    lanes = {}          # id -> dict
    lane_order = []
    junctions = {}      # id -> {type, requests:[(response, foes)], incLanes}
    connections = []    # raw dicts, in document order
    tls = {}            # id -> {offset, phases:[(dur, state)]}
    tls_order = []

    ctx = etree.iterparse(net_xml, events=("end",),
                          tag=("location", "edge", "junction", "connection", "tlLogic"))
    for _ev, el in ctx:
        tag = el.tag
        if tag == "location":
            location = {
                "netOffset": tuple(float(v) for v in el.get("netOffset").split(",")),
                "projParameter": el.get("projParameter", ""),
                "origBoundary": el.get("origBoundary", ""),
                "convBoundary": el.get("convBoundary", ""),
            }
        elif tag == "edge":
            func = el.get("function", "normal")
            if func in ("normal", "internal"):
                internal = func == "internal"
                for ln in el.iter("lane"):
                    lid = ln.get("id")
                    shape = []
                    for pair in ln.get("shape", "").split():
                        x, y = pair.split(",")[:2]
                        shape.append((float(x), float(y)))
                    lanes[lid] = {
                        "edge": el.get("id"),
                        "index": int(ln.get("index", "0")),
                        "speed": float(ln.get("speed", "13.89")),
                        "length": float(ln.get("length", "0")),
                        "allow": ln.get("allow"),
                        "disallow": ln.get("disallow"),
                        "shape": shape,
                        "internal": internal,
                    }
                    lane_order.append(lid)
        elif tag == "junction":
            jid = el.get("id")
            if el.get("type") != "internal":
                junctions[jid] = {
                    "type": el.get("type"),
                    "incLanes": el.get("incLanes", "").split(),
                    "requests": [(rq.get("response", ""), rq.get("foes", ""))
                                 for rq in el.iter("request")],
                }
        elif tag == "connection":
            connections.append({
                "from": el.get("from"), "to": el.get("to"),
                "fromLane": int(el.get("fromLane")), "toLane": int(el.get("toLane")),
                "via": el.get("via"), "dir": el.get("dir", "s"),
                "tl": el.get("tl"), "linkIndex": el.get("linkIndex"),
                "state": el.get("state", ""),
            })
        elif tag == "tlLogic":
            tid = el.get("id")
            if tid not in tls:
                tls_order.append(tid)
            tls[tid] = {
                "offset": float(el.get("offset", "0")),
                "phases": [(float(ph.get("duration")), ph.get("state", ""))
                           for ph in el.iter("phase")],
            }
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]

    if location is None:
        die("net.xml has no <location> element")
    print(f"[A2] lanes={len(lanes)} (internal={sum(1 for l in lanes.values() if l['internal'])}) "
          f"junctions={len(junctions)} connections={len(connections)} tls={len(tls)}")
    return location, lanes, lane_order, junctions, connections, tls, tls_order


# --------------------------------------------------------------------------
# A3 — coordinates
# --------------------------------------------------------------------------
def stage_coords(location, lanes, manifest_path):
    mf = json.load(open(manifest_path))
    origin = mf["origin"]
    epsg = origin["epsg"]                       # e.g. EPSG:25831
    zone = int(epsg.rsplit(":", 1)[1]) % 100    # 25831 -> 31
    proj = location["projParameter"]
    if f"+zone={zone}" not in proj:
        die(f"projection mismatch: netconvert used '{proj}' but the mesh manifest "
            f"is {epsg} (UTM zone {zone}). Re-run netconvert with matching "
            f"--proj, or fix the manifest.")
    ox, oy = location["netOffset"]
    oe, on = origin["easting"], origin["northing"]
    print(f"[A3] netOffset=({ox:.1f},{oy:.1f})  origin E/N=({oe:.1f},{on:.1f})  zone={zone} OK")

    mn = [1e18, 1e18]
    mx = [-1e18, -1e18]
    for l in lanes.values():
        pts = []
        for x, y in l["shape"]:
            e = x - ox                 # undo netconvert's own offset -> true UTM
            n = y - oy
            gx = e - oe                # mesh-local Godot frame
            gz = -(n - on)             # NEGATED Z (x=east, z=-north)
            pts.append((gx, gz, e, n))
            mn[0] = min(mn[0], gx); mn[1] = min(mn[1], gz)
            mx[0] = max(mx[0], gx); mx[1] = max(mx[1], gz)
        l["gpts"] = pts

    # mesh AABB from the tile manifest, for the eyeball check
    tmn = [1e18, 1e18]
    tmx = [-1e18, -1e18]
    for t in mf["tiles"]:
        tmn[0] = min(tmn[0], t["aabb_min"][0]); tmn[1] = min(tmn[1], t["aabb_min"][2])
        tmx[0] = max(tmx[0], t["aabb_max"][0]); tmx[1] = max(tmx[1], t["aabb_max"][2])
    print(f"[A3] lane graph AABB  x[{mn[0]:9.1f},{mx[0]:9.1f}]  z[{mn[1]:9.1f},{mx[1]:9.1f}]")
    print(f"[A3] mesh tiles AABB  x[{tmn[0]:9.1f},{tmx[0]:9.1f}]  z[{tmn[1]:9.1f},{tmx[1]:9.1f}]")
    if mx[0] < tmn[0] or mn[0] > tmx[0] or mx[1] < tmn[1] or mn[1] > tmx[1]:
        die("lane-graph AABB does not overlap the mesh AABB — coordinate bug")
    return zone


# --------------------------------------------------------------------------
# A4 — build
# --------------------------------------------------------------------------
def resample(pts, spacing):
    """Arc-length resample [(x,z)] to ~spacing, keeping endpoints.
    Returns list of (x, y=0, z, cumdist)."""
    if len(pts) < 2:
        return None
    cum = [0.0]
    for i in range(1, len(pts)):
        dx = pts[i][0] - pts[i - 1][0]
        dz = pts[i][1] - pts[i - 1][1]
        cum.append(cum[-1] + math.hypot(dx, dz))
    total = cum[-1]
    if total < 1e-3:
        return None
    n = max(2, int(round(total / spacing)) + 1)
    out = []
    seg = 1
    for k in range(n):
        d = total * k / (n - 1)
        while seg < len(pts) - 1 and cum[seg] < d:
            seg += 1
        t = (d - cum[seg - 1]) / max(cum[seg] - cum[seg - 1], 1e-9)
        x = pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t
        z = pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t
        out.append((x, 0.0, z, d))
    return out


def stage_build(args, lanes, lane_order, junctions, connections, tls, tls_order):
    print("[A4] building graph")
    dropped = []
    spacing = CONFIG["resample_spacing_m"]

    # drop lanes that can't carry cars; resample the rest
    for lid in lane_order:
        l = lanes[lid]
        allow = l["allow"] or ""
        disallow = l["disallow"] or ""
        if allow and "passenger" not in allow and "all" not in allow:
            dropped.append((lid, "no-passenger"))
            l["drop"] = True
            continue
        if "passenger" in disallow:
            dropped.append((lid, "passenger-disallowed"))
            l["drop"] = True
            continue
        # NOTE: short lanes are NOT dropped. netconvert emits 0.2 m stub
        # edges inside joined junction clusters that carry the only
        # connectivity between multi-lane approaches; dropping them severs
        # the graph (hundreds of interior dead-ends).
        rp = resample([(p[0], p[1]) for p in l["gpts"]], spacing)
        if rp is None:
            dropped.append((lid, "degenerate-shape"))
            l["drop"] = True
            continue
        l["points"] = rp

    # optional slice for iteration: keep the N normal lanes nearest the origin
    if args.limit_lanes > 0:
        normal = [lid for lid in lane_order
                  if not lanes[lid].get("drop") and not lanes[lid]["internal"]]
        normal.sort(key=lambda lid: min(p[0] * p[0] + p[2] * p[2]
                                        for p in lanes[lid]["points"]))
        keep = set(normal[:args.limit_lanes])
        for c in connections:
            f = f"{c['from']}_{c['fromLane']}"
            t = f"{c['to']}_{c['toLane']}"
            if f in keep and t in keep and c["via"] and c["via"] in lanes:
                keep.add(c["via"])
        for lid in lane_order:
            if lid not in keep and not lanes[lid].get("drop"):
                lanes[lid]["drop"] = True
        print(f"[A4] --limit-lanes: kept {len(keep)} lanes nearest the origin")

    live = [lid for lid in lane_order if not lanes[lid].get("drop")]
    index = {lid: i for i, lid in enumerate(live)}

    # resolve connections between surviving lanes (document order preserved;
    # raw_i keeps the pre-drop document position for junction link mapping)
    conns = []
    for raw_i, c in enumerate(connections):
        f = f"{c['from']}_{c['fromLane']}"
        t = f"{c['to']}_{c['toLane']}"
        if f not in index or t not in index:
            continue
        via = index.get(c["via"]) if c["via"] else None
        conns.append({
            "from": index[f], "to": index[t],
            "via": via if via is not None else NONE_U32,
            "via_id": c["via"], "raw_i": raw_i,
            "dir": DIR_CODE.get(c["dir"], 4),
            "tl": c["tl"], "linkIndex": c["linkIndex"],
        })

    # successors per lane
    succ = [[] for _ in live]
    for ci, c in enumerate(conns):
        succ[c["from"]].append(ci)

    # conflicts: junction response matrices. The junction link index is
    # NOT connection document order (documents group by from-edge, links
    # follow incLanes order). It IS encoded in the via id: internal edges
    # are named ':J_<firstLink>' and a multi-lane internal edge covers
    # consecutive links, so link = via edge number + via lane sub-index
    # (verified against tls linkIndex attributes). Connections FROM
    # internal lanes are continuation pieces across split junction paths,
    # not links — excluded. Link indices are taken over the FULL pre-drop
    # connection list; conflicts are recorded between surviving pairs only,
    # so no exported index can dangle.
    jconn_all = {}                       # jid -> {link_index: raw_i}
    for raw_i, c in enumerate(connections):
        vid = c["via"]
        if not vid or c["from"].startswith(":"):
            continue
        jid, edge_num, lane_sub = vid[1:].rsplit("_", 2)  # ':J_4_1'
        jconn_all.setdefault(jid, {})[int(edge_num) + int(lane_sub)] = raw_i
    raw_to_conn = {c["raw_i"]: ci for ci, c in enumerate(conns)}
    bad_junctions = 0
    conflict = [[] for _ in conns]
    for jid, li_map in jconn_all.items():
        j = junctions.get(jid)
        nreq = len(j["requests"]) if j is not None else 0
        # derived link indices must be exactly 0..nreq-1, else the mapping
        # is unproven: flag every surviving connection fail-closed (bit 7)
        # so the runtime yields to anything in the junction instead of
        # silently crossing.
        if j is None or sorted(li_map) != list(range(nreq)):
            live_cis = [raw_to_conn[r] for r in li_map.values()
                        if r in raw_to_conn]
            if live_cis:
                bad_junctions += 1
                for ci in live_cis:
                    conns[ci]["dir"] |= 0x80
            continue
        for li in range(nreq):
            ci = raw_to_conn.get(li_map[li])
            if ci is None:
                continue
            response = j["requests"][li][0]
            n = len(response)
            for other_li in range(nreq):
                other_ci = raw_to_conn.get(li_map[other_li])
                # response string is indexed from the RIGHT (SUMO convention)
                if other_ci is not None and other_li != li and other_li < n \
                        and response[n - 1 - other_li] == "1":
                    conflict[ci].append(other_ci)

    # tls index mapping
    tls_index = {tid: i for i, tid in enumerate(tls_order)}
    for c in conns:
        c["tls"] = tls_index.get(c["tl"], NONE_U16) if c["tl"] else NONE_U16
        c["link"] = int(c["linkIndex"]) if c["linkIndex"] is not None else NONE_U16

    # spawn weights: internal lanes never spawn; neither do dead-end lanes
    # (a spawned car must have somewhere to go — culs-de-sac and lane-drop
    # pockets are reachable by routing, just not spawn points). Weight
    # scales with the lane's speed class so avingudes see more traffic
    # than alley lanes.
    for i, lid in enumerate(live):
        l = lanes[lid]
        if l["internal"] or not succ[i]:
            l["spawn"] = 0.0
        else:
            l["spawn"] = max(0.3, min(3.0, l["speed"] / 8.33)) * l["length"] / 100.0

    total_km = sum(lanes[lid]["points"][-1][3] for lid in live) / 1000.0
    print(f"[A4] live lanes={len(live)}  connections={len(conns)}  "
          f"conflict pairs={sum(len(c) for c in conflict)}  "
          f"junctions without conflict data={bad_junctions}")
    return live, index, conns, succ, conflict, dropped, total_km, bad_junctions


# --------------------------------------------------------------------------
# A5 — export
# --------------------------------------------------------------------------
def stage_export(args, lanes, live, conns, succ, conflict, tls, tls_order,
                 dropped, total_km, junctions, bad_junctions, zone, t_start):
    os.makedirs(args.out, exist_ok=True)
    bin_path = os.path.join(args.out, "lane_graph.bin")

    lane_point_start = [0]
    points = []
    for lid in live:
        points.extend(lanes[lid]["points"])
        lane_point_start.append(len(points))
    succ_start = [0]
    succ_flat = []
    for s in succ:
        succ_flat.extend(s)
        succ_start.append(len(succ_flat))
    conf_start = [0]
    conf_flat = []
    for cl in conflict:
        conf_flat.extend(cl)
        conf_start.append(len(conf_flat))

    phase_dur = []
    phase_off = []
    phase_len = []
    state_blob = bytearray()
    tls_phase_start = [0]
    tls_offset = []
    for tid in tls_order:
        t = tls[tid]
        tls_offset.append(t["offset"])
        for dur, state in t["phases"]:
            phase_dur.append(dur)
            phase_off.append(len(state_blob))
            phase_len.append(len(state))
            state_blob.extend(state.encode())
        tls_phase_start.append(len(phase_dur))

    sblob = bytearray()
    lane_id_off = [0]
    for lid in live:
        sblob.extend(lid.encode())
        lane_id_off.append(len(sblob))

    L = len(live)
    C = len(conns)
    T = len(tls_order)
    PH = len(phase_dur)
    with open(bin_path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<HH", VERSION, 0))
        f.write(struct.pack("<10I", L, len(points), C, len(junctions), T, PH,
                            len(succ_flat), len(conf_flat), len(sblob), len(state_blob)))
        f.write(struct.pack(f"<{L+1}I", *lane_point_start))
        flat = []
        for p in points:
            flat.extend(p)
        f.write(struct.pack(f"<{len(flat)}f", *flat))
        f.write(struct.pack(f"<{L}f", *[lanes[lid]["speed"] for lid in live]))
        f.write(struct.pack(f"<{L}f", *[lanes[lid]["points"][-1][3] for lid in live]))
        f.write(struct.pack(f"<{L}H", *[(1 if lanes[lid]["internal"] else 0)
                                        | (2 if lanes[lid]["spawn"] > 0 else 0)
                                        for lid in live]))
        f.write(struct.pack(f"<{L}f", *[lanes[lid]["spawn"] for lid in live]))
        f.write(struct.pack(f"<{L+1}I", *succ_start))
        if succ_flat:
            f.write(struct.pack(f"<{len(succ_flat)}I", *succ_flat))
        f.write(struct.pack(f"<{C}I", *[c["from"] for c in conns]))
        f.write(struct.pack(f"<{C}I", *[c["to"] for c in conns]))
        f.write(struct.pack(f"<{C}I", *[c["via"] for c in conns]))
        f.write(struct.pack(f"<{C}B", *[c["dir"] for c in conns]))
        f.write(struct.pack(f"<{C}H", *[c["tls"] for c in conns]))
        f.write(struct.pack(f"<{C}H", *[c["link"] for c in conns]))
        f.write(struct.pack(f"<{C+1}I", *conf_start))
        if conf_flat:
            f.write(struct.pack(f"<{len(conf_flat)}I", *conf_flat))
        f.write(struct.pack(f"<{T}f", *tls_offset))
        f.write(struct.pack(f"<{T+1}I", *tls_phase_start))
        if PH:
            f.write(struct.pack(f"<{PH}f", *phase_dur))
            f.write(struct.pack(f"<{PH}I", *phase_off))
            f.write(struct.pack(f"<{PH}H", *phase_len))
        f.write(bytes(state_blob))
        f.write(struct.pack(f"<{L+1}I", *lane_id_off))
        f.write(bytes(sblob))
    size_mb = os.path.getsize(bin_path) / 1e6
    print(f"[A5] wrote {bin_path} ({size_mb:.1f} MB)")

    _write_format_md(args)

    # debug geojson in WGS84
    mf = json.load(open(args.manifest))
    oe, on = mf["origin"]["easting"], mf["origin"]["northing"]
    stride = max(1, CONFIG["geojson_point_stride"])
    feats = []
    for li, lid in enumerate(live):
        l = lanes[lid]
        coords = []
        pts = l["points"]
        for i in range(0, len(pts), stride):
            p = pts[i]
            lon, lat = utm_inverse(p[0] + oe, -p[2] + on, zone)
            coords.append([round(lon, 6), round(lat, 6)])
        if coords[-1] != None and (len(pts) - 1) % stride != 0:
            p = pts[-1]
            lon, lat = utm_inverse(p[0] + oe, -p[2] + on, zone)
            coords.append([round(lon, 6), round(lat, 6)])
        feats.append({
            "type": "Feature",
            "properties": {"id": lid, "internal": l["internal"],
                           "speed": round(l["speed"], 1),
                           "spawn": round(l["spawn"], 2)},
            "geometry": {"type": "LineString", "coordinates": coords},
        })
    gj_path = os.path.join(args.out, "lane_graph_debug.geojson")
    with open(gj_path, "w") as f:
        json.dump({"type": "FeatureCollection",
                   "attribution": mf.get("attribution", ""),
                   "features": feats}, f)
    print(f"[A5] wrote {gj_path} ({os.path.getsize(gj_path)/1e6:.1f} MB)")

    # ---- summary ----
    n_int = sum(1 for lid in live if lanes[lid]["internal"])
    print("\n================ SUMMARY ================")
    print(f" lanes            {len(live)}  ({n_int} junction-internal)")
    print(f" connections      {len(conns)}")
    print(f" junctions        {len(junctions)}  ({bad_junctions} without conflict data)")
    print(f" traffic lights   {len(tls_order)}  ({len(phase_dur)} phases)")
    print(f" total lane km    {total_km:.1f}")
    print(f" dropped lanes    {len(dropped)}")
    reasons = {}
    for _lid, r in dropped:
        reasons[r] = reasons.get(r, 0) + 1
    for r, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"   {r:24s} {n}")
    print(f" build time       {time.time()-t_start:.1f}s")
    print("=========================================")


def _write_format_md(args):
    md = os.path.join(args.out, "lane_graph_format.md")
    with open(md, "w") as f:
        f.write("""# lane_graph.bin — format v1

Little-endian throughout. Produced by `tools/build_lane_graph.py`.

## Header (48 bytes)
| offset | type | field |
|---|---|---|
| 0  | 4 bytes | magic `"NLG1"` |
| 4  | u16 | version = 1 |
| 6  | u16 | flags = 0 |
| 8  | u32 | L — lane count |
| 12 | u32 | P — point count |
| 16 | u32 | C — connection count |
| 20 | u32 | J — junction count (informational) |
| 24 | u32 | T — traffic-light count |
| 28 | u32 | PH — phase count |
| 32 | u32 | S — successor list total |
| 36 | u32 | X — conflict list total |
| 40 | u32 | string blob bytes |
| 44 | u32 | phase-state blob bytes |

## Sections, in file order (no padding)
1. `lane_point_start` — u32 × (L+1). Prefix sums: lane i owns points
   `[start[i], start[i+1])`.
2. `points` — f32 × 4 × P: `x, y, z, cumdist`. Godot mesh-local metres
   (x = east − origin, z = −(north − origin), y = 0 — elevation is sampled
   at runtime). `cumdist` is arc length from the lane start; spacing ≈ 2 m,
   endpoints exact. Runtime lookup: `i = clamp(dist / spacing)` then lerp.
3. `lane_speed` — f32 × L, speed limit m/s.
4. `lane_length` — f32 × L, arc length m (equals last cumdist).
5. `lane_flags` — u16 × L. bit0 = junction-internal path, bit1 = spawnable.
6. `lane_spawn_weight` — f32 × L (0 for internal lanes).
7. `lane_succ_start` — u32 × (L+1) prefix into `succ_conn`.
8. `succ_conn` — u32 × S, connection indices leaving each lane.
9. `conn_from` — u32 × C, lane index.
10. `conn_to` — u32 × C, lane index.
11. `conn_via` — u32 × C, junction-internal lane index or `0xFFFFFFFF`.
    Cars traverse from→via→to; the via lane is the geometry across the
    junction.
12. `conn_dir` — u8 × C: low bits 0 straight, 1 left, 2 right, 3 turn,
    4 other. Bit 7 = the junction's conflict data could not be mapped;
    the runtime must FAIL CLOSED on such connections (yield to any car
    inside the junction) and rely on the deadlock breaker, never cross
    blind.
13. `conn_tls` — u16 × C, traffic-light index or `0xFFFF`.
14. `conn_link` — u16 × C, linkIndex into the tls state string, `0xFFFF`
    when uncontrolled.
15. `conn_conflict_start` — u32 × (C+1) prefix into `conflicts`.
16. `conflicts` — u32 × X, connection indices this connection must yield
    to (derived offline from the junction `response` matrices).
17. `tls_offset` — f32 × T, program offset seconds.
18. `tls_phase_start` — u32 × (T+1) prefix into phases.
19. `phase_dur` — f32 × PH, seconds.
20. `phase_state_off` — u32 × PH, offset into the state blob.
21. `phase_state_len` — u16 × PH.
22. `state_blob` — u8 × (header field), concatenated phase state strings;
    one char per linkIndex: `G` protected green, `g` permissive green,
    `y` yellow, `r` red.
23. `lane_id_off` — u32 × (L+1) prefix into the string blob (SUMO lane ids,
    for debug/stuck-car logs only).
24. `string_blob` — utf-8.
""")
    print(f"[A5] wrote {md}")


def main():
    ap = argparse.ArgumentParser(description="NightLoop OSM -> lane graph")
    ap.add_argument("--pbf", default="work/barcelona.osm.pbf")
    ap.add_argument("--work", default="work")
    ap.add_argument("--out", default="out")
    ap.add_argument("--manifest", default=MANIFEST_DEFAULT)
    ap.add_argument("--bbox", default="",
                    help="lonmin,latmin,lonmax,latmax slice; 'full' = whole "
                         "extract; default = central Eixample")
    ap.add_argument("--limit-lanes", type=int, default=0,
                    help="keep only the N normal lanes nearest the origin")
    ap.add_argument("--force", action="store_true", help="redo conversion steps")
    args = ap.parse_args()
    t0 = time.time()
    if not os.path.exists(args.pbf):
        die(f"{args.pbf} missing")
    if not os.path.exists(args.manifest):
        die(f"{args.manifest} missing")
    os.makedirs(args.work, exist_ok=True)

    net_xml = stage_convert(args)
    location, lanes, lane_order, junctions, connections, tls, tls_order = stage_parse(net_xml)
    zone = stage_coords(location, lanes, args.manifest)
    live, _index, conns, succ, conflict, dropped, total_km, badj = stage_build(
        args, lanes, lane_order, junctions, connections, tls, tls_order)
    stage_export(args, lanes, live, conns, succ, conflict, tls, tls_order,
                 dropped, total_km, junctions, badj, zone, t0)


if __name__ == "__main__":
    main()
