# Gripper AprilTag Generator

A browser-based generator for 3D-printable, two-color AprilTags used to identify robot body panels (Pump Panel, Muffler Panel, Battery Panel, E-Stop Panel, and any custom tag/panel combination).

No build step, no backend — it's a static site that runs entirely client-side.

## What it does

- Generates real AprilTags (`tag36h11` by default, `tag25h9` / `tag16h5` also supported) from the official bit-pattern tables, verified pixel-for-pixel against [AprilRobotics/apriltag-imgs](https://github.com/AprilRobotics/apriltag-imgs) reference renders.
- Models each tag as a thin two-color pattern skin (first layer, printed against the bed) fused onto a solid backing that carries an engraved tag ID + panel label and a configurable edge chamfer.
- Exports 3MF files ready for Bambu Studio / Orca Slicer:
  - a single tag,
  - all 4 preset panels laid out on one plate,
  - or a "Bambu Plate" variant with each part pre-assigned to a filament slot (no manual per-object filament assignment needed).
- Every dimension (panel size, thickness, front-skin thickness, chamfer edge/size) is adjustable, with sensible defaults shown inline.

## Running locally

Needs to be served over HTTP (ES modules and JSON fetches don't work over `file://`):

```
python3 -m http.server 8080
```

then open `http://localhost:8080`.

## Project layout

```
index.html          UI shell
style.css
js/
  apriltag.js        AprilTag bit-grid rasterization
  apriltag-families.json   parsed family bit-tables (see data/)
  geometry.js        3D model construction (panel, chamfer, back engraving)
  export3mf.js        hand-rolled 3MF/zip writer, incl. Bambu extruder metadata
  main.js             UI wiring, live preview, downloads
  vendor/              three.js, three-bvh-csg, three-mesh-bvh, font (all vendored, no CDN)
data/                  official AprilTag family C sources + reference images used to
                       derive and verify apriltag-families.json (not used at runtime)
```

## Notes

- Only families with a pixel-verified bit layout are included (`tag36h11`, `tag25h9`, `tag16h5`). `tagStandard41h12` uses a different border convention that wasn't verified, so it's intentionally left out.
- Back-label text is a real cut (2D holes extruded, not a 3D boolean) to keep the exported mesh watertight — 3D CSG was tried first and left thousands of non-manifold gaps along glyph curves.
- The Bambu Plate export's per-object filament-slot assignment was implemented against [OrcaSlicer's actual 3MF reader/writer source](https://github.com/SoftFever/OrcaSlicer/blob/main/src/libslic3r/Format/bbs_3mf.cpp), not a secondhand writeup.
