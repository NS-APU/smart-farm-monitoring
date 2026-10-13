/**
 * 数値の入力欄の文字を、数値として読める形に整える（V-155）。
 * 日本語の入力環境では、全角の数字・記号（「１２」「－５」「３．５」）が入力されやすい。
 * 全角の数字・符号・小数点を半角にし、前後の空白を取り除く（カンマは取り除かない: 「1,5」のような誤りを、数値にしない）。数値として読めない文字は、そのまま残す
 * （検証で、数値でない旨のエラーになる）。
 */

const FULLWIDTH_OFFSET = 0xfee0;

export function normalizeNumberText(text: string): string {
  return text
    .trim()
    .replaceAll(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - FULLWIDTH_OFFSET))
    .replaceAll(/[－−ー‐]/g, '-')
    .replaceAll('＋', '+')
    .replaceAll(/[．。]/g, '.');
}
