#!/usr/bin/env python3
"""Turn an Earth Studio 3D Tracking Data JSON (Local coordinate space) into per-frame camera-to-world matrices + intrinsics.
Usage: python3 es_matrices.py <export.json> <site> [--ground 163] [--target-agl 7] [--out <site>_camera_matrices.json]
Reads anchors.json (same folder). Writes <site>_camera_matrices.json: 4x4 c2w (row-major) in ENU metres from the origin anchor (z up), OpenCV camera frame (x right, y down, z forward), pinhole K.
Facts this encodes (verified 3 Sep 2026, see qa/clubhouse_export_notes.md): the export's "Local" frame is ECEF axes translated to the origin track point (NOT tangent-plane ENU) — rotate by the ENU basis at the origin;
rotation = Rx(x)·Ry(y)·Rz(z) in degrees, camera forward = R·(0,0,+1), camera up = R·(0,-1,0) (After-Effects-style, y down); position from coordinate lat/lon/alt (exact); fx = fy = (H/2)/tan(fovVertical/2).
"""
import json, math, re, sys, argparse
ap = argparse.ArgumentParser(); ap.add_argument("export"); ap.add_argument("site"); ap.add_argument("--ground", type=float)
ap.add_argument("--target-agl", type=float, default=7.0); ap.add_argument("--out"); args = ap.parse_args()
d = json.load(open(args.export)); A = json.load(open("anchors.json"))
def dec(s):
    if isinstance(s, (int, float)): return float(s)
    try: return float(s)
    except ValueError: pass
    m = re.match(r"""\s*(\d+)[°\s]+(\d+)['′\s]+([\d.]+)["″\s]*([NSEW])""", s.strip()); v = int(m[1]) + int(m[2])/60 + float(m[3])/3600
    return -v if m[4] in "SW" else v
dec7 = lambda s: round(dec(s), 7)  # the origin is the published 7-decimal coordinate (export notes, track-point display); anchors stay full-precision DMS
origin = next(a for a in A if a["role"] == "origin"); lat0, lon0 = dec7(origin["lat"]), dec7(origin["lon"])
ground = args.ground if args.ground is not None else float(origin.get("es_alt", origin["elev_m"]))
R = 6378137.0; p, l = math.radians(lat0), math.radians(lon0)
Ev = (-math.sin(l), math.cos(l), 0); Nv = (-math.sin(p)*math.cos(l), -math.sin(p)*math.sin(l), math.cos(p)); Uv = (math.cos(p)*math.cos(l), math.cos(p)*math.sin(l), math.sin(p))
dot = lambda a, b: sum(x*y for x, y in zip(a, b)); sub = lambda a, b: tuple(x-y for x, y in zip(a, b))
norm = lambda v: (lambda n: tuple(x/n for x in v))(math.sqrt(sum(x*x for x in v)))
enu = lambda lat, lon, alt: (R*math.radians(lon-lon0)*math.cos(p), R*math.radians(lat-lat0), alt-ground)
es_to_enu = lambda q: (dot(q, Ev), dot(q, Nv), dot(q, Uv))
def rot(rx, ry, rz):
    a, b, c = math.radians(rx), math.radians(ry), math.radians(rz)
    Rx = ((1, 0, 0), (0, math.cos(a), -math.sin(a)), (0, math.sin(a), math.cos(a)))
    Ry = ((math.cos(b), 0, math.sin(b)), (0, 1, 0), (-math.sin(b), 0, math.cos(b)))
    Rz = ((math.cos(c), -math.sin(c), 0), (math.sin(c), math.cos(c), 0), (0, 0, 1))
    mm = lambda A, B: tuple(tuple(sum(A[i][k]*B[k][j] for k in range(3)) for j in range(3)) for i in range(3))
    return mm(mm(Rx, Ry), Rz)
mv = lambda M, v: tuple(sum(M[i][k]*v[k] for k in range(3)) for i in range(3))
W, H = d["width"], d["height"]; fps = d["frameRate"]; T = (0.0, 0.0, args.target_agl)
frames, max_fwd_err, max_roll, max_pos_diff = [], 0.0, 0.0, 0.0
for i, fr in enumerate(d["cameraFrames"]):
    c = fr["coordinate"]; C = enu(c["latitude"], c["longitude"], c["altitude"]); fov = fr["fovVertical"]
    Rm = rot(fr["rotation"]["x"], fr["rotation"]["y"], fr["rotation"]["z"])
    right, down, fwd = (es_to_enu(mv(Rm, v)) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    max_fwd_err = max(max_fwd_err, math.degrees(math.acos(max(-1.0, min(1.0, dot(fwd, norm(sub(T, C))))))))
    max_roll = max(max_roll, math.degrees(math.asin(max(-1.0, min(1.0, abs(right[2]))))))
    q = fr["position"]; max_pos_diff = max(max_pos_diff, math.dist(C, es_to_enu((q["x"], q["y"], q["z"]))))
    fy = (H/2)/math.tan(math.radians(fov/2))
    c2w = [right[0], down[0], fwd[0], C[0], right[1], down[1], fwd[1], C[1], right[2], down[2], fwd[2], C[2], 0, 0, 0, 1]
    frames.append({"frame": i, "time_s": round(i/fps, 4), "c2w_enu_zup_rowmajor": [round(x, 6) for x in c2w],
                   "K": {"fx": round(fy, 3), "fy": round(fy, 3), "cx": W/2, "cy": H/2, "width": W, "height": H, "fov_vertical_deg": fov},
                   "lat": c["latitude"], "lon": c["longitude"], "alt_asl_m": c["altitude"]})
anchors_enu = [dict(zip(("name", "E", "N", "U"), (a["name"],) + tuple(round(x, 2) for x in enu(dec(a["lat"]), dec(a["lon"]), float(a.get("es_alt", a["elev_m"])))))) for a in A if a["role"] != "ref"]
fmt = lambda v: f"{v:.7f}".rstrip("0").rstrip(".")
out = {"name": d["name"], "frames_count": len(frames), "fps": fps,
       "conventions": {"world": f"ENU metres from {origin['name']} ground point ({fmt(lat0)}, {fmt(lon0)}, {ground:g} m ASL): x=East, y=North, z=Up",
                       "camera": "OpenCV: x=right, y=down, z=forward (this is Earth Studio's native camera frame; up = -y)",
                       "matrix": "camera-to-world, 4x4, row-major, translation in last column; world_point = c2w @ [x_cam, y_cam, z_cam, 1]; for world-to-camera (COLMAP) invert",
                       "intrinsics": "pinhole, principal point at image centre, fx=fy=(H/2)/tan(fov_v/2); no distortion",
                       "source": "rotation R = Rx(x)·Ry(y)·Rz(z) (deg) applied to camera axes in Earth Studio's ECEF-shifted Local frame, then rotated to ENU; position from lat/lon/alt (exact)"},
       "verification": {"max_forward_error_deg_vs_camera_target": round(max_fwd_err, 3), "max_roll_deg": round(max_roll, 3), "max_position_diff_m_es_vs_latlon": round(max_pos_diff, 3)},
       "anchors_enu": anchors_enu, "frames": frames}
path = args.out or f"{args.site}_camera_matrices.json"; json.dump(out, open(path, "w"))
print(f"{d['name']}: {len(frames)} frames → {path}")
print(f"  max forward-axis error vs camera target {T}: {max_fwd_err:.3f}° | max roll {max_roll:.3f}° | Local→ENU vs lat/lon position max diff {max_pos_diff:.3f} m")
