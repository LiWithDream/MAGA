/**
 * Zero-dependency ISO/IEC 18004 QR Code (Byte mode, ECC Level L, Versions 1..10) -> Inline SVG.
 * Pure ESM; safe inside Electron renderer without network requests.
 */

// [version, totalCodewords, ecPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw, alignCoords]
const VERSION_SPECS = [
  null,
  [1, 26, 7, 1, 19, 0, 0, []],
  [2, 44, 10, 1, 34, 0, 0, [6, 18]],
  [3, 70, 15, 1, 55, 0, 0, [6, 22]],
  [4, 100, 20, 1, 80, 0, 0, [6, 26]],
  [5, 134, 26, 1, 108, 0, 0, [6, 30]],
  [6, 172, 18, 2, 68, 0, 0, [6, 34]],
  [7, 196, 20, 2, 78, 0, 0, [6, 22, 38]],
  [8, 242, 24, 2, 97, 0, 0, [6, 24, 42]],
  [9, 292, 30, 2, 116, 0, 0, [6, 26, 46]],
  [10, 346, 18, 2, 68, 2, 69, [6, 28, 50]],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsDivisor(ecCount) {
  const gen = new Uint8Array(ecCount);
  gen[ecCount - 1] = 1;
  let root = 1;
  for (let i = 0; i < ecCount; i++) {
    for (let j = 0; j < ecCount; j++) {
      gen[j] = gfMul(gen[j], root);
      if (j + 1 < ecCount) gen[j] ^= gen[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return gen;
}

function computeRsRemainder(dataBytes, gen) {
  const res = new Uint8Array(gen.length);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ res[0];
    res.copyWithin(0, 1);
    res[res.length - 1] = 0;
    for (let j = 0; j < gen.length; j++) {
      res[j] ^= gfMul(gen[j], factor);
    }
  }
  return res;
}

function encodeByteDataCodewords(bytes, spec) {
  const [version, , , g1Cnt, g1Len, g2Cnt, g2Len] = spec;
  const totalDataCw = g1Cnt * g1Len + g2Cnt * g2Len;
  const charCountBits = version >= 10 ? 16 : 8;
  const bitCap = totalDataCw * 8;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  pushBits(0b0100, 4);
  pushBits(bytes.length, charCountBits);
  for (const b of bytes) pushBits(b, 8);
  const term = Math.min(4, bitCap - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | bits[i + b];
    cw.push(val);
  }
  let padIdx = 0;
  while (cw.length < totalDataCw) {
    cw.push(padIdx % 2 === 0 ? 0xec : 0x11);
    padIdx += 1;
  }
  return cw;
}

function interleaveBlocks(dataCw, spec) {
  const [, , ecPerBlock, g1Cnt, g1Len, g2Cnt, g2Len] = spec;
  const gen = buildRsDivisor(ecPerBlock);
  const blocks = [];
  const eccs = [];
  let offset = 0;
  for (let i = 0; i < g1Cnt; i++) {
    const blk = dataCw.slice(offset, offset + g1Len);
    offset += g1Len;
    blocks.push(blk);
    eccs.push(computeRsRemainder(blk, gen));
  }
  for (let i = 0; i < g2Cnt; i++) {
    const blk = dataCw.slice(offset, offset + g2Len);
    offset += g2Len;
    blocks.push(blk);
    eccs.push(computeRsRemainder(blk, gen));
  }
  const maxDataLen = Math.max(g1Len, g2Len);
  const out = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of blocks) {
      if (i < blk.length) out.push(blk[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of eccs) out.push(ec[i]);
  }
  return out;
}

function drawFinder(setFn, top, left, size) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = top + dr;
      const c = left + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      const dark = dist !== 2 && dist !== 4;
      setFn(r, c, dark);
    }
  }
}

function drawAlignment(setFn, centerR, centerC) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFn(centerR + dr, centerC + dc, dist !== 1);
    }
  }
}

function computeFormatBits(maskIdx) {
  const data = (0b01 << 3) | maskIdx; // ECC Level L = 01
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function drawFormatBits(setFn, size, maskIdx) {
  const bits = computeFormatBits(maskIdx);
  for (let i = 0; i <= 5; i++) setFn(i, 8, Boolean((bits >>> i) & 1));
  setFn(7, 8, Boolean((bits >>> 6) & 1));
  setFn(8, 8, Boolean((bits >>> 7) & 1));
  setFn(8, 7, Boolean((bits >>> 8) & 1));
  for (let i = 9; i < 15; i++) setFn(8, 14 - i, Boolean((bits >>> i) & 1));

  for (let i = 0; i < 8; i++) setFn(8, size - 1 - i, Boolean((bits >>> i) & 1));
  for (let i = 8; i < 15; i++) setFn(size - 15 + i, 8, Boolean((bits >>> i) & 1));
  setFn(size - 8, 8, true);
}

function drawVersionBits(setFn, size, version) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = ((version << 12) | rem) & 0x3ffff;
  for (let i = 0; i < 18; i++) {
    const bit = Boolean((bits >>> i) & 1);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFn(b, a, bit);
    setFn(a, b, bit);
  }
}

