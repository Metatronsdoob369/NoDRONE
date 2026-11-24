# Nearmap public web app: 3D, dates, and AI overlays

Captured 2026-11-21 from public, unauthenticated pages. No login was submitted. Raster images and mesh bytes were not stored. Raw scripts stay in gitignored `workspace/nearmap/bundles/`. This report cites committed windows in `examples/nearmap-analysis/capture/code-evidence.json` and the network inventory in `examples/nearmap-analysis/capture/network.json`.

The marketing site (`https://www.nearmap.com/`) is a public Next.js shell. It does not contain the map engine. The engine is the MapBrowser script set served from `https://apps.nearmap.com/maps/` (HTTP 200) and the sibling roof-assessment shell. After those scripts load, the browser is sent to `https://admin.nearmap.com/api/identityserver/v1/login`. The live viewer, tile bodies, and mesh bodies were not exercised. Where a claim needs an authenticated response, it is marked unknown / gated.

## Part A. 3D view and camera fly-through

### What we observed

MapBrowser loads two viewers.

- 2D is OpenLayers. `openLayersViewer` returns the OpenLayers map (`code-evidence.json` `A-openlayers`, `libs-f810ea1fa767dbb051ab.js` line 1, URL `https://apps.nearmap.com/maps/libs-f810ea1fa767dbb051ab.js`).
- 3D is Cesium. The page loads `https://apps.nearmap.com/maps/cesium-f4e1cf94d34d9122d042.js` (HTTP 200, `network.json`). `cesiumViewer` returns `viewer` and `viewer.camera` (`A-viewers`, same libs file, line 20). The Cesium file contains the `CESIUM_3D_TILE` pass (`A-cesium-3dtiles-symbol`, line 2).

The 3D base layer is a first-class mode. Its attributes are `key:"nearmap-3d"`, `label:"3D"` (`A-baselayer-3d`, libs line 10). The same module builds the mesh URL from the survey resource:

`https://{apiHost}/meshes/v1/meshes/{cesiumRoot}`

or `https://{apiHost}{rootPath}` when the resource already has a path (`A-mesh-url`, libs line 10). `{apiHost}` is `api.nearmap.com` in production (`h=()=>p()? "api-qa.nearmapdev.com" : "api.nearmap.com"` in that file). Each `resources["3d"]` entry is mounted with `surveyUrl` and a bearer token.

That URL is handed to a Cesium primitive loader: `fromUrl` with `foveatedScreenSpaceError`, `cacheBytes` of 1073741824, `maximumCacheOverflowBytes` of the same size, then `scene.primitives.add` (`A-tileset-fromUrl`, libs line 10). Those option names are the Cesium 3D Tileset options. The binding is minified (`p.A`), so the class name is inferred, not a literal `Cesium3DTileset` string in the app bundle. Level of detail is Cesium screen-space error: the same effect writes `maximumScreenSpaceError` from `config.tilesets`.

Terrain under the mesh is separate from Nearmap's mesh. A config switch `viewer.dtm` selects either MapTiler quantized-mesh (`https://maps.tilehosting.com/data/terrain-quantized-mesh/?key=…`) or Cesium ion world terrain (`fromIonAssetId(1)` with a height offset). The shipped bundle contains a MapTiler key literal and a Cesium ion token literal. Those values are not copied here. Terrain streaming format is quantized-mesh. Nearmap's own mesh is the `/meshes/v1/meshes/` resource, not the terrain URL.

Imagery draped in the 2D viewer uses a tile pyramid, which the 3D mode can also show as an imagery layer (`urlTemplate` imagery provider next to the mesh mount). The 2D template is:

`https://api.nearmap.com/tiles/v3/{type}/{z}/{x}/{y}.img?tertiary={none|satellite}&until={YYYY-MM-DD}`

or `&surveyid={id}` when the date argument is not an 8-digit day (`A-imagery-template`, libs line 4). The tile coordinate is an OpenLayers `[z, x, y]` tuple: the first element is rounded and passed as the zoom segment, and a later parse of `/v3/{type}/{z}/{x}/{y}.img` treats that segment as zoom, including client overzoom above native zoom 20 (`A-imagery-zxy`, libs line 10). `{type}` is the basemap key (`nearmap-vertical` and the panorama directions). This is the imagery pyramid, not the 3D mesh.

