#!/usr/bin/env python3
"""roof_check.py — validate a roof.json and project its edges onto every rendered frame.

    python3 roof_check.py <site>_roof.json [<site>_camera_matrices.json]

Part 1 (always): geometry checks on roof.json — every facet is planar, its stated pitch and aspect
match the plane normal, its 3-D area matches plan area / cos(pitch), every edge endpoint lies on
its facet's plane. Exit code 1 on any failure.

Part 2 (if a camera_matrices.json is given): projects every roof edge (ridge / hip / eave / rake)
onto every frame with the verified camera track and writes <site>_roof_edges_px.csv
(frame, edge_id, type, ax, ay, bx, by, a_in_frame, b_in_frame, depth_m) plus a framing summary:
how much of the frame height the roof occupies per keyframe and whether the whole roof stays in
frame. This replaces es_verify's flat "+9 m roofline" assumption with the actual eave and ridge
heights. It is a QA consumer of roof geometry — it never produces measurements.
"""
import json, sys, math, csv

def sub(a, b): return [a[i]-b[i] for i in range(3)]
def cross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def dot(a, b): return sum(x*y for x, y in zip(a, b))
def norm(a):
    l = math.sqrt(dot(a, a)); return [x/l for x in a]

def newell_normal(poly):
    n = [0.0, 0.0, 0.0]
    for i in range(len(poly)):
        p, q = poly[i], poly[(i+1) % len(poly)]
        n[0] += (p[1]-q[1])*(p[2]+q[2]); n[1] += (p[2]-q[2])*(p[0]+q[0]); n[2] += (p[0]-q[0])*(p[1]+q[1])
    return n

def check_geometry(roof):
    fails, warns = [], []
    facet_planes = {}
    for f in roof['facets']:
        P = f['polygon_enu']
        if len(P) < 3: fails.append(f"{f['id']}: fewer than 3 vertices"); continue
        nvec = newell_normal(P); area3 = 0.5*math.sqrt(dot(nvec, nvec)); n = norm(nvec)
        if n[2] < 0: n = [-x for x in n]
        c = [sum(p[i] for p in P)/len(P) for i in range(3)]
        resid = max(abs(dot(n, sub(p, c))) for p in P)
        if resid > 0.02: fails.append(f"{f['id']}: not planar (max residual {resid:.3f} m)")
        pitch = math.degrees(math.acos(max(-1, min(1, n[2]))))
        if abs(pitch - f['pitch_deg']) > 0.5: fails.append(f"{f['id']}: pitch from normal {pitch:.2f}° ≠ stated {f['pitch_deg']}°")
        # downslope direction = horizontal part of the normal (normal tilts toward the downslope side)
        aspect = (math.degrees(math.atan2(n[0], n[1])) + 360) % 360
        da = abs((aspect - f['aspect_deg'] + 180) % 360 - 180)
        if da > 1.0: fails.append(f"{f['id']}: aspect from normal {aspect:.1f}° ≠ stated {f['aspect_deg']}°")
        if abs(area3 - f['area_m2']) > 0.05*max(f['area_m2'], 1): fails.append(f"{f['id']}: 3-D area {area3:.2f} ≠ stated {f['area_m2']}")
        facet_planes[f['id']] = (n, c)
    for e in roof['edges']:
        # every edge endpoint must lie on at least one facet plane of its mass
        ok = False
        for fid, (n, c) in facet_planes.items():
            if not fid.startswith(e['mass'] + ':'): continue
            if abs(dot(n, sub(e['a_enu'], c))) < 0.02 and abs(dot(n, sub(e['b_enu'], c))) < 0.02: ok = True; break
        if not ok: fails.append(f"edge {e['id']} ({e['type']}) endpoints not on any facet plane of {e['mass']}")
        if abs(math.dist(e['a_enu'], e['b_enu']) - e['length_m']) > 0.01: fails.append(f"edge {e['id']}: length mismatch")
        if e['type'] == 'ridge' and abs(e['a_enu'][2] - e['b_enu'][2]) > 0.01: fails.append(f"edge {e['id']}: ridge not level")
    if roof.get('quotable') is not False: fails.append("quotable must be false for a manual/derived roof.json (only Plumb's compliant output may be quotable)")
    return fails, warns

