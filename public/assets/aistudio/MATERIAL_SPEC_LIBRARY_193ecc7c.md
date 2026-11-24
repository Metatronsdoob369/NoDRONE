# Material spec library — how to gather a large grouping, auditably

## The principle
A material spec is **public geometry facts + provenance + a colour you legally own**. Split that way, the library is defensible at any scale and needs no manufacturer's permission to build.

- **Geometry facts** (module size, exposure/reveal, coverage per square, course direction, joint offset, minimum slope) are published by every manufacturer on a data sheet. Facts are not copyrightable. Recording them with a citation is exactly what a spec writer does.
- **Provenance** is what makes it auditable: source URL, document title, revision code, retrieval date, and the page or table the value came from. A spec without provenance is a guess; with it, a rep can defend the render in front of a manufacturer rep.
- **Colour and granule texture** is the licensed part — do not scrape manufacturer swatch art. Get it from a photograph of a physical sample the user already possesses (every rep carries sample boards), or from a lab colour measured once off that sample. That photo is theirs; the render is then theirs too.

That third point is a feature, not a workaround: "photograph your sample board and we build the material" is a workflow no incumbent visualizer has, and it keeps the library clean of anyone else's IP.

## Sector-agnostic schema (`material_spec.json`)
One schema covers every clad surface with a repeating module — that is the modular-by-default requirement.

```json
{
  "id": "generic-architectural-laminate-v0",
  "family": "asphalt_shingle",          // clay_tile | concrete_tile | metal_panel | standing_seam | membrane | siding | shake
  "manufacturer": null,                  // null while generic
  "product_line": null,
  "colour_name": null,
  "geometry": {
    "module_w_m": 1.000, "module_h_m": 0.333,
    "exposure_m": 0.143,                 // course reveal — the number that must be true on screen
    "course_direction": "parallel_to_eave",
    "joint_offset_frac": 0.5,
    "butt_relief_mm": 4,                 // shadow line depth
    "cap_treatment": "hip_and_ridge_course"
  },
  "appearance": {
    "source": "measured_from_physical_sample | placeholder",
    "base_srgb": "#8A8C8B", "blend_srgb": ["#6F7270", "#9EA09D"],
    "roughness": 0.75, "sample_photo": null
  },
  "provenance": {
    "document": null, "url": null, "revision": null,
    "retrieved": null, "page_or_table": null,
    "quotable": false                    // true only when every geometry value has a citation
  },
  "notes": "placeholder dimensions until a data sheet is attached"
}
```

`quotable` follows the same rule as `roof.json`: false until the numbers are sourced. A generic placeholder renders fine and claims nothing.

## Gathering at scale — the intelligent version
1. **Bound the universe first.** The ARMA member list is the asphalt manufacturer universe; the top eight cover most of the North American market, and each has 3–8 product lines. That is 40–60 specs for near-complete shingle coverage — a small, finite scrape, not an open-ended one. Do the same per family (tile, metal, membrane) only when a sector wins.
2. **Reuse Property Hydra's muscle.** The same scrape-then-extract pipeline that produced the lead set works here: fetch data sheets, extract the geometry table, write one `material_spec.json` per SKU with provenance filled in. Different target, identical machinery.
3. **Two-pass extraction with an abstain gate.** Pass one pulls candidate values; pass two re-reads the source and must agree. Disagreement, or a value not found on the sheet, writes `null` and leaves `quotable: false` — never a plausible-looking number. Same discipline as the roof layer.
4. **Colour comes later and per-rep.** Ship the library with geometry only. Colour arrives when a rep photographs a sample board; one calibration card in the shot makes it repeatable.
5. **Ask the distributor what they actually sell.** Procover Exteriors is the channel into this industry, so the first ten specs should be the lines Procover stocks — a short list from them beats a broad scrape, and it is a reason to talk to them.

## What this unlocks beyond roofing
The same file drives siding, decking, standing-seam metal and commercial membrane, because the engine only ever asks: what is the module, what is the reveal, which way do the courses run. Sector stays open until one crowns itself.
