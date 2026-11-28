import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** アプリのアイコン（Issue #326）。タブ・ホーム画面・通知で、同じ絵柄を使う。 */

const FRONTEND_DIR = resolve(import.meta.dirname, '../../../src/frontend');
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

function publicFile(path: string): string {
  return resolve(PUBLIC_DIR, path.replace(/^\//, ''));
}

/** PNG の幅・高さ（IHDR）を読む。PNG でなければ undefined。 */
function pngSize(path: string): { width: number; height: number } | undefined {
  const data = readFileSync(publicFile(path));
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function readManifest(): { icons?: ManifestIcon[] } {
  return JSON.parse(readFileSync(publicFile('manifest.webmanifest'), 'utf8')) as {
    icons?: ManifestIcon[];
  };
}

describe('アプリのアイコン: ブラウザのタブ（index.html）', () => {
  const html = readFileSync(resolve(FRONTEND_DIR, 'index.html'), 'utf8');

  it('SVG のアイコンと、favicon.ico の両方を指定する（favicon.ico を自動で取得するブラウザも、403 にならない）', () => {
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml" />');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
    expect(existsSync(publicFile('icon.svg'))).toBe(true);
    expect(existsSync(publicFile('favicon.ico'))).toBe(true);
  });

  it('iPhone・iPad のホーム画面用に、apple-touch-icon（180×180 の PNG）を指定する', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(pngSize('apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
  });

  it('SVG のアイコンは、SVG として読める（viewBox がある）', () => {
    const svg = readFileSync(publicFile('icon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('viewBox="0 0 512 512"');
  });

  it('favicon.ico は、ICO 形式で、32×32 の画像を 1 つ含む', () => {
    const ico = readFileSync(publicFile('favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0); // 予約
    expect(ico.readUInt16LE(2)).toBe(1); // 種別: アイコン
    expect(ico.readUInt16LE(4)).toBe(1); // 画像の数
    expect(ico[6]).toBe(32); // 幅
    expect(ico[7]).toBe(32); // 高さ
    const offset = ico.readUInt32LE(18);
    const size = ico.readUInt32LE(14);
    expect(ico.subarray(offset, offset + 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(offset + size).toBe(ico.length);
  });
});

describe('アプリのアイコン: ホーム画面（manifest.webmanifest）', () => {
  it('icons に、192×192 と 512×512 の PNG を載せ、参照先のファイルが存在し、宣言の大きさと一致する', () => {
    const icons = readManifest().icons ?? [];
    const sizes = icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const icon of icons) {
      expect(icon.type, icon.src).toBe('image/png');
      expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(pngSize(icon.src), icon.src).toEqual({ width, height });
    }
  });
});

describe('アプリのアイコン: 通知（sw.js）', () => {
  const source = readFileSync(publicFile('sw.js'), 'utf8');

  it('通知のアイコンとバッジに指定するファイルが存在し、PNG（バッジは 72×72）である', () => {
    expect(pngSize('icon-192.png')).toEqual({ width: 192, height: 192 });
    expect(pngSize('badge-72.png')).toEqual({ width: 72, height: 72 });
    expect(source).toContain("'/icon-192.png'");
    expect(source).toContain("'/badge-72.png'");
  });
});