Camera motion that shipped in the bundle is Cesium `camera.flyTo`. One reset flies to the current longitude/latitude at the altitude for zoom 18, heading 0, pitch -90 degrees (nadir) (`A-flyto`, libs line 20). A second call flies to a bounds destination with `duration: 0.5` and the same nadir pitch (roof-assessment app and libs, same pattern). No recorded spline or tour file was in the captured scripts. A scripted multi-stop fly-through, if it exists only at runtime behind login, was not observed.

No mesh or terrain response was stored. `network.json` has no request to `api.nearmap.com` or `tiles/v3` or `/meshes/`. The session never held a bearer token.

### Confidence

- Confirmed: two viewers (OpenLayers and Cesium), the `nearmap-3d` base layer, the `/meshes/v1/meshes/{id}` URL shape, quantized-mesh terrain as a separate provider, imagery `/tiles/v3/{type}/{z}/{x}/{y}.img` with `until` or `surveyid`, nadir `flyTo`.
- Inferred: the `fromUrl` callee is Cesium's 3D Tileset, so the mesh payload is 3D Tiles (tileset.json plus subtree content). The Cesium library on the page implements b3dm, i3dm, and quantized-mesh; the app code does not spell those extensions at the call site.
- Unknown / gated: the live mesh document, its geometric error tree, and any fly-through that is not one of the two `flyTo` calls. The viewer UI itself is behind the identity login.

### Nodrone / Flyover equivalent

Use CesiumJS for the 3D view. Serve the property mesh as 3D Tiles and load it with `Cesium3DTileset.fromUrl`. Drive level of detail with `maximumScreenSpaceError`. Put a quantized-mesh terrain underneath only if a ground surface is needed; that terrain is not the building mesh. Drive the camera with `Camera.flyTo` (destination, heading, pitch, duration) for the nadir and bounds moves. Keep the 2D ortho path on OpenLayers or MapLibre with an XYZ tile URL that takes a survey day, matching the `/tiles/v3` shape, and share the survey id with the 3D mesh URL. Do not embed a third-party terrain token in the client.

## Part B. Imagery dates and before/after

### What we observed

Surveys are listed from Coverage API v2 on `api.nearmap.com` (`B-coverage-root`, libs line 10):

- `https://api.nearmap.com/coverage/v2/point/{lng},{lat}`
- `https://api.nearmap.com/coverage/v2/surveys/{id}`
- `https://api.nearmap.com/coverage/v2/poly/{…}`

The maps app also fetches `https://{apiHost}/coverage/v2/surveys/{id}?fields=resources,resources:boundary` with `Authorization: Bearer` (`maps app` line 13, same pattern). A survey row keeps `captureDate`, `id`, `perspective`, and `surveyId` (`B-capture-date`, libs line 1). When the 3D flag is on, the same client asks for surveys with `resources=3d` (`B-fetch-3d-surveys`, libs line 10). The date string is what the tile template turns into `until=YYYY-MM-DD` or `surveyid=` (`B-until-or-surveyid`, libs line 1; template in `A-imagery-template`).

Before/after is a splitter, not a second map library. State defaults are `splitterIsActive: false`, `mirrorViewIsActive: false`, `splitterPosition: 50` (`B-splitter-state`, libs line 1). Turning the splitter on forces the position to 50 and turns the mirror view off. The mirror view is the other compare mode (a second survey), and the two modes are exclusive. The visible survey date and the splitter survey date are separate selectors. The OpenLayers path clips the canvas to one side of the split (`context.clip` in the maps app; the AI layer calls `applyMask` when `isSplitterActive` is set, `C-mvt-layer`). The URL hash carries `survey`, `splitterSurvey`, and `mirrorSurvey` (`maps app` line 1, needle `splitterSurvey` in the saved bundle).

The timeline therefore does two jobs: it chooses which survey id or day is written into the tile query, and the splitter holds a second survey so each side of the clip requests its own day.

