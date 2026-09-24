'use strict';
// 纯 Node 生成托盘图标 PNG（SDF 渲染 + 4x4 超采样抗锯齿），无第三方依赖。
// 图案：圆角方块（蓝紫渐变）+ 白色对话气泡 + 气泡内三条“提示词文本线”。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- SDF 图元 ----------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
}
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}
// 点在三角形内（重心法）
function inTri(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

// 在 0..32 设计坐标系中渲染，按 size 缩放
function renderIcon(size) {
  const S = 4; // 超采样
  const buf = Buffer.alloc(size * size * 4);
  const scale = size / 32;
  const cTop = hex('#5b8cff'), cBot = hex('#8f63ff');
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = ((x + (sx + 0.5) / S) / scale);
          const py = ((y + (sy + 0.5) / S) / scale);
          let cr = 0, cg = 0, cb = 0, ca = 0;

          // 1) 背景圆角方块（垂直渐变）
          const dBG = sdRoundRect(px, py, 16, 16, 15, 15, 8.5);
          const covBG = Math.max(0, Math.min(1, 0.5 - dBG));
          if (covBG > 0) {
            const t = Math.max(0, Math.min(1, py / 32));
            cr = lerp(cTop[0], cBot[0], t); cg = lerp(cTop[1], cBot[1], t); cb = lerp(cTop[2], cBot[2], t);
            ca = covBG;
          }

          // 2) 白色气泡（圆角矩形 + 左下尾巴）
          const dBub = sdRoundRect(px, py, 16, 14.2, 9.6, 6.6, 3.6);
          const tail = inTri(px, py, [8.4, 18.4], [13.6, 19.6], [8.9, 24.6]) ? -1 : 1;
          const dBub2 = Math.min(dBub, tail);
          const covW = Math.max(0, Math.min(1, 0.5 - dBub2));
          if (covW > 0) { cr = lerp(cr, 255, covW); cg = lerp(cg, 255, covW); cb = lerp(cb, 255, covW); ca = Math.max(ca, covW); }

          // 3) 气泡内三条文本线（渐变主色，叠在白色气泡之上）
          {
            const lines = [[9.8, 19.6, 11.1], [9.8, 22.2, 14.3], [9.8, 16.6, 17.5]]; // x0,x1,cy
            for (const [x0, x1, cy] of lines) {
              const d = sdRoundRect(px, py, (x0 + x1) / 2, cy, (x1 - x0) / 2, 0.78, 0.78);
              const cov = Math.max(0, Math.min(1, 0.5 - d));
              if (cov > 0) {
                const t = cy / 32;
                cr = lerp(cr, lerp(cTop[0], cBot[0], t), cov);
                cg = lerp(cg, lerp(cTop[1], cBot[1], t), cov);
                cb = lerp(cb, lerp(cTop[2], cBot[2], t), cov);
                ca = Math.max(ca, cov);
              }
            }
          }

          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['tray.png', 32], ['icon.png', 256]]) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(size, renderIcon(size)));
  console.log('generated', name, size + 'x' + size);
}
