# For NotebookLM — what to ingest and what it changes

Add these three files as sources (they are the authoritative record of what was built and verified):
1. `engine/SKILL.md` — the complete process spec, including the two scripts.
2. `HANDOFF.md` — the file inventory, pipeline state, and the seven verified facts.
3. `sites/onsc-clubhouse/qa/clubhouse_export_notes.md` — the decoded Earth Studio export format.
4. `sites/onsc-clubhouse/inputs/clubhouse_roof.json` — the roof geometry layer (schema by example: masses, facets, edges, heights, `quotable`).

Then check the backend design against these points; each one is a place where a reasonable design would be wrong:
- The data model has two entities, not one: **Site** (anchors.json + roof.json — permanent, one per property) and **Flight** (move.json — disposable, many per site). Renders, exports and QA files hang off a Flight.
- **roof.json has one authoritative writer — Plumb (Joe's separate roof-measurement service) — and a manual v0 fallback flagged `quotable: false`.** The flyover service consumes roof geometry (shingle visualisation, per-frame edge QA, renderer hand-off) and never computes or displays measurements. Design the boundary as a hard one: no area/pitch/length from the flyover side ever reaches a customer, a proposal or a salesman; the compliance list (no pycolmap, hloc, lightglue, findEssentialMat, triangulatePoints, solvePnP) applies to the flyover service too, so the two services never need a joint compliance argument.
- The Earth Studio stage has no API. Model it as a human-in-the-loop or browser-automation task with a hand-off in (KML + keyframes CSV + track-point table) and a hand-off out (the tracking JSON + frame folder). Everything upstream and downstream is pure Python and can be a service.
- The export's "Local" frame is ECEF-shifted, not ENU. Any code that treats it as metres east/north is wrong by up to ~90 m on this site. The rotation is in `es_verify.py`.
- Camera rotation convention and intrinsics are known (R = Rx·Ry·Rz, forward +Z, up −Y, fx = fy = (H/2)/tan(fov/2)). Field of View must be set to 40° for the default move; the default 20° crops the building.
- The customer-facing asset is never the Earth Studio render (attribution licence). The render is the motion/structure guide for a generative or 3D renderer fed by the property's own photos; `anchor_pixels.csv` is the acceptance test for whatever that renderer produces.
- Not yet built: `es_matrices.py` as a script (math is specified; the ONSC output exists), the renderer hand-off (shingle material applied to roof.json facets, camera from camera_matrices.json), frame stitching, and Grok Imagine 2 replica ingestion (Joe already has the photo set — there is no photo-capture workflow to build for ONSC).
- Open decision surfaced by the roof layer: the 85 m hold keeps the lawn-side wings in frame with <1 % top margin; the next render should raise KF5/KF6 to 258 m ASL or accept the wing at the edge.
