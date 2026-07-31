// Minimal hand-rolled 3MF writer (no dependency needed — three.js has no
// 3MF exporter). Produces a standard OPC/3MF package with one <object>/
// <item> pair per mesh passed in, which is exactly the multi-part-on-one-
// plate layout Bambu Studio (and other slicers) expect for assigning
// different filaments to parts of a single imported model.
//
// Objects can optionally carry a 1-based `extruder` slot number, in which
// case a Bambu/Orca-specific Metadata/model_settings.config is also
// embedded so the parts import pre-assigned to that extruder slot (no
// manual per-object filament assignment needed). This mechanism was
// confirmed against OrcaSlicer's actual 3MF reader/writer source
// (src/libslic3r/Format/bbs_3mf.cpp): a plain <config><object id="N">
// <metadata key="extruder" value="K"/></object></config> at that exact
// path, id matching the object id in 3D/3dmodel.model, K a 1-based slot —
// no [Content_Types].xml or _rels entry required for it (Bambu Studio's
// own writer doesn't add one either, confirmed in the same source). If
// this metadata is ever misread by a given slicer, the file still falls
// back to being a plain valid multi-object 3MF, so this is a safe addition.
//
// ZIP entries are stored uncompressed (method 0) — valid per the ZIP and
// 3MF/OPC specs, just slightly larger files; avoids needing a deflate impl.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.centralDirectory = [];
  }

  _push(bytes) {
    this.chunks.push(bytes);
    this.offset += bytes.length;
  }

  addFile(name, contentBytes) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(contentBytes);
    const localHeaderOffset = this.offset;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, contentBytes.length, true);
    local.setUint32(22, contentBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this._push(new Uint8Array(local.buffer));
    this._push(nameBytes);
    this._push(contentBytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, contentBytes.length, true);
    central.setUint32(24, contentBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, localHeaderOffset, true);
    this.centralDirectory.push({ header: new Uint8Array(central.buffer), name: nameBytes });
  }

  finalize() {
    const cdStart = this.offset;
    for (const entry of this.centralDirectory) {
      this._push(entry.header);
      this._push(entry.name);
    }
    const cdSize = this.offset - cdStart;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this.centralDirectory.length, true);
    end.setUint16(10, this.centralDirectory.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    end.setUint16(20, 0, true);
    this._push(new Uint8Array(end.buffer));

    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

function extractMesh(geometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const vertices = [];
  for (let i = 0; i < pos.count; i++) {
    vertices.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  }
  const triangles = [];
  if (index) {
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) {
      triangles.push([arr[i], arr[i + 1], arr[i + 2]]);
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      triangles.push([i, i + 1, i + 2]);
    }
  }
  return { vertices, triangles };
}

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 1e5) / 1e5).toString();
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function objectXml(id, name, mesh) {
  let vertices = '';
  for (const v of mesh.vertices) vertices += `<vertex x="${fmt(v[0])}" y="${fmt(v[1])}" z="${fmt(v[2])}"/>`;
  let triangles = '';
  for (const t of mesh.triangles) triangles += `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`;
  return `<object id="${id}" type="model" name="${escapeXml(name)}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`;
}

function modelSettingsConfigXml(objects) {
  let body = '';
  objects.forEach((obj, i) => {
    if (obj.extruder == null) return;
    body += `  <object id="${i + 1}">\n    <metadata key="extruder" value="${obj.extruder}"/>\n  </object>\n`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${body}</config>\n`;
}

// objects: [{ geometry, name, extruder? }] — extruder is an optional
// 1-based filament slot number (see header note on model_settings.config).
export function build3mfBytes({ objects }) {
  const resourcesXml = objects.map((obj, i) => objectXml(i + 1, obj.name, extractMesh(obj.geometry))).join('');
  const buildXml = objects.map((_, i) => `<item objectid="${i + 1}"/>`).join('');

  const modelXml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources>${resourcesXml}</resources>`
    + `<build>${buildXml}</build>`
    + '</model>';

  const contentTypesXml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    + '</Types>';

  const relsXml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    + '</Relationships>';

  const zip = new ZipWriter();
  const enc = new TextEncoder();
  zip.addFile('[Content_Types].xml', enc.encode(contentTypesXml));
  zip.addFile('_rels/.rels', enc.encode(relsXml));
  zip.addFile('3D/3dmodel.model', enc.encode(modelXml));
  if (objects.some((o) => o.extruder != null)) {
    zip.addFile('Metadata/model_settings.config', enc.encode(modelSettingsConfigXml(objects)));
  }
  return zip.finalize();
}

export function build3mfBlob(params) {
  return new Blob([build3mfBytes(params)], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
}
