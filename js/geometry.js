// Builds the two-color (two-object) solid model for a panel tag:
//   - whiteGeometry: background cells + quiet-zone margin ring, confined to
//     a thin "front skin" slab at the pattern (+Z) face.
//   - blackGeometry: ink cells + border ring (also in the front skin), UNION
//     a solid black backing block that fills the rest of the thickness
//     behind the whole footprint. The backing's outer (z=0, back) face
//     carries the engraved tag id / panel label.
// The front-skin white and black pieces share exact boundaries (no gap, no
// overlap) so a slicer can assign each to a different filament and print
// them together as a checkerboard inlay on top of a solid black base.
//
// Coordinate/orientation notes (verified with a concrete asymmetric-cell
// test, not just intuition — getting this wrong produces a MIRRORED tag,
// which is not a valid rotation of any AprilTag codeword and will not
// decode):
//   - grid col increases -> world X increases (unflipped, matches image).
//   - grid row increases -> world Y decreases (flipped, because image row
//     grows downward while world +Y is "up" when viewed normally from +Z).
//   - The front (+Z) face is therefore the correct, undistorted tag.
//   - The back (z=0) face shows the same pattern mirrored, which is fine —
//     it's not meant to be scanned. Engraved back text is separately
//     mirrored so it reads correctly to someone looking at the back.

import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { buildTagGrid } from './apriltag.js';

// Text engraving deliberately avoids 3D CSG subtraction: three-bvh-csg's
// boundary re-triangulation leaves hundreds of sub-0.02mm non-manifold gaps
// along glyph curves (measured empirically — a plain checkerboard with no
// CSG at all is 0-gap, adding a text cut pushed it into the thousands).
// Instead the label is punched as real 2D holes into the backing's Shape
// before extrusion, with any glyph counters (the hole inside "o", "e", etc.)
// re-filled as small separate solids merged back in.

const evaluator = new Evaluator();
const CHAMFER_EPS = 0.05; // keeps the cutting brush from being exactly coplanar with an existing face

export const EDGE_OPTIONS = ['bottom', 'top', 'left', 'right'];

function makeBrush(geometry) {
  const brush = new Brush(geometry);
  brush.updateMatrixWorld();
  return brush;
}

function subtract(baseBrush, toolBrush) {
  const result = evaluator.evaluate(baseBrush, toolBrush, SUBTRACTION);
  result.updateMatrixWorld();
  return result;
}

// A convex solid from arbitrary vertices + triangle index triples; winding
// is auto-corrected per face (valid for any convex hull — a tetrahedron or
// triangular prism both qualify) so callers don't have to reason about
// orientation by hand.
function buildConvexSolidGeometry(vertices, faceIndices) {
  const centroid = new THREE.Vector3();
  vertices.forEach((v) => centroid.add(v));
  centroid.divideScalar(vertices.length);

  const positions = [];
  for (const [ia, ib, ic] of faceIndices) {
    let a = vertices[ia];
    let b = vertices[ib];
    let c = vertices[ic];
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac);
    const faceCenter = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
    const outward = faceCenter.clone().sub(centroid);
    if (normal.dot(outward) < 0) {
      const t = b;
      b = c;
      c = t;
    }
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // three-bvh-csg's Evaluator expects a uv attribute on every brush geometry
  // even when unused for texturing; the actual values don't matter here.
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2));
  geo.computeVertexNormals();
  return geo;
}

// A full-length bevel along one side of the back (z=0) face — an "edge
// chamfer" rather than a corner chamfer — built as a triangular prism swept
// along the chosen edge, slightly overhanging both ends so the cut cleanly
// reaches the plate's corners.
function buildEdgeChamferGeometry(edge, plateSize, chamferSize, totalThickness) {
  const half = plateSize / 2;
  const legPerp = Math.min(chamferSize, plateSize * 0.49);
  const legZ = Math.min(chamferSize, totalThickness) + CHAMFER_EPS;
  const sweepHalf = half + CHAMFER_EPS * 4;

  const sweepAxis = (edge === 'bottom' || edge === 'top') ? 'x' : 'y';
  const perpSign = (edge === 'bottom' || edge === 'left') ? -1 : 1;
  const perpEdge = perpSign * half;

  const a = [perpEdge, -CHAMFER_EPS];
  const b = [perpEdge - perpSign * legPerp, -CHAMFER_EPS];
  const c = [perpEdge, legZ];

  const mk = (sweep, pz) => (sweepAxis === 'x'
    ? new THREE.Vector3(sweep, pz[0], pz[1])
    : new THREE.Vector3(pz[0], sweep, pz[1]));

  const vertices = [
    mk(-sweepHalf, a), mk(-sweepHalf, b), mk(-sweepHalf, c),
    mk(sweepHalf, a), mk(sweepHalf, b), mk(sweepHalf, c),
  ];
  const faces = [
    [0, 1, 2], [3, 4, 5],
    [0, 1, 4], [0, 4, 3],
    [1, 2, 5], [1, 5, 4],
    [2, 0, 3], [2, 3, 5],
  ];
  return buildConvexSolidGeometry(vertices, faces);
}