def invert_rt(M):
    # M is 4x4 row-major c2w with orthonormal rotation → w2c
    Rm = [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]]]; t = [M[3], M[7], M[11]]
    Rt = [[Rm[j][i] for j in range(3)] for i in range(3)]
    tt = [-dot(Rt[i], t) for i in range(3)]
    return Rt, tt

def project(Rt, tt, K, X):
    Xc = [dot(Rt[i], X) + tt[i] for i in range(3)]
    if Xc[2] <= 0.1: return None
    return (K['fx']*Xc[0]/Xc[2] + K['cx'], K['fy']*Xc[1]/Xc[2] + K['cy'], Xc[2])

def project_edges(roof, cam, site):
    W, H = cam['frames'][0]['K']['width'], cam['frames'][0]['K']['height']
    rows = []; frame_stats = []
    for fr in cam['frames']:
        Rt, tt = invert_rt(fr['c2w_enu_zup_rowmajor']); K = fr['K']
        xs, ys, n_in, n_tot = [], [], 0, 0
        for e in roof['edges']:
            pa, pb = project(Rt, tt, K, e['a_enu']), project(Rt, tt, K, e['b_enu'])
            ina = bool(pa and 0 <= pa[0] < W and 0 <= pa[1] < H); inb = bool(pb and 0 <= pb[0] < W and 0 <= pb[1] < H)
            n_tot += 2; n_in += ina + inb
            for p in (pa, pb):
                if p: xs.append(p[0]); ys.append(p[1])
            rows.append([fr['frame'], e['id'], e['type'],
                         round(pa[0], 1) if pa else '', round(pa[1], 1) if pa else '',
                         round(pb[0], 1) if pb else '', round(pb[1], 1) if pb else '',
                         int(ina), int(inb), round(min([q[2] for q in (pa, pb) if q] or [0]), 1)])
        if xs:
            frame_stats.append((fr['frame'], n_in, n_tot, min(xs), max(xs), min(ys), max(ys)))
    with open(f"{site}_roof_edges_px.csv", 'w', newline='') as fh:
        w = csv.writer(fh); w.writerow(['frame', 'edge_id', 'type', 'ax', 'ay', 'bx', 'by', 'a_in_frame', 'b_in_frame', 'depth_m']); w.writerows(rows)
    all_in = sum(1 for s in frame_stats if s[1] == s[2])
    print(f"\nProjected {len(roof['edges'])} edges onto {len(frame_stats)} frames → {site}_roof_edges_px.csv")
    print(f"  frames with every roof edge endpoint inside {W}x{H}: {all_in}/{len(frame_stats)}")
    worst = min(frame_stats, key=lambda s: s[1]/s[2]); print(f"  worst frame {worst[0]}: {worst[1]}/{worst[2]} endpoints in frame")
    print("  framing at keyframes (roof bbox as % of frame width × height):")
    for s in frame_stats:
        if s[0] in (0, 180, 285, 390, 480, 600, 660):
            print(f"    f{s[0]:>3}: x {s[3]:7.1f}..{s[4]:7.1f}  y {s[5]:7.1f}..{s[6]:7.1f}  → {(s[4]-s[3])/W*100:5.1f}% × {(s[6]-s[5])/H*100:5.1f}%  in-frame {s[1]}/{s[2]}")
    return frame_stats

if __name__ == '__main__':
    if len(sys.argv) < 2: raise SystemExit(__doc__)
    roof = json.load(open(sys.argv[1])); site = roof['site']
    fails, warns = check_geometry(roof)
    print(f"{sys.argv[1]}: {len(roof['masses'])} masses, {len(roof['facets'])} facets, {len(roof['edges'])} edges, "
          f"eave {roof['heights']['eave_min_m_agl']} m, ridge max {roof['heights']['ridge_max_m_agl']} m, quotable={roof['quotable']}")
    for w in warns: print("  WARN", w)
    for f in fails: print("  FAIL", f)
    print("  geometry: " + ("PASS" if not fails else f"{len(fails)} failure(s)"))
    if len(sys.argv) > 2:
        project_edges(roof, json.load(open(sys.argv[2])), site)
    sys.exit(1 if fails else 0)
