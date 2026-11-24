#!/usr/bin/env python3
"""roof_massing.py — turn a hand-written roof massing into a roof.json (v0, visualisation-only).

    python3 roof_massing.py <site> roof_massing.json [anchors.json]

Input  : roof_massing.json — convex roof masses in the BUILDING frame (u along the long axis
         toward the ESE end, v perpendicular toward the entrance side), each with an eave height,
         a pitch and a flag per footprint edge saying whether that edge carries a sloped plane
         (hip/eave) or is a vertical gable end.
Output : <site>_roof.json  — facets (3D polygons, pitch, aspect, area), edges (ridge / hip /
         eave / rake, 3D segments, lengths), heights, all in ENU metres from the site origin
         (z up, z = 0 at ground) — the same frame as anchors.json, camera_matrices.json and Plumb.
         <site>_roof_v0.kml — footprints, ridges and hips as a Google Earth overlay for eyeballing.

Roof model: inside each mass the roof height is  min over its sloped edges of
(eave + slope * inward_distance_from_edge)  — the same "min over eave planes" rule Plumb's
synthetic suite uses for exact roofs. Facet i is the region where plane i is the minimum, found by
half-plane clipping, so hips and ridges fall out of the geometry instead of being drawn by hand.
Masses are NOT intersected with each other (no valleys between masses); the real envelope is
max over masses. That is deliberate for a v0 placeholder — Plumb's extract stage replaces this file.

THIS FILE PRODUCES VISUALISATION GEOMETRY ONLY. quotable is forced to false: no area, pitch or
length from a manual massing may be shown to a customer. Quotable measurements come from Plumb's
compliant path (DEM/footprint-dependent, no COLMAP / feature matching / triangulation).
"""
import json, math, sys, csv
from xml.dom import minidom

R = 6378137.0

def dms_to_dec(s):
    if isinstance(s, (int, float)): return float(s)
    s = s.strip(); hemi = s[-1]
    d, rest = s[:-1].split('°'); m, sec = rest.split("'"); sec = sec.rstrip('"')
    v = float(d) + float(m)/60 + float(sec)/3600
    return -v if hemi in 'SW' else v

def enu_to_latlon(E, N, lat0, lon0):
    return lat0 + math.degrees(N/R), lon0 + math.degrees(E/(R*math.cos(math.radians(lat0))))

# ---------- 2-D helpers (u,v plane) ----------
def sub(a, b): return (a[0]-b[0], a[1]-b[1])
def dot(a, b): return a[0]*b[0] + a[1]*b[1]
def norm2(a):
    l = math.hypot(*a); return (a[0]/l, a[1]/l)

def clip_halfplane(poly, n, c):
    """Keep points p with n·p <= c (Sutherland–Hodgman)."""
    out = []
    m = len(poly)
    for i in range(m):
        P, Q = poly[i], poly[(i+1) % m]
        fp, fq = dot(n, P) - c, dot(n, Q) - c
        if fp <= 1e-9: out.append(P)
        if (fp < -1e-9 and fq > 1e-9) or (fp > 1e-9 and fq < -1e-9):
            t = fp/(fp - fq); out.append((P[0] + t*(Q[0]-P[0]), P[1] + t*(Q[1]-P[1])))
    # drop duplicate consecutive points
    res = []
    for p in out:
        if not res or math.hypot(p[0]-res[-1][0], p[1]-res[-1][1]) > 1e-6: res.append(p)
    if len(res) > 1 and math.hypot(res[0][0]-res[-1][0], res[0][1]-res[-1][1]) < 1e-6: res.pop()
    return res

def signed_area(poly):
    return 0.5*sum(poly[i][0]*poly[(i+1)%len(poly)][1] - poly[(i+1)%len(poly)][0]*poly[i][1] for i in range(len(poly)))

def point_on_segment(p, a, b, tol=1e-6):
    ab = sub(b, a); ap = sub(p, a)
    cross = ab[0]*ap[1] - ab[1]*ap[0]
    if abs(cross) > tol*max(1.0, math.hypot(*ab)): return False
    t = dot(ap, ab)/max(dot(ab, ab), 1e-12)
    return -1e-6 <= t <= 1+1e-6

