#!/usr/bin/env python3
"""QA a generated (rendered) clip of one beat against the ground truth: map generated frames back to master frames by time,
draw the predicted anchors and roof edges over the generated frames, and give a per-beat verdict.
Usage: python3 gen_qa.py <generated.mp4> <beat> --anchor-pixels <site>_anchor_pixels.csv --roof-edges <site>_roof_edges_px.csv
       [--out-dir gen_qa_<beat>] [--measured measured.csv] [--contact 285,390,480] [--f0 N]
Beats (master frame offset F0, nominal length, default contact master frames):
  reveal    F0=0    6 s   0, 90, 180
  orbit     F0=180  10 s  285, 390, 480
  rise_hold F0=480  6 s   600, 660
Mapping is by TIME, not frame index: generated frame j at t_j = j/fps → master m = F0 + round(t_j·30); if the model changed
fps or duration, that is reported and the time mapping still holds. Predictions are per master frame from the QA CSVs
(1920×1080 master); if the output is a different resolution at the same aspect, x scales by W/1920 and y by H/1080;
if the aspect changed the check is invalid and this script stops.
Verdict per beat, from the measured errors (--measured, columns: anchor,master_frame,u_px,v_px — your visual read of where
the cupola and the four roof corners actually appear in the *generated* frames, at output resolution, ±10 px is fine):
  geometry held (< 25 px, nothing missing) | drifted (25–80 px) | hallucinated (> 80 px or the building shape changed).
Anything the model invented or removed (extra wings, second cupola, missing porte-cochère, colour, text) is a human call —
note it in the report and override the verdict upward if needed.
Needs ffmpeg/ffprobe on PATH and Pillow. The flyover consumes geometry; it never produces measurements.
"""
import argparse, csv, json, math, os, subprocess, sys
from PIL import Image, ImageDraw

BEATS = {"reveal": (0, 6.0, [0, 90, 180]), "orbit": (180, 10.0, [285, 390, 480]), "rise_hold": (480, 6.0, [600, 660])}
EDGE_COLOR = {"ridge": (255, 60, 60), "hip": (255, 160, 40), "eave": (60, 220, 255), "rake": (120, 255, 120)}
ap = argparse.ArgumentParser()
ap.add_argument("clip"); ap.add_argument("beat", choices=sorted(BEATS))
ap.add_argument("--anchor-pixels", required=True); ap.add_argument("--roof-edges", required=True)
ap.add_argument("--out-dir"); ap.add_argument("--measured"); ap.add_argument("--contact"); ap.add_argument("--f0", type=int)
ap.add_argument("--roof", help="<site>_roof.json: derive the anchor comparison points from real geometry (cupola base, eave corners)")
ap.add_argument("--matrices", help="<site>_camera_matrices.json: required with --roof, projects the geometry points per master frame")
args = ap.parse_args()
F0, nominal, contact = BEATS[args.beat]
if args.f0 is not None: F0 = args.f0
if args.contact: contact = [int(x) for x in args.contact.split(",")]
out = args.out_dir or f"gen_qa_{args.beat}"; os.makedirs(out, exist_ok=True)
report = [f"gen_qa: {args.clip} | beat {args.beat} (F0={F0}, nominal {nominal:g} s)"]

p = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames", "-show_entries", "format=duration",
    "-of", "json", args.clip], capture_output=True, text=True, check=True).stdout)
s = p["streams"][0]; W, H = s["width"], s["height"]; num, den = s["r_frame_rate"].split("/"); fps = float(num)/float(den)
n = int(s["nb_read_frames"]); dur = float(p["format"]["duration"])
report.append(f"clip: {W}x{H} @ {fps:g} fps, {n} frames, {dur:.3f} s")
if abs(W/H - 16/9) > 0.01:
    report.append(f"STOP: aspect {W}x{H} is not 16:9 — pixel predictions do not apply; the check is invalid.")
    print("\n".join(report)); open(f"{out}/report.txt", "w").write("\n".join(report) + "\n"); sys.exit(2)
sx, sy = W/1920, H/1080
if abs(fps - 30) > 0.01 or abs(dur - nominal) > 0.1:
    report.append(f"note: fps/duration differ from the master beat ({fps:g} fps, {dur:.2f} s vs 30 fps, {nominal:g} s) — mapping by time.")

anch, edges = {}, {}
for r in csv.DictReader(open(args.anchor_pixels)): anch.setdefault(int(r["frame"]), []).append(r)
for r in csv.DictReader(open(args.roof_edges)): edges.setdefault(int(r["frame"]), []).append(r)

# Real-geometry comparison points (preferred over the CSV's terrain / flat "+9 m roofline" points, which predate
# roof.json): A1 = the cupola base centre — A1 *is* the cupola, the ENU origin, so (0, 0, base_m_agl); the roof-corner
# anchors = the roof.json facet vertex pinned to them (eave corner). Projection matches roof_check.py exactly.
qa_pts, cams = {}, {}
if args.roof and args.matrices:
    roof = json.load(open(args.roof)); mats = json.load(open(args.matrices))
    cams = {f["frame"]: f for f in mats["frames"]}
    cup = next((ft for ft in roof.get("features", []) if ft.get("type") == "cupola"), None)
    if cup: qa_pts["A1_cupola"] = (0.0, 0.0, float(cup["base_m_agl"]))
    verts = {tuple(p) for f in roof["facets"] for p in f["polygon_enu"]}
    for a in mats["anchors_enu"]:
        if a["name"] in qa_pts: continue
        v = min(verts, key=lambda p: (p[0]-a["E"])**2 + (p[1]-a["N"])**2)
        if math.hypot(v[0]-a["E"], v[1]-a["N"]) <= 1.5: qa_pts[a["name"]] = v  # pinned roof corners only

