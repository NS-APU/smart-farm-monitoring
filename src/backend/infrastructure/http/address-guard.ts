/**
 * 接続先（ホスト・IP アドレス）の制限の判定（Issue #172。ADR-0022）。
 * 管理者が、取り込み元の接続先を設定できるため、Lambda から、内部のアドレス（ループバック・プライベート・リンクローカル。
 * AWS のメタデータの 169.254.169.254 を含む）へリクエストを送れないようにする（SSRF の対策）。
 * 判定できない値は、安全側（拒否）に倒す。名前の解決の結果の IP アドレスも、接続の直前に、この判定で検査する。
 */

import { isIP, isIPv4, isIPv6 } from 'node:net';

/** [開始, 終了] の範囲（IPv4 を、32 ビットの整数にしたもの。両端を含む）。 */
type Ipv4Range = readonly [number, number];

function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** CIDR（a.b.c.d/長さ）の範囲。 */
function cidr(a: number, b: number, c: number, d: number, length: number): Ipv4Range {
  const start = ipv4(a, b, c, d);
  const size = 2 ** (32 - length);
  return [start, start + size - 1];
}

/** 拒否する IPv4 の範囲（特別な用途・内部のアドレス）。 */
const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = [
  cidr(0, 0, 0, 0, 8), // この（0.0.0.0/8）
  cidr(10, 0, 0, 0, 8), // プライベート
  cidr(100, 64, 0, 0, 10), // キャリアグレード NAT
  cidr(127, 0, 0, 0, 8), // ループバック
  cidr(169, 254, 0, 0, 16), // リンクローカル（AWS のメタデータを含む）
  cidr(172, 16, 0, 0, 12), // プライベート
  cidr(192, 0, 0, 0, 24), // IETF のプロトコル用
  cidr(192, 0, 2, 0, 24), // ドキュメント用
  cidr(192, 168, 0, 0, 16), // プライベート
  cidr(198, 18, 0, 0, 15), // ベンチマーク用
  cidr(198, 51, 100, 0, 24), // ドキュメント用
  cidr(203, 0, 113, 0, 24), // ドキュメント用
  cidr(224, 0, 0, 0, 4), // マルチキャスト
  cidr(240, 0, 0, 0, 4), // 予約済み（ブロードキャストを含む）
];

function parseIpv4(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return undefined;
  }
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return ipv4(a, b, c, d);
}

function isBlockedIpv4Value(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

/** IPv6 を、16 ビットずつ 8 個にする（「::」の省略・末尾の IPv4 表記を展開する）。読めなければ undefined。 */
function parseIpv6(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = parseIpv4(tail);
    if (embedded === undefined) {
      return undefined;
    }
    text = `${text.slice(0, lastColon + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const toGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1));
  return values.length === 8 && values.every((value) => value >= 0) ? values : undefined;
}

function embeddedIpv4(high: number, low: number): number {
  return ((high << 16) | low) >>> 0;
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  // 未指定（::）・ループバック（::1）
  if (groups.slice(0, 7).every((group) => group === 0) && (g7 === 0 || g7 === 1)) {
    return true;
  }
  // IPv4 マッピング（::ffff:a.b.c.d）・IPv4 互換（::a.b.c.d）: 埋め込まれた IPv4 で判定する
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (upperZero && (g5 === 0xffff || g5 === 0)) {
    return isBlockedIpv4Value(embeddedIpv4(g6, g7));
  }
  // NAT64（64:ff9b::/96）: 埋め込まれた IPv4 で判定する
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4Value(embeddedIpv4(g6, g7));
  }
  // 6to4（2002::/16）: 埋め込まれた IPv4（第 2・3 グループ）で判定する
  if (g0 === 0x2002) {
    return isBlockedIpv4Value(embeddedIpv4(g1, g2));
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // ユニークローカル fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // リンクローカル fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // サイトローカル fec0::/10（廃止された範囲）
    g0 >> 8 === 0xff || // マルチキャスト ff00::/8
    (g0 === 0x2001 && g1 === 0x0db8) // ドキュメント用 2001:db8::/32
  );
}

/** IP アドレス（IPv4・IPv6 の文字列）が、拒否する範囲か。IP アドレスとして読めない値も、拒否する。 */
export function isBlockedIpAddress(address: string): boolean {
  if (isIPv4(address)) {
    const value = parseIpv4(address);
    return value === undefined || isBlockedIpv4Value(value);
  }
  if (isIPv6(address)) {
    const groups = parseIpv6(address);
    return groups === undefined || isBlockedIpv6(groups);
  }
  return true;
}

/** 内部の名前として拒否するホスト名の、末尾（ドメイン）。 */
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.internal',
  '.local',
  '.lan',
  '.home.arpa',
  '.intranet',
];
const BLOCKED_HOST_NAMES = new Set([
  'localhost',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-allnodes',
  'ip6-allrouters',
]);

/**
 * ホスト名（IP アドレスではない名前）が、内部の名前か。数字だけ・16 進の表記（127.1・2130706433・0x7f.0.0.1）は、
 * 名前の解決で IP アドレスとして解釈されるため、拒否する。通常の名前は、解決後の IP アドレスで、あらためて検査する。
 */
export function isBlockedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOST_NAMES.has(name)) {
    return true;
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return name.split('.').every((label) => /^(0x[0-9a-f]+|\d+)$/.test(label));
}

/**
 * 接続設定のホスト（IPv4・[IPv6]・名前）が、拒否する接続先か。名前は、名前の解決の結果を、接続の直前に、あらためて検査する
 * （http-probe.ts）。ここは、設定を保存するときと、接続の前の、早い段階の判定。
 */
export function isBlockedConnectionHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare) !== 0 ? isBlockedIpAddress(bare) : isBlockedHostname(bare);
}