# ---------- main ----------
def build(site, massing, anchors_path=None):
    fr = massing['frame']
    brg = math.radians(fr['axis_bearing_deg'])
    a_hat = (math.sin(brg), math.cos(brg))          # along axis (u), in ENU (E,N)
    p_hat = (-a_hat[1], a_hat[0])                   # perpendicular (v), rotated +90° (toward entrance side for 109° → bearing 19°)
    def uv_to_en(u, v): return (u*a_hat[0] + v*p_hat[0], u*a_hat[1] + v*p_hat[1])

    lat0 = lon0 = None
    if anchors_path:
        anchors = json.load(open(anchors_path))
        org = next(a for a in anchors if a.get('role') == 'origin')
        lat0, lon0 = dms_to_dec(org['lat']), dms_to_dec(org['lon'])

    d = massing.get('defaults', {})
    facets, edges, masses_out = [], [], []
    edge_seen = {}

    def add_edge(kind, mass_id, A, B):
        # A, B are (E,N,U); dedupe shared hips/ridges by unordered endpoints
        key = tuple(sorted([tuple(round(c, 3) for c in A), tuple(round(c, 3) for c in B)]))
        if key in edge_seen:
            return
        eid = f"{kind[0].upper()}{len(edges)+1}"
        edge_seen[key] = eid
        edges.append({"id": eid, "type": kind, "mass": mass_id,
                      "a_enu": [round(c, 3) for c in A], "b_enu": [round(c, 3) for c in B],
                      "length_m": round(math.dist(A, B), 3),
                      "z_min_m": round(min(A[2], B[2]), 3), "z_max_m": round(max(A[2], B[2]), 3)})

    for mass in massing['masses']:
        poly = [tuple(p) for p in mass['footprint_uv']]
        if signed_area(poly) < 0: poly = poly[::-1]            # make CCW
        n = len(poly)
        sloped = mass.get('sloped_edges', [True]*n)
        if len(sloped) != n: raise SystemExit(f"{mass['id']}: sloped_edges must have {n} entries")
        eave = mass.get('eave_m', d.get('eave_m'))
        rise = mass.get('pitch_rise_per_12', d.get('pitch_rise_per_12'))
        s = rise/12.0
        pitch_deg = math.degrees(math.atan(s))
        # planes
        planes = []
        for i in range(n):
            A, B = poly[i], poly[(i+1) % n]
            t = norm2(sub(B, A)); nin = (-t[1], t[0])          # inward normal for CCW polygon
            planes.append({'i': i, 'a': A, 'b': B, 'n': nin, 'sloped': sloped[i]})
        def h(pl, p): return eave + s*dot(pl['n'], sub(p, pl['a']))
        ridge_z = 0.0
        mass_facets = []
        for pl in planes:
            if not pl['sloped']: continue
            region = poly[:]
            for q in planes:
                if q is pl or not q['sloped']: continue
                # keep h_pl <= h_q  ⇔ (n_pl - n_q)·p <= n_pl·a_pl - n_q·a_q
                nn = sub(pl['n'], q['n']); c = dot(pl['n'], pl['a']) - dot(q['n'], q['a'])
                if math.hypot(*nn) < 1e-9:
                    if c < -1e-9: region = []      # plane pl is everywhere higher — no facet
                    continue
                region = clip_halfplane(region, nn, c)
                if len(region) < 3: region = []; break
            if len(region) < 3: continue
            poly3 = []
            for p in region:
                E, N = uv_to_en(*p); z = h(pl, p); ridge_z = max(ridge_z, z)
                poly3.append((E, N, z))
            # aspect: downslope direction is -n (in uv) → ENU → bearing
            dn = uv_to_en(-pl['n'][0], -pl['n'][1])
            aspect = (math.degrees(math.atan2(dn[0], dn[1])) + 360) % 360
            plan_area = abs(signed_area(region))
            fid = f"{mass['id']}:{pl['i']}"
            facet = {"id": fid, "mass": mass['id'], "polygon_enu": [[round(c, 3) for c in v] for v in poly3],
                     "pitch_deg": round(pitch_deg, 2), "pitch_rise_per_12": rise, "aspect_deg": round(aspect, 1),
                     "plan_area_m2": round(plan_area, 2), "area_m2": round(plan_area/math.cos(math.radians(pitch_deg)), 2),
                     "eave_m": eave, "clipped_by_other_masses": False}
            facets.append(facet); mass_facets.append((pl, region, poly3))
        # edges of this mass
        for pl, region, poly3 in mass_facets:
            m = len(region)
            for k in range(m):
                P, Q = region[k], region[(k+1) % m]
                A3, B3 = poly3[k], poly3[(k+1) % m]
                kind = None
                for q in planes:   # on footprint boundary?
                    if point_on_segment(P, q['a'], q['b']) and point_on_segment(Q, q['a'], q['b']):
                        kind = 'eave' if q['sloped'] else 'rake'; break
                if kind is None:
                    kind = 'ridge' if abs(A3[2] - B3[2]) < 0.01 else 'hip'
                add_edge(kind, mass['id'], A3, B3)
        fp_en = [uv_to_en(*p) for p in poly]
        masses_out.append({"id": mass['id'], "note": mass.get('note', ''), "footprint_uv": [list(p) for p in poly],
                           "footprint_enu": [[round(E, 3), round(N, 3), 0.0] for E, N in fp_en],
                           "sloped_edges": sloped, "eave_m": eave, "pitch_rise_per_12": rise,
                           "pitch_deg": round(pitch_deg, 2), "ridge_m": round(ridge_z, 3),
                           "facet_count": len(mass_facets)})

    ridge_all = max(m['ridge_m'] for m in masses_out)
    eave_all = min(m['eave_m'] for m in masses_out)
    out = {
        "site": site,
        "schema": "roof.json v0.1",
        "frame": {"origin": fr.get('origin', 'A1 origin anchor'), "axes": "ENU metres, x=East, y=North, z=Up, z=0 at ground",
                  "ground_asl_m": fr.get('ground_asl_m'), "building_axis_bearing_deg": fr['axis_bearing_deg'],
                  "uv": "u along axis toward the ESE end, v perpendicular toward bearing axis-90° (entrance side)"},
        "source": massing.get('source', 'manual massing'),
        "method": massing.get('method', ''),
        "quotable": False,
        "accuracy_note": massing.get('accuracy_note', ''),
        "anchor_ties": massing.get('anchor_ties', []),
        "heights": {"eave_min_m_agl": eave_all, "ridge_max_m_agl": round(ridge_all, 3)},
        "features": massing.get('features', []),
        "masses": masses_out, "facets": facets, "edges": edges,
        "totals_not_quotable": {"facet_count": len(facets),
                                "roof_area_m2_unclipped_sum": round(sum(f['area_m2'] for f in facets), 1),
                                "ridge_m": round(sum(e['length_m'] for e in edges if e['type']=='ridge'), 1),
                                "hip_m": round(sum(e['length_m'] for e in edges if e['type']=='hip'), 1),
                                "eave_m": round(sum(e['length_m'] for e in edges if e['type']=='eave'), 1)}
    }
    json.dump(out, open(f"{site}_roof.json", 'w'), indent=1)

    # KML overlay
    if lat0 is not None:
        doc = minidom.Document(); kml = doc.createElementNS('http://www.opengis.net/kml/2.2', 'kml'); kml.setAttribute('xmlns', 'http://www.opengis.net/kml/2.2'); doc.appendChild(kml)
        D = doc.createElement('Document'); kml.appendChild(D)
        nm = doc.createElement('name'); nm.appendChild(doc.createTextNode(f"{site} roof v0 (manual massing, not quotable)")); D.appendChild(nm)
        def style(sid, color, width):
            st = doc.createElement('Style'); st.setAttribute('id', sid); ls = doc.createElement('LineStyle')
            c = doc.createElement('color'); c.appendChild(doc.createTextNode(color)); w = doc.createElement('width'); w.appendChild(doc.createTextNode(str(width)))
            ls.appendChild(c); ls.appendChild(w); st.appendChild(ls); D.appendChild(st)
        style('fp', 'ff00ffff', 2); style('ridge', 'ff0000ff', 3); style('hip', 'ffff00ff', 2); style('rake', 'ff00ff00', 2)
        def placemark(name, sid, pts):
            pm = doc.createElement('Placemark'); n_ = doc.createElement('name'); n_.appendChild(doc.createTextNode(name)); pm.appendChild(n_)
            su = doc.createElement('styleUrl'); su.appendChild(doc.createTextNode('#'+sid)); pm.appendChild(su)
            ls = doc.createElement('LineString'); am = doc.createElement('altitudeMode'); am.appendChild(doc.createTextNode('relativeToGround')); ls.appendChild(am)
            ex = doc.createElement('extrude'); ex.appendChild(doc.createTextNode('0')); ls.appendChild(ex)
            co = doc.createElement('coordinates')
            co.appendChild(doc.createTextNode(' '.join(f"{lon:.7f},{lat:.7f},{z:.2f}" for lat, lon, z in pts))); ls.appendChild(co)
            pm.appendChild(ls); D.appendChild(pm)
        for m in masses_out:
            pts = [enu_to_latlon(E, N, lat0, lon0) + (m['eave_m'],) for E, N, _ in m['footprint_enu']]
            placemark(f"footprint {m['id']} (eave {m['eave_m']} m)", 'fp', pts + [pts[0]])
        for e in edges:
            if e['type'] in ('ridge', 'hip', 'rake'):
                A, B = e['a_enu'], e['b_enu']
                placemark(f"{e['type']} {e['id']} {e['length_m']} m", e['type'], [enu_to_latlon(A[0], A[1], lat0, lon0) + (A[2],), enu_to_latlon(B[0], B[1], lat0, lon0) + (B[2],)])
        open(f"{site}_roof_v0.kml", 'w').write(doc.toprettyxml(indent=' '))
        minidom.parse(f"{site}_roof_v0.kml")
    return out

if __name__ == '__main__':
    if len(sys.argv) < 3: raise SystemExit(__doc__)
    site, mpath = sys.argv[1], sys.argv[2]
    apath = sys.argv[3] if len(sys.argv) > 3 else None
    out = build(site, json.load(open(mpath)), apath)
    print(f"{site}_roof.json: {len(out['masses'])} masses, {len(out['facets'])} facets, {len(out['edges'])} edges; "
          f"eave {out['heights']['eave_min_m_agl']} m, ridge max {out['heights']['ridge_max_m_agl']} m; quotable={out['quotable']}")
    for m in out['masses']: print(f"  {m['id']:16s} facets={m['facet_count']} ridge={m['ridge_m']:.2f} m  {m['note']}")
    t = out['totals_not_quotable']; print(f"  (not quotable) area~{t['roof_area_m2_unclipped_sum']} m², ridge {t['ridge_m']} m, hip {t['hip_m']} m, eave {t['eave_m']} m")