def project_geom(name, m):
    if name not in qa_pts or m not in cams: return None
    c = cams[m]["c2w_enu_zup_rowmajor"]; K = cams[m]["K"]; X = qa_pts[name]
    R = ((c[0], c[1], c[2]), (c[4], c[5], c[6]), (c[8], c[9], c[10])); t = (c[3], c[7], c[11])
    Xc = [sum(R[j][i]*(X[j]-t[j]) for j in range(3)) for i in range(3)]  # w2c = R^T (X - t)
    if Xc[2] <= 0.1: return None
    return (K["fx"]*Xc[0]/Xc[2] + K["cx"])*sx, (K["fy"]*Xc[1]/Xc[2] + K["cy"])*sy, "roof-geometry"

def predicted(name, m):
    g = project_geom(name, m)
    if g: return g
    for r in anch.get(m, []):
        if r["anchor"] == name:
            if r["u_px_roofline"]: return float(r["u_px_roofline"])*sx, float(r["v_px_roofline"])*sy, "roofline"
            if r["u_px"]: return float(r["u_px"])*sx, float(r["v_px"])*sy, "ground"
    return None

def annotate(img, m):
    d = ImageDraw.Draw(img); lw = max(1, round(W/960))
    for e in edges.get(m, []):
        d.line([(float(e["ax"])*sx, float(e["ay"])*sy), (float(e["bx"])*sx, float(e["by"])*sy)],
               fill=EDGE_COLOR.get(e["type"], (255, 255, 255)), width=lw)
    for r in anch.get(m, []):
        for u, v, col in ((r["u_px"], r["v_px"], (255, 255, 0)), (r["u_px_roofline"], r["v_px_roofline"], (255, 0, 255))):
            if not u: continue
            x, y, rad = float(u)*sx, float(v)*sy, 4*lw
            d.ellipse([x-rad, y-rad, x+rad, y+rad], outline=col, width=lw)
            d.text((x+rad+2, y-rad), r["anchor"], fill=col)
    for name in qa_pts:
        g = project_geom(name, m)
        if not g: continue
        x, y, rad = g[0], g[1], 5*lw
        d.ellipse([x-rad, y-rad, x+rad, y+rad], outline=(255, 255, 255), width=lw)
        d.text((x+rad+2, y+rad), name + " (geom)", fill=(255, 255, 255))
    d.text((8, 8), f"master f{m}", fill=(255, 255, 255))
    return img

sheets = []
report.append("frame mapping (contact points):")
for m in contact:
    j = min(max(round((m - F0)/30*fps), 0), n-1); t = j/fps
    ma = F0 + round(t*30)  # the master frame this generated frame actually corresponds to (differs from m only when clamped)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", args.clip, "-vf", f"select=eq(n\\,{j})", "-vsync", "0",
                    "-frames:v", "1", f"{out}/gen_f{j}_master_f{ma}.png"], check=True)
    img = annotate(Image.open(f"{out}/gen_f{j}_master_f{ma}.png").convert("RGB"), ma)
    img.save(f"{out}/gen_f{j}_master_f{ma}.png"); sheets.append((ma, img))
    report.append(f"  master f{ma} ← generated f{j} (t={t:.3f} s{f' — requested f{m}, clamped to clip range' if ma != m else ''})")
tw = 640; th = round(tw*H/W)
sheet = Image.new("RGB", (tw, th*len(sheets)))
for i, (m, img) in enumerate(sheets): sheet.paste(img.resize((tw, th)), (0, i*th))
sheet.save(f"{out}/contact_sheet.png"); report.append(f"contact sheet: {out}/contact_sheet.png (predicted overlay: edges ridge/hip/eave/rake = red/orange/cyan/green; anchors ground=yellow, roofline=magenta)")

if args.measured:
    rows, errs, missing = [], [], []
    for r in csv.DictReader(open(args.measured)):
        m = int(r["master_frame"]); pred = predicted(r["anchor"], m)
        if not r.get("u_px"): missing.append(f"{r['anchor']}@f{m}"); continue
        if not pred: report.append(f"  no prediction for {r['anchor']} at master f{m}"); continue
        e = math.hypot(float(r["u_px"]) - pred[0], float(r["v_px"]) - pred[1]); errs.append(e)
        rows.append(f"  {r['anchor']:14s} f{m:3d}  measured ({float(r['u_px']):7.1f},{float(r['v_px']):7.1f})  predicted[{pred[2]}] ({pred[0]:7.1f},{pred[1]:7.1f})  err {e:6.1f} px")
    report.append("measured vs predicted:"); report.extend(rows)
    if missing: report.append(f"  MISSING (not found in the generated frame): {', '.join(missing)}")
    if errs:
        worst = max(errs)
        verdict = "geometry held" if worst < 25 and not missing else ("drifted" if worst <= 80 else "hallucinated")
        if missing and verdict == "geometry held": verdict = "drifted"
        report.append(f"VERDICT ({args.beat}): {verdict} — max error {worst:.1f} px over {len(errs)} points" + (f", {len(missing)} missing" if missing else ""))
else:
    report.append("next: read the annotated frames, note where the cupola and the four roof corners actually sit (±10 px),")
    report.append(f"write measured.csv (anchor,master_frame,u_px,v_px — blank u_px if a feature is missing) and re-run with --measured for the verdict.")

open(f"{out}/report.txt", "w").write("\n".join(report) + "\n")
print("\n".join(report))