No coverage response and no dated tile body was downloaded.

### Confidence

- Confirmed: Coverage API v2 URL shapes, `captureDate` on survey records, `until` versus `surveyid` on the tile URL, splitter position and the mutual exclusion with mirror view, canvas clip as the swipe.
- Inferred: the hash fields are the shareable compare state. The clip is the whole compare render; a Cesium `czm_splitPosition` path exists inside the Cesium library file but the app compare state lives on the OpenLayers duck.
- Unknown / gated: the live survey list for a place, and how the timeline widget orders disaster versus regular surveys beyond the priority constants `prioritize-selected` and `prioritize-displayed` in the same libs file.

### Nodrone / Flyover equivalent

Keep one survey catalog. A small coverage service, or a STAC collection, returns id, capture day, and which resources exist (ortho, oblique, mesh, vectors). The timeline writes the chosen id into the tile URL (`until` or `surveyid`). The swipe is two tile layers plus a canvas clip at a percentage, which is what OpenLayers is doing here; MapLibre's clip or a single canvas mask is the same idea. Store the two survey ids in the route so a link reopens the compare. Do not invent a third renderer for the swipe.

## Part C. AI overlays (roofs, pools)

### What we observed

AI overlays are vector tiles, not a raster and not a one-shot GeoJSON file. The URL builder is (`C-mvt-url`, libs line 4):

`https://{apiHost}/ai/viewer/v1/surveys/{surveyId}/vectormap/{z}/{x}/{y}.mvt?classes={ids}&prerelease={flag}`

The layer id is `nearmap-ai-vectors-mvt` (`C-mvt-layer`, libs line 4). Tile size is 256. The style inputs on that component are `baseColor`, `fillOpacity`, `strokeThickness`, `confidence`, `fidelity`, and `brightness`. When the splitter is active the layer applies the same pre-render mask as the imagery. The default data-layer list names an `ai-vectors-layer-group` (`C-layer-group`, libs line 4).

Hit testing uses the OpenLayers map methods `forEachFeatureAtPixel` (with `hitTolerance` and a layer filter) and `getFeaturesAtPixel`. The feature properties read at the click are `id`, `layer`, and `classId` (`C-hit-test`, libs line 4). A click can open a dialog with `reportedFeatureIds`, `reportedClassIds`, `surveyId`, and a location.

The class catalog shipped in the maps app includes swimming pools. Class id 1001 is described as "Swimming Pool", and a group id `pool` is "Swimming Pools" (`C-pool-class`, `app-af97ece3144311838b80.js` line 13, URL `https://apps.nearmap.com/maps/app-af97ece3144311838b80.js`). The same catalog lists roof materials and roof objects (clay tile, metal-adjacent membrane types, roof debris, and similar) as feature classes with help-center links. Those strings are the layer taxonomy. They are not a model definition.

GeoJSON in this bundle is the user import and export path (file extensions `.json,.geojson,.shp,.zip,.kml,.kmz` in the maps app), not the AI overlay format.

No MVT body was downloaded. The classes query would require the bearer token.

### Confidence

- Confirmed: MVT URL shape, survey id in the path, class-id filter, OpenLayers vector-tile layer name, fill/stroke style fields, pixel hit tests reading feature id and class id, pool class 1001 and a roof-oriented class list in the same catalog.
- Inferred: roofs and pools are two class filters on that one MVT layer, not separate services. The style function paints from those fields; the exact color ramp was not executed.
- Unknown / gated: whether a given class is actually present for a survey, the MVT schema beyond `id` / `layer` / `classId`, and any raster "prediction" overlay. A `PREDICTION_RASTERS` resource name and a `predictionClass` tile prop exist beside the vector path (`C-mvt-layer` neighborhood and the data-layer types). That second overlay was not fetched, so its format is unknown.

### Nodrone / Flyover equivalent

