#!/usr/bin/env bash
# 日本語のフォント（Noto Sans CJK JP の Regular・Bold）を用意し、ハッシュで検証して、フォントとして入れる（Issue #185・#322）。
# action.yml から呼ぶ。手元では、BASE_URL を差し替えて（file://…）、動作を確かめられる。
#
# 環境変数:
#   CACHE_DIR        （必須）フォントの置き場。CI では、キャッシュを復元する場所
#   NOTO_CJK_COMMIT  （必須）取得元（notofonts/noto-cjk）のコミット
#   REGULAR_SHA256・BOLD_SHA256 （必須）それぞれのファイルの sha256
#   INSTALL          true（既定）なら、フォントとして入れる（INSTALL_DIR へ複製。root が必要）。false なら、用意と検証だけ
#   INSTALL_DIR      入れる先。既定は /usr/local/share/fonts/noto-cjk
#   BASE_URL         取得元の URL の前半。既定は GitHub の raw
#
# 動作:
#   - CACHE_DIR に、ハッシュが合うファイルがあれば、取得しない（キャッシュの利用）
#   - ファイルがない・ハッシュが合わないときは、（合わないファイルを消して）取得し、ハッシュを検証する。合わなければ、失敗する
#   - 検証に通ったファイルだけが、CACHE_DIR に残る（検証に失敗したファイルは、消す。キャッシュに入れない）
set -euo pipefail

: "${CACHE_DIR:?CACHE_DIR が必要です}"
: "${NOTO_CJK_COMMIT:?NOTO_CJK_COMMIT が必要です}"
: "${REGULAR_SHA256:?REGULAR_SHA256 が必要です}"
: "${BOLD_SHA256:?BOLD_SHA256 が必要です}"
INSTALL="${INSTALL:-true}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/share/fonts/noto-cjk}"
BASE_URL="${BASE_URL:-https://github.com/notofonts/noto-cjk/raw/${NOTO_CJK_COMMIT}/Sans/OTC}"

mkdir -p "$CACHE_DIR"

# ファイルのハッシュが、期待する値と一致するか（標準出力・標準エラーには、何も出さない）
matches() {
  local expected="$1" path="$2"
  [ -s "$path" ] && echo "${expected}  ${path}" | sha256sum -c - > /dev/null 2>&1
}

for weight in Regular Bold; do
  file="NotoSansCJK-${weight}.ttc"
  path="${CACHE_DIR}/${file}"
  if [ "$weight" = "Regular" ]; then expected="$REGULAR_SHA256"; else expected="$BOLD_SHA256"; fi

  if matches "$expected" "$path"; then
    echo "${file}: キャッシュ（または、取得済み）のファイルを使います（ハッシュが一致）"
    continue
  fi
  if [ -e "$path" ]; then
    echo "::warning::${file}: 保存されているファイルのハッシュが合いません。捨てて、取得し直します"
    rm -f "$path"
  fi

  echo "${file}: 取得します"
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o "$path" "${BASE_URL}/${file}"
  if ! matches "$expected" "$path"; then
    echo "::error::${file}: 取得したファイルのハッシュが、期待する値と一致しません（取得元・ハッシュを確認してください）"
    rm -f "$path"
    exit 1
  fi
  echo "${file}: ハッシュを検証しました"
done

if [ "$INSTALL" != "true" ]; then
  echo "フォントとして入れる処理は、省きます（INSTALL=${INSTALL}）"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
cp -f "${CACHE_DIR}/NotoSansCJK-Regular.ttc" "${CACHE_DIR}/NotoSansCJK-Bold.ttc" "$INSTALL_DIR/"

# フォントの一覧を更新し、使えることを確かめる（fontconfig のコマンドが、ない環境では、確認を省く）
if command -v fc-cache > /dev/null; then fc-cache -f "$INSTALL_DIR"; fi
if command -v fc-list > /dev/null; then
  # パイプで grep -q に渡さない（grep が先に終わると、fc-list が SIGPIPE を受け、pipefail で、一致していても失敗する）
  families="$(fc-list : family)"
  if ! grep -q "Noto Sans CJK JP" <<< "$families"; then
    echo "::error::Noto Sans CJK JP が、フォントとして見つかりません。見つかったフォントの一覧（先頭 30 件）:"
    head -n 30 <<< "$families"
    exit 1
  fi
  fc-match "Noto Sans CJK JP:weight=bold"
fi
