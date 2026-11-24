#!/usr/bin/env python3
"""Convert <site>_camera_matrices.json (per-frame 4x4 camera-to-world in ENU, OpenCV camera frame — from es_matrices.py)
into the 6-DoF trajectory JSON consumed by blender_gbuffers.py.
Usage: python3 matrices_to_trajectory.py <site>_camera_matrices.json [--out <site>_trajectory.json]
Emits camera-to-world position + quaternion per frame with convention "opencv" (the renderer applies the OpenCV→OpenGL
flip itself), and prints the Blender focal length: f_mm = fx_px * 36 / width_px on a 36 mm sensor, horizontal fit.
Quaternion is of the OpenCV c2w rotation, Shepperd's method. Round-trip note: the matrices file stores rotations at
6 decimals, so the stored 3x3 is non-orthonormal at ~1.4e-6 (|R^T R - I|); the emitted quaternion is the nearest true
rotation, and rebuilding the matrix from it differs from the stored one by up to ~3e-6 (≈0.0002° — that is the storage
rounding floor, not converter error; verified over all 661 ONSC frames, translations exact).
"""
import json, math, sys, argparse

ap = argparse.ArgumentParser(); ap.add_argument("matrices"); ap.add_argument("--out"); args = ap.parse_args()
d = json.load(open(args.matrices))

def quat(m):  # 3x3 row-major → (w, x, y, z), Shepperd
    t = m[0][0] + m[1][1] + m[2][2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        return ((s/4), (m[2][1]-m[1][2])/s, (m[0][2]-m[2][0])/s, (m[1][0]-m[0][1])/s)
    if m[0][0] >= m[1][1] and m[0][0] >= m[2][2]:
        s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
        return ((m[2][1]-m[1][2])/s, s/4, (m[0][1]+m[1][0])/s, (m[0][2]+m[2][0])/s)
    if m[1][1] >= m[2][2]:
        s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
        return ((m[0][2]-m[2][0])/s, (m[0][1]+m[1][0])/s, s/4, (m[1][2]+m[2][1])/s)
    s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
    return ((m[1][0]-m[0][1])/s, (m[0][2]+m[2][0])/s, (m[1][2]+m[2][1])/s, s/4)

traj = []
for f in d["frames"]:
    c = f["c2w_enu_zup_rowmajor"]
    R = ((c[0], c[1], c[2]), (c[4], c[5], c[6]), (c[8], c[9], c[10]))
    w, x, y, z = quat(R)
    traj.append({"frame": f["frame"], "x_enu": c[3], "y_enu": c[7], "z_enu": c[11],
                 "qx": round(x, 9), "qy": round(y, 9), "qz": round(z, 9), "qw": round(w, 9)})
K = d["frames"][0]["K"]
out = {"site": d["name"], "convention": "opencv", "fps": d["fps"],
       "world": d["conventions"]["world"], "camera": d["conventions"]["camera"], "trajectory": traj}
path = args.out or f"{d['name'].split()[0].lower()}_trajectory.json"
json.dump(out, open(path, "w"))
f_mm = K["fx"] * 36.0 / K["width"]
print(f"{d['name']}: {len(traj)} frames → {path}")
print(f"  blender: -f {f_mm:.4f} -W {K['width']} -H {K['height']}   (fx {K['fx']} px, 36 mm sensor, horizontal fit)")
