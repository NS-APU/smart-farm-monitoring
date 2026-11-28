/*
 * アプリのアイコン（Issue #326）を生成する。絵柄は仮のもの（アプリの主色の角丸の四角と、白いハウスのシルエット）。
 * ロゴ・ブランドの画像が決まったら、このスクリプトを使わず、`src/frontend/public/` の同名のファイルを差し替える
 * （ファイル名と大きさは、tests/unit/frontend/app-icons.test.ts が確認する）。
 *
 * 画像ライブラリに依存しないよう、図形（角丸の四角・多角形・円）を数式で塗り、PNG・ICO を Node 標準の zlib で書き出す。
 * 使い方: `node scripts/generate-app-icons.ts`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUTPUT_DIR = resolve(import.meta.dirname, '../src/frontend/public');
const PRIMARY: Rgb = [0x1d, 0x5c, 0x40]; // src/frontend/styles/app.css の --color-primary
const WHITE: Rgb = [0xff, 0xff, 0xff];
/** 1 画素あたりの、縦横の標本の数（縁をなめらかにする）。 */
const SAMPLES = 4;

/** 図形は、512×512 の座標で定義する（icon.svg と同じ）。 */
const CANVAS = 512;
const CORNER_RADIUS = 112;
type Point = readonly [number, number];
type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];
interface RenderOptions {
  readonly rounded: boolean;
  readonly background: boolean;
}

const HOUSE: readonly Point[] = [
  [256, 104],
  [424, 252],
  [384, 252],
  [384, 408],
  [128, 408],
  [128, 252],
  [88, 252],
];
const DOT = { x: 256, y: 296, r: 44 };

function insideRoundedRect(x: number, y: number): boolean {
  const dx = Math.max(CORNER_RADIUS - x, x - (CANVAS - CORNER_RADIUS), 0);
  const dy = Math.max(CORNER_RADIUS - y, y - (CANVAS - CORNER_RADIUS), 0);
  return dx * dx + dy * dy <= CORNER_RADIUS * CORNER_RADIUS;
}

/** 点が多角形の内側にあるか（光線を右に伸ばして、辺と交わる回数の偶奇で判定する）。 */
function insidePolygon(x: number, y: number, points: readonly Point[]): boolean {
  let inside = false;
  points.forEach(([xi, yi], i) => {
    const [xj, yj] = points[(i + points.length - 1) % points.length] ?? [xi, yi];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  });
  return inside;
}

function insideDot(x: number, y: number): boolean {
  return (x - DOT.x) ** 2 + (y - DOT.y) ** 2 <= DOT.r ** 2;
}

/**
 * 1 つの点の色（RGBA、0〜1 の割合）を返す。
 * - rounded: 背景を角丸にする（false は、全面を塗る。iOS が、自分で角を丸めるため）
 * - background: false は、背景を透明にして、ハウスだけを白で描く（通知のバッジ。ハウスの中の円は、抜く）
 */
function colorAt(x: number, y: number, { rounded, background }: RenderOptions): Rgba {
  const inHouse = insidePolygon(x, y, HOUSE) && !insideDot(x, y);
  if (!background) {
    return inHouse ? [...WHITE, 1] : [0, 0, 0, 0];
  }
  if (rounded && !insideRoundedRect(x, y)) {
    return [0, 0, 0, 0];
  }
  return [...(inHouse ? WHITE : PRIMARY), 1];
}

/** 指定の大きさの画像を描く。標本の色を、透明度で重み付けして平均する。 */
function render(size: number, options: RenderOptions): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = CANVAS / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          const [cr, cg, cb, ca] = colorAt(x, y, options);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const offset = (py * size + px) * 4;
      const count = SAMPLES * SAMPLES;
      pixels[offset] = a === 0 ? 0 : Math.round(r / a);
      pixels[offset + 1] = a === 0 ? 0 : Math.round(g / a);
      pixels[offset + 2] = a === 0 ? 0 : Math.round(b / a);
      pixels[offset + 3] = Math.round((a / count) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 1 色 8 ビット
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // フィルターなし
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG を 1 つ含む ICO（PNG を埋め込む形式は、現在の主なブラウザが読める）。 */
function encodeIco(size: number, image: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(1, 10); // 色の面
  header.writeUInt16LE(32, 12); // 1 画素のビット数
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, image]);
}

function png(size: number, options: RenderOptions): Buffer {
  return encodePng(size, render(size, options));
}

function svg(): string {
  const house = HOUSE.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" fill="#1d5c40" />
  <path fill="#ffffff" fill-rule="evenodd" d="M${house.replaceAll(' ', 'L')}Z M${DOT.x - DOT.r},${DOT.y}a${DOT.r},${DOT.r} 0 1,0 ${DOT.r * 2},0a${DOT.r},${DOT.r} 0 1,0 -${DOT.r * 2},0Z" />
</svg>
`;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const files: Record<string, string | Buffer> = {
  'icon.svg': svg(),
  'favicon.ico': encodeIco(32, png(32, { rounded: true, background: true })),
  'apple-touch-icon.png': png(180, { rounded: false, background: true }),
  'icon-192.png': png(192, { rounded: true, background: true }),
  'icon-512.png': png(512, { rounded: true, background: true }),
  'badge-72.png': png(72, { rounded: false, background: false }),
};
for (const [name, content] of Object.entries(files)) {
  writeFileSync(resolve(OUTPUT_DIR, name), content);
  process.stdout.write(`${name}: ${String(content.length)} バイト\n`);
}
