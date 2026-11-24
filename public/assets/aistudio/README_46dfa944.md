# Flyover engine

Reusable ground-truth → Earth Studio → verification pipeline for property flyovers. Works for any property; `sites/onsc-clubhouse/` is the first worked example and the regression test. The full spec — procedure, every verified gotcha, scripts as appendices — is `SKILL.md`.

## The Site model — three input files

| file | what | who writes it |
|---|---|---|
| `anchors.json` | *where* — hover-read anchors + reference pin; the origin anchor is the permanent coordinate system for the property (ENU metres from its ground point) | operator, from Google Earth Web |
| `roof.json` | *what* — roof geometry: facets (pitch/aspect/area), ridge/hip/eave/rake edges, eave/ridge heights, same ENU frame | `roof_massing.py` (v0, hand massing, **not quotable**) → replaced in place by Plumb (measured, quotable; same schema) |
| `move.json` | *one flight* — reveal/orbit/rise-hold parameters; a second flight is a second move file | operator |

## The scripts

Stdlib-only Python unless noted. One site per working directory (`anchors.json` read from cwd).

| script | run | consumes | produces |
|---|---|---|---|
| `gt_build.py` | `python3 gt_build.py <site> move.json` | anchors, move | `<site>_ground_truth.md`, `<site>_anchors_path.kml`, `<site>_keyframes.csv` |
| `es_verify.py` | `python3 es_verify.py "<export>.json" <site> --keyframes <site>_keyframes.csv --ground 163` | Earth Studio 3D Tracking Data JSON, anchors | `<site>_camera_enu.csv`, `<site>_anchor_pixels.csv`, pass/fail report |
| `es_matrices.py` | `python3 es_matrices.py "<export>.json" <site>` | export JSON, anchors | `<site>_camera_matrices.json` — per-frame 4×4 camera-to-world in ENU (z up) + pinhole intrinsics |
| `roof_massing.py` | `python3 roof_massing.py <site> roof_massing.json anchors.json` | hand massing in the building frame, anchors | `<site>_roof.json` (`quotable: false`), `<site>_roof_v0.kml` |
| `roof_check.py` | `python3 roof_check.py <site>_roof.json <site>_camera_matrices.json` | roof, camera matrices | geometry PASS/FAIL, `<site>_roof_edges_px.csv`, framing table at the keyframes |
| `gen_qa.py` | `python3 gen_qa.py <generated.mp4> <beat> --anchor-pixels … --roof-edges …` (needs ffmpeg + Pillow) | a generated/rendered clip of one beat, the QA CSVs | time-mapped contact frames with predicted overlays, error table, verdict: held / drifted / hallucinated |
| `matrices_to_trajectory.py` | `python3 matrices_to_trajectory.py <site>_camera_matrices.json` | camera matrices | `<site>_trajectory.json` (c2w quaternions, opencv convention) + the Blender focal length |
| `roof_to_obj.py` | `python3 roof_to_obj.py <site>_roof.json` | roof.json | `<site>_roof.obj` — facet polygons, ENU metres verbatim |
| `blender_gbuffers.py` | `blender -b --factory-startup -P blender_gbuffers.py -- -i <traj>.json -o out --obj <roof>.obj -f 27.8182 -p WIREFRAME,SHADING [--frames …]` | trajectory JSON, OBJ | Workbench G-buffer passes per frame (wireframe via Wireframe modifier; DEPTH pending a compositor Z-pass fallback — not a Workbench color type) |

## Pipeline and the Earth Studio seam

```
anchors.json + move.json → gt_build.py → brief + KML + keyframes
        ↓
Earth Studio (browser, human-in-the-loop) → project + render → frames + tracking JSON
        ↓
es_verify.py → camera ENU + anchor pixels + report
es_matrices.py → camera_matrices.json (c2w + K)
roof_massing.py → roof.json v0 + roof KML     roof_check.py → roof edges px + framing
        ↓
Plumb (separate repo) → measured roof.json replaces v0 in place
matrices_to_trajectory.py + roof_to_obj.py → blender_gbuffers.py → per-frame G-buffers (route 2 control signals)
Renderer (video model / Blender route / 3DGS) ← guide frames + G-buffers as motion/structure + refs/ photos as appearance
gen_qa.py ← any generated clip → held / drifted / hallucinated verdict vs the ground truth
```