function maskBit(maskIdx, r, c) {
  switch (maskIdx) {
    case 0: return ((r + c) & 1) === 0;
    case 1: return (r & 1) === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return ((Math.floor(r / 2) + Math.floor(c / 3)) & 1) === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return ((((r * c) % 2) + ((r * c) % 3)) & 1) === 0;
    case 7: return ((((r + c) % 2) + ((r * c) % 3)) & 1) === 0;
    default: return false;
  }
}

function countLinePenalty(line) {
  let score = 0;
  let runColor = line[0];
  let runLen = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === runColor) {
      runLen += 1;
    } else {
      if (runLen >= 5) score += 3 + (runLen - 5);
      runColor = line[i];
      runLen = 1;
    }
  }
  if (runLen >= 5) score += 3 + (runLen - 5);
  for (let i = 0; i <= line.length - 11; i++) {
    const matchFwd =
      line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] &&
      line[i + 6] && !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
    const matchRev =
      !line[i] && !line[i + 1] && !line[i + 2] && !line[i + 3] && line[i + 4] && !line[i + 5] &&
      line[i + 6] && line[i + 7] && line[i + 8] && !line[i + 9] && line[i + 10];
    if (matchFwd || matchRev) score += 40;
  }
  return score;
}

function computePenalty(modules) {
  const size = modules.length;
  let score = 0;
  let darkCount = 0;
  const colBuf = new Array(size);
  for (let r = 0; r < size; r++) {
    score += countLinePenalty(modules[r]);
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) darkCount += 1;
      if (r + 1 < size && c + 1 < size) {
        const v = modules[r][c];
        if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) {
          score += 3;
        }
      }
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) colBuf[r] = modules[r][c];
    score += countLinePenalty(colBuf);
  }
  const k = Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size));
  return score + k * 10;
}

export function encodeQrMatrix(text) {
  const str = String(text ?? '');
  if (!str) throw new Error('qr_empty_input');
  const bytes = new TextEncoder().encode(str);
  if (bytes.length > 271) {
    throw new Error(`qr_input_too_long:${bytes.length}`);
  }

  let spec = null;
  for (let v = 1; v < VERSION_SPECS.length; v++) {
    const s = VERSION_SPECS[v];
    const totalDataBits = (s[3] * s[4] + s[5] * s[6]) * 8;
    const hdrBits = 4 + (v >= 10 ? 16 : 8);
    if (hdrBits + bytes.length * 8 <= totalDataBits) {
      spec = s;
      break;
    }
  }
  if (!spec) throw new Error('qr_no_matching_version');

  const version = spec[0];
  const size = 4 * version + 17;
  const alignCoords = spec[7];
  const isFn = Array.from({ length: size }, () => new Uint8Array(size));
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (r, c, dark) => {
    modules[r][c] = Boolean(dark);
    isFn[r][c] = 1;
  };

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  drawFinder(setFn, 0, 0, size);
  drawFinder(setFn, 0, size - 7, size);
  drawFinder(setFn, size - 7, 0, size);

  for (let i = 0; i < alignCoords.length; i++) {
    for (let j = 0; j < alignCoords.length; j++) {
      const r = alignCoords[i];
      const c = alignCoords[j];
      const inCorner = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8);
      if (!inCorner) drawAlignment(setFn, r, c);
    }
  }

  drawFormatBits(setFn, size, 0);
  drawVersionBits(setFn, size, version);

  const dataCw = encodeByteDataCodewords(bytes, spec);
  const allCw = interleaveBlocks(dataCw, spec);
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFn[r][c] && bitIdx < allCw.length * 8) {
          modules[r][c] = Boolean((allCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1);
          bitIdx += 1;
        }
      }
    }
  }

  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFn[r][c] && maskBit(mask, r, c)) modules[r][c] = !modules[r][c];
      }
    }
    drawFormatBits(setFn, size, mask);
    const sc = computePenalty(modules);
    if (sc < bestScore) {
      bestScore = sc;
      bestMask = mask;
    }
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFn[r][c] && maskBit(mask, r, c)) modules[r][c] = !modules[r][c];
      }
    }
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFn[r][c] && maskBit(bestMask, r, c)) modules[r][c] = !modules[r][c];
    }
  }
  drawFormatBits(setFn, size, bestMask);

  return { version, size, modules };
}

export function renderQrSvg(
  text,
  { sizePx = 188, quietZone = 4, dark = '#111111', light = '#FFFFFF' } = {}
) {
  const { size, modules } = encodeQrMatrix(text);
  const border = Math.max(1, Math.min(8, Math.floor(quietZone)));
  const total = size + border * 2;
  const px = Math.max(96, Math.min(480, Math.floor(sizePx)));
  const parts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) parts.push(`M${c + border},${r + border}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${px}" height="${px}" role="img" aria-label="QR Code" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/></svg>`
  );
}
