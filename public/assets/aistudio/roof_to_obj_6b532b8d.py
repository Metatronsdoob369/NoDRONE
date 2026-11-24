#!/usr/bin/env python3
"""Export <site>_roof.json (roof.json v0.1 schema — facets with polygon_enu) as a Wavefront OBJ in the same ENU
metres (x=East, y=North, z=Up, z=0 at ground). One polygon face per facet, vertices deduplicated.
Usage: python3 roof_to_obj.py <site>_roof.json [--out <site>_roof.obj]
Import into Blender with Y-forward / Z-up axes so coordinates stay ENU verbatim (blender_gbuffers.py --obj does this).
Geometry pass-through only — this script computes nothing; the flyover consumes geometry and never produces measurements.
"""
import json, argparse

ap = argparse.ArgumentParser(); ap.add_argument("roof"); ap.add_argument("--out"); args = ap.parse_args()
d = json.load(open(args.roof))
verts, index = [], {}
def vid(p):
    k = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
    if k not in index:
        index[k] = len(verts) + 1; verts.append(k)
    return index[k]
faces = [(f["id"], [vid(p) for p in f["polygon_enu"]]) for f in d["facets"]]
path = args.out or f"{d['site']}_roof.obj"
with open(path, "w") as o:
    o.write(f"# {d['site']} roof v0 — {d['schema']}, ENU metres from {d['frame']['origin']}\n")
    o.write(f"# quotable={d['quotable']} — massing placeholder; Plumb replaces the source roof.json in place\n")
    for v in verts: o.write(f"v {v[0]} {v[1]} {v[2]}\n")
    for fid, idx in faces:
        o.write(f"g {fid.replace(' ', '_')}\nf {' '.join(str(i) for i in idx)}\n")
print(f"{d['site']}: {len(faces)} facets, {len(verts)} unique vertices → {path}")