// mergeGeometries() requires all inputs to consistently be indexed or all
// non-indexed. BoxGeometry is indexed; ExtrudeGeometry (used for the margin
// ring / backing) is not — so normalize everything to non-indexed first.
function nonIndexed(geometry) {
  return geometry.getIndex() ? geometry.toNonIndexed() : geometry;
}

function buildSquareShape(halfSize) {
  const shape = new THREE.Shape();
  shape.moveTo(-halfSize, -halfSize);
  shape.lineTo(halfSize, -halfSize);
  shape.lineTo(halfSize, halfSize);
  shape.lineTo(-halfSize, halfSize);
  shape.lineTo(-halfSize, -halfSize);
  return shape;
}

function buildRingShape(outerHalf, innerHalf) {
  const shape = buildSquareShape(outerHalf);
  const hole = new THREE.Path();
  hole.moveTo(-innerHalf, -innerHalf);
  hole.lineTo(-innerHalf, innerHalf);
  hole.lineTo(innerHalf, innerHalf);
  hole.lineTo(innerHalf, -innerHalf);
  hole.lineTo(-innerHalf, -innerHalf);
  shape.holes.push(hole);
  return shape;
}

function buildRing(outerHalf, innerHalf, depth) {
  return new THREE.ExtrudeGeometry(buildRingShape(outerHalf, innerHalf), {
    depth, bevelEnabled: false, curveSegments: 1,
  });
}

function extrudeSquare(halfSize, depth) {
  return new THREE.ExtrudeGeometry(buildSquareShape(halfSize), {
    depth, bevelEnabled: false, curveSegments: 1,
  });
}

// Measurement-only: find the font size that fits `text` within the given
// height/width box. The TextGeometry built here is never used for
// engraving, only disposed immediately after reading its bounding box.
function computeTextSize(font, text, targetHeight, maxWidth) {
  const probe = new TextGeometry(text, { font, size: 1, depth: 0.01, curveSegments: 4, bevelEnabled: false });
  probe.computeBoundingBox();
  const bw = Math.max(1e-6, probe.boundingBox.max.x - probe.boundingBox.min.x);
  const bh = Math.max(1e-6, probe.boundingBox.max.y - probe.boundingBox.min.y);
  probe.dispose();
  let size = targetHeight / bh;
  if (bw * size > maxWidth) size = maxWidth / bw;
  return size;
}

function transformPoints(points, mirror, cx, cy, tx, ty) {
  return points.map((p) => {
    let x = p.x - cx;
    const y = p.y - cy;
    if (mirror) x = -x;
    return new THREE.Vector2(x + tx, y + ty);
  });
}

// Returns the letter outlines (as point loops, ready to use as Shape holes)
// plus any glyph "counters" (the hole inside o/e/a/...) as separate point
// loops to be re-filled as small plug solids — see header note on why this
// avoids CSG entirely.
function buildTextCutout(font, text, size, mirror, tx, ty) {
  const shapes = font.generateShapes(text, size);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw = shapes.map((s) => {
    const pts = s.getPoints(6);
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const holePts = (s.holes || []).map((h) => h.getPoints(6));
    return { pts, holePts };
  });

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const holeContours = [];
  const plugContours = [];
  for (const { pts, holePts } of raw) {
    holeContours.push(transformPoints(pts, mirror, cx, cy, tx, ty));
    for (const hp of holePts) plugContours.push(transformPoints(hp, mirror, cx, cy, tx, ty));
  }
  return { holeContours, plugContours };
}

