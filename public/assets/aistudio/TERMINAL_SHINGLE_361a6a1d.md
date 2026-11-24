# Paste into the terminal — material-swap pass in Blender (no generative model)

(Re-sent — the first copy never reached the Mac. Design note: the spec file is `material_spec.json`, not `shingle_spec.json`. Everything downstream is sector-agnostic by default — a shingle is one `family` among tile, metal panel, standing seam, membrane, siding — because the same course/reveal geometry drives all of them. See `MATERIAL_SPEC_LIBRARY.md`.)

Go with your second option now: texture the v0 roof through the proven camera. Same rules as the G-buffer pass — nothing under `inputs/`, `plan/`, `qa/` or `earth-studio-export/` changes; new code goes in `engine/`, new renders in `renders/`, and every claim gets a number.

## What to build — `engine/blender_material.py` (reuse blender_gbuffers.py's scene, camera and frame loop)
1. **Material at true course scale.** Take a shingle spec as a small JSON (`sites/onsc-clubhouse/inputs/material_spec.json`; write a first one for a generic architectural laminate: shingle 13⅛ × 39⅜ in, exposure 5⅝ in = 0.143 m per course, colour a mid weathered-grey with a subtle dual-tone; note the spec is a placeholder until a manufacturer sheet is uploaded). Build a procedural or tiled texture whose course spacing is exactly the exposure in metres along each facet's slope direction, with courses running parallel to the eave, tabs offset per course, and a slightly raised butt edge (bump/normal) so the low sun reads the courses. UV each facet in its own plane: u along the eave, v up the slope, scale 1 unit = 1 m. Hip and ridge lines get a cap course.
2. **Light matching Earth Studio's Time of Day.** Sun lamp: elevation 5.4°, azimuth 275.5° (from north, clockwise) — that is 2026-09-02 23:15 UTC at the site; warm colour temperature (~3200 K), soft sky fill so the shadowed planes are not black. Ground plane a neutral dark green. World black or transparent as suits compositing.
3. **Renders (Eevee or Cycles, 1920×1080, frames 0–660, transparent background, PNG or EXR with alpha):**
   - `renders/material_<spec>_fov40/` frames + `renders/material_<spec>_fov40.mp4` — the re-covered roof over transparent/black.
   - Keep `mask_fov40.mp4` as the composite matte (same camera, same mesh, so they align by construction).
4. **Two composites, for two audiences:**
   - `renders/composite_internal_fov40.mp4` — shingle render over the Earth Studio guide frames using the mask. Internal only (Google imagery, attribution stays in frame); this is the first look at "the clubhouse in shingle X" in motion.
   - Leave a documented hook for the customer-facing composite: same operation over whatever `gen_qa.py` passes from a generative run later (Higgsfield/GPU server), so the shingle roof rides on generated surroundings.

## Proofs to report
- Course scale: on frame 600 (straight down, 85 m), count courses along the east block's SW facet between eave and ridge; expected = facet slope length ÷ 0.143 m. Slope length from `clubhouse_roof.json` (facet area ÷ eave length, or the polygon geometry). Report expected vs counted (±1 course).
- Alignment: run the same edge test as the G-buffer pass on the shingle render's alpha edge vs `qa/clubhouse_roof_edges_px.csv` on the six contact frames — should be identical to the wire result since it is the same mesh and camera; say so with the number.
- Light direction: on frame 285 (camera west, 55 m) the WNW sun should light the west-facing planes and leave the east-facing planes in shade; confirm visually on the contact sheet and note the shadow direction on the ground plane.
- Hold margin: confirm the shingle render's roof bbox at frame 600 (expect y ≈ 7.5–917 px, same as roof_check).

## Boundary reminder
The shingle pass renders geometry; it computes no area, pitch or length, and `material_spec.json` carries no quantity estimate (bundles, squares). Anything of that kind is Plumb's. `tests/test_compliance.py` must still pass.

Report back with the file list, frame counts, the four proofs, and a contact sheet of frames 180, 285, 480 and 600 from `composite_internal_fov40.mp4`.
