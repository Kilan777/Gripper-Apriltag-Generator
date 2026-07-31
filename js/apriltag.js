// AprilTag bit-pattern rasterization.
//
// Family data (js/apriltag-families.json) was extracted from the official
// AprilRobotics/apriltag C sources (tag36h11.c, tag25h9.c, tag16h5.c) and the
// bit ordering/inversion convention was verified pixel-for-pixel against the
// reference renders in AprilRobotics/apriltag-imgs before being trusted here.
// Convention: grid value 0 = black (ink), 1 = white (background). Bit k of a
// code maps to grid[bitY[k]][bitX[k]], read MSB-first, with no inversion.

let familiesPromise = null;

export function loadFamilies() {
  if (!familiesPromise) {
    familiesPromise = fetch(new URL('./apriltag-families.json', import.meta.url))
      .then((r) => r.json());
  }
  return familiesPromise;
}

// Returns an { widthAtBorder, totalWidth, cells } grid for the given family + tag id.
// cells is a 2D array [row][col], 0-indexed, row/col 0..widthAtBorder-1 (border cells included).
export function buildTagGrid(familyData, tagId) {
  const { nbits, widthAtBorder, bitX, bitY, codes } = familyData;
  if (!Number.isInteger(tagId) || tagId < 0 || tagId >= codes.length) {
    throw new Error(`Tag id ${tagId} is out of range for ${familyData.name} (0-${codes.length - 1})`);
  }

  // Codes are up to 36 bits, which exceeds JS's 32-bit bitwise-operator range,
  // so bit extraction is done via BigInt rather than >> / &.
  const code = BigInt(codes[tagId]);
  const cells = Array.from({ length: widthAtBorder }, () => new Array(widthAtBorder).fill(0));
  for (let k = 0; k < nbits; k++) {
    const bit = (code >> BigInt(nbits - 1 - k)) & 1n;
    cells[bitY[k]][bitX[k]] = Number(bit);
  }

  return { widthAtBorder, totalWidth: familyData.totalWidth, cells };
}