Serve roofs and pools as Mapbox Vector Tiles keyed by survey id, with the class list in the query or as a layer filter. Render them in OpenLayers `VectorTile` or MapLibre `fill` and `line` layers. Toggle a class by changing the filter, not by adding a new map. Hit-test with `forEachFeatureAtPixel` or `queryRenderedFeatures`, and keep feature id plus class id on the properties. Style with fill opacity, stroke width, and a confidence field if the tiles carry one. Keep GeoJSON for imports and exports only.

## Cross-cutting

One shell feeds all three features. MapBrowser's OpenLayers map is the 2D engine for imagery, the date swipe, and the AI vectors. Cesium is the 3D engine for the mesh resource on the same survey. Coverage API v2 is the index: a survey id selects the ortho tile (`until` or `surveyid`), the MVT path (`/surveys/{id}/vectormap/`), and the 3D resource list (`resources=3d` then `/meshes/v1/meshes/{cesiumRoot}`). Splitter state is shared, so the compare mask clips imagery and vectors together.

The single biggest unlock for Nodrone / Flyover is that survey catalog. Stand up the coverage record first (id, day, which products exist). Point the ortho tiles, the vector tiles, and the 3D Tiles URL at that id. Add Cesium only for the mesh, and add the canvas splitter only for two days of the same tile set. Building three separate maps would repeat the index Nearmap already shares.

The marketing pages and the help center do not add a second engine. They link to `https://apps.nearmap.com/maps` and `https://apps.nearmap.com/roof-assessment`, both of which end at the login document (`examples/nearmap-analysis/capture/pages.json`).

## Ghidra

no native target; Ghidra n/a

`inspect-artifact` on the captured script directory refused the directory: it accepts a file or an Apple bundle, and it pointed this tree at `analyze-javascript-application`. The capture is HTML, CSS, and JavaScript. Nothing in it is a native executable or library.

## REA route

| Step | Result |
| --- | --- |
| `inspect-artifact` on `workspace/nearmap/bundles` with `--detail summary` and `--evidence_output` set to a file | `target_unavailable`. The directory is not a native or Apple bundle. Summary: `workspace/nearmap/inspect-artifact.summary.json`. |
| `analyze-javascript-application --artifact-format directory` on that same directory, `--source-paths-json` limited to the MapBrowser app and libs bundles | Exit 0. View evidence `ev_3c82a3d24d182ad0d2350b568bd2e9f0a33176488965951dd7e45f98cc2b5ae0`. Parent evidence `ev_a92de675c6684455f2491af03c47f934ab54860f85539ad9605c30d7e38f9474`. Digest and counts: `examples/nearmap-analysis/rea-summary.json`. Full evidence: `workspace/nearmap/analyze-javascript-application.evidence.json`. |
| `recover-javascript-sources` | Not recovered. The only declared source map was `https://apps.nearmap.com/sp.js` (`SourceMap` comment), and that URL returned 404 HTML (`sourcemaps.json`). Wakaru is Linux x64 only. On this Mac the command returned `capability_unavailable` (`workspace/nearmap/recover-javascript-sources.json`). Analysis of the minified bundles is inferred where a name was shortened by the bundler. |

Source selection covered the two MapBrowser files that contain the viewers, the tile template, the mesh URL, and the MVT layer (`app-af97ece3144311838b80.js` and `libs-f810ea1fa767dbb051ab.js`). REA parsed both (782,058 AST nodes, 0 parse failures) and recorded 0 native addon bindings. Semantic coverage is partial: the graph hit the default ceilings (100,000 nodes and 100,000 unknowns), so the feature claims above cite the committed windows in `code-evidence.json`. The other 191 inventoried files, including the Cesium library and the marketing chunks, stayed outside semantic analysis. The roof-assessment bundle repeats the same URL shapes and was not a third selected source.

## Capture limits

- Pages and gates: `examples/nearmap-analysis/capture/pages.json` and `inventory.json`.
- Script URL inventory: `bundles.json`. Bytes are not in git.
- Endpoint shapes: `network.json`. Imagery and font responses were aborted. Secret query values were redacted.
- Login `signin` query values were redacted in `pages.json`.
- A MapTiler key and a Cesium ion token are present as literals in the shipped libs bundle. They are not in this report or in the committed windows.