// params: { familyData, tagId, squareSize, totalThickness, frontSkinThickness,
//           chamferEdge, chamferSize, panelName, font }
export function generateModel(params) {
  const {
    familyData, tagId, squareSize, totalThickness, frontSkinThickness,
    chamferEdge, chamferSize, panelName, font,
  } = params;

  const grid = buildTagGrid(familyData, tagId);
  const N = grid.widthAtBorder;
  // squareSize is the OUTER edge-to-edge size of the whole panel (including
  // the white quiet-zone margin), not just the black-bordered tag core —
  // dividing by totalWidth (not N) makes the full plate fit that size.
  const cellSize = squareSize / grid.totalWidth;
  const plateSize = cellSize * grid.totalWidth;
  const half = plateSize / 2;
  const margin = ((grid.totalWidth - N) / 2) * cellSize;

  // Leave at least a thin sliver of backing so the skin always sits on a
  // real solid base, no matter what the user types in.
  const skin = Math.min(Math.max(frontSkinThickness, 0.05), totalThickness - 0.1);
  const backingThickness = totalThickness - skin;
  const skinZ0 = backingThickness; // front skin spans [skinZ0, totalThickness]

  // --- Front skin: two-color checkerboard (cells + margin ring), a thin
  // slab at the pattern face only ---
  const blackBoxGeoms = [];
  const whiteGeoms = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const cx = (col + 0.5 - N / 2) * cellSize;
      const cy = (N / 2 - 0.5 - row) * cellSize;
      const box = new THREE.BoxGeometry(cellSize, cellSize, skin);
      box.translate(cx, cy, skinZ0 + skin / 2);
      (grid.cells[row][col] === 0 ? blackBoxGeoms : whiteGeoms).push(box);
    }
  }
  const skinMarginGeo = buildRing(half, half - margin, skin);
  skinMarginGeo.translate(0, 0, skinZ0);
  whiteGeoms.push(skinMarginGeo);

  // --- Backing: solid black for the rest of the thickness, full footprint,
  // with the back label engraved into its outer (z=0) face ---
  let notice = null;
  const backingGeoms = [];
  let didEngrave = false;

  // The label sits on the backing's own full-footprint face (a separate
  // layer behind the front skin's pattern), so it isn't confined to the
  // margin ring — sized and centered against the whole panel instead.
  const textTargetHeight = plateSize * 0.12;
  const textMaxWidth = plateSize * 0.85;
  if (textTargetHeight < 1.5) {
    notice = 'Panel size is too small for the back label to fit legibly — increase panel size to engrave the tag ID / panel name.';
  } else if (font) {
    const label = panelName && panelName.trim().length
      ? `#${tagId}  ${panelName.trim()}`
      : `#${tagId}`;
    const engraveDepth = Math.min(0.5, backingThickness * 0.9);
    if (engraveDepth > 0.05) {
      const size = computeTextSize(font, label, textTargetHeight, textMaxWidth);
      const cutout = buildTextCutout(font, label, size, true, 0, 0);

      const backShape = buildSquareShape(half);
      for (const hc of cutout.holeContours) backShape.holes.push(new THREE.Path(hc));
      backingGeoms.push(new THREE.ExtrudeGeometry(backShape, { depth: engraveDepth, bevelEnabled: false, curveSegments: 1 }));

      for (const pc of cutout.plugContours) {
        backingGeoms.push(new THREE.ExtrudeGeometry(new THREE.Shape(pc), { depth: engraveDepth, bevelEnabled: false, curveSegments: 1 }));
      }

      const plainBack = extrudeSquare(half, backingThickness - engraveDepth);
      plainBack.translate(0, 0, engraveDepth);
      backingGeoms.push(plainBack);
      didEngrave = true;
    } else {
      notice = 'Total thickness leaves too little backing behind the front skin to engrave the back label — increase total thickness or reduce front skin thickness.';
    }
  }
  if (!didEngrave) {
    backingGeoms.push(extrudeSquare(half, backingThickness));
  }

  const whiteBaseGeometry = mergeGeometries(whiteGeoms.map(nonIndexed), false);
  const blackBaseGeometry = mergeGeometries([...blackBoxGeoms, ...backingGeoms].map(nonIndexed), false);

  let whiteBrush = makeBrush(whiteBaseGeometry);
  let blackBrush = makeBrush(blackBaseGeometry);

  if (chamferSize > 0) {
    const chamferGeo = buildEdgeChamferGeometry(chamferEdge, plateSize, chamferSize, totalThickness);
    const chamferBrush = makeBrush(chamferGeo);
    whiteBrush = subtract(whiteBrush, chamferBrush);
    blackBrush = subtract(blackBrush, chamferBrush);
  }

  // The edge chamfer is still a CSG cut (simple and convex — measured at
  // only a small number of sub-0.01mm boundary gaps, unlike text). Weld to
  // clean those up before export.
  const whiteGeometry = mergeVertices(whiteBrush.geometry, 1e-4);
  const blackGeometry = mergeVertices(blackBrush.geometry, 1e-4);
  whiteGeometry.computeVertexNormals();
  blackGeometry.computeVertexNormals();

  return {
    whiteGeometry,
    blackGeometry,
    plateSize,
    cellSize,
    margin,
    grid,
    notice,
  };
}

// The live preview shows the front (+Z) pattern face toward the viewer,
// which is the intuitive way to check a tag looks right on screen. But for
// printing, the thin two-color skin should touch the bed first (best
// surface finish, and matches "first layer is the pattern" from how this
// tool is meant to be sliced) — so exports get flipped 180° about the
// mid-thickness plane, swapping which face sits at z=0, before being
// written out. This is a proper rotation (not a mirror), so it can't turn
// a valid AprilTag pattern into an invalid one.
export function flipForPrint(geometry, totalThickness) {
  const g = geometry.clone();
  const m = new THREE.Matrix4()
    .makeTranslation(0, 0, totalThickness / 2)
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI))
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, -totalThickness / 2));
  g.applyMatrix4(m);
  return g;
}