Route-2 acceptance (verified 3 Sep 2026, Blender 4.5): the Blender camera built from `<site>_trajectory.json` reproduces
the Earth Studio camera — wireframe renders of the v0 roof match `qa/clubhouse_roof_edges_px.csv` bidirectionally at
100% on all contact frames (predicted↔rendered within 4–6 px).

**Earth Studio has no API.** Everything before it (extraction → generator) and after it (verify → matrices → renderer hand-off) automates; the build-and-render step is a browser-automation or operator stage *by design* (~25 min per site, click by click). Plan any backend around that seam. Typing a value into Earth Studio does **not** create a keyframe — the keyframe button must be clicked.

## Verified facts (the easy-to-get-wrong list; full detail in SKILL.md and the site's `qa/*_export_notes.md`)

1. Earth Studio's "Local" export frame is **ECEF axes shifted to the origin track point — not east/north/up**. Rotate by the ENU basis at the origin before using positions as metres; after rotation, track points match hover-read anchors to 0.05–0.15 m.
2. Rotation is **R = Rx(x)·Ry(y)·Rz(z)** in degrees; camera forward = R·(0,0,+1), up = R·(0,−1,0). Camera frame is OpenCV-style (x right, y down, z forward).
3. `cameraFrames[i].coordinate` (lat/lon/alt ASL) is exact; prefer it for positions.
4. **FOV 40° vertical** is required for a ~60 m building with the default move; the 20° default crops the roof. fx = fy = (H/2)/tan(fov/2) = 1483.6 px at 40°, 1920×1080.
5. Google requires visible attribution on every Earth Studio frame, no commercial no-attribution licence: the render is an internal motion/structure guide; the customer-facing asset is generated from the property's own photos.
6. Coordinate precision convention (es_matrices.py): the origin is the *published 7-decimal* lat/lon; anchor coordinates are parsed from DMS at full precision. This is what makes regenerated camera matrices byte-consistent with the ONSC QA set.

## The Plumb boundary

Verbatim from HANDOFF.md (fact 8), because it is the compliance line this repo must never cross:

> **Roof geometry is a Site file, and measurements are Plumb's.** `roof.json` (facets with pitch/aspect/area, ridge/hip/eave/rake edges, eave/ridge heights, ENU from A1) is consumed by the shingle visualisation, the frame QA and the renderer. Any non-Plumb roof file is `quotable: false` (roof_check.py enforces it): areas, pitches and lengths a salesman quotes are EagleView's claimed deliverable class and must come through Plumb's compliant path (DEM/footprint-dependent, no COLMAP/feature-matching/triangulation/PnP). The flyover consumes geometry; it never produces measurements. Nothing on Plumb's banned list (pycolmap, hloc, lightglue, findEssentialMat, triangulatePoints, solvePnP) is used in this repo.

This repo consumes roof geometry and never produces measurements; every non-Plumb `roof.json` is `quotable: false`. None of `pycolmap` / `hloc` / `lightglue` / `findEssentialMat` / `triangulatePoints` / `solvePnP` may be imported here — `tests/test_compliance.py` greps the engine scripts (`engine/*.py`; the docs are allowed to *name* the banned list, code is not) and fails if any appear.

## Environment note (macOS)

The engine is stdlib-only, but Homebrew Python 3.14 on this Mac has a broken `pyexpat` (expat dylib symbol mismatch) that kills the KML self-check in `gt_build.py`. Run everything under `/usr/bin/python3` (system Python, 3.9+) — all ONSC verification was done that way.
