#!/usr/bin/env bash
#
# 常駐監視をVPSに入れる。何度実行しても同じ状態になる。
#
#   sudo ./deploy/install.sh
#
# やること:
#   1. 前提（node / npm / systemd）を確かめる
#   2. 専用ユーザー xm を作る
#   3. /opt/xm にこのリポジトリを置き、依存を入れる
#   4. /etc/xm/watch.env を用意する（既にあれば触らない）
#   5. 通信が通るか確かめる
#   6. systemd に登録する
#
# 最後の起動は自動でやらない。Webhook を書く前に上げると、判定は
# 動いているのに通知はどこにも届かない状態になる。手順を最後に出す。

set -euo pipefail

APP_USER=xm
APP_DIR=/opt/xm
STATE_DIR=/var/lib/xm
ENV_DIR=/etc/xm
ENV_FILE="${ENV_DIR}/watch.env"
UNIT=xm-watch.service

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m警告: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mエラー: %s\033[0m\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "root で実行してください: sudo $0"

# ---------------------------------------------------------------- 1. 前提
say "前提を確かめます"

command -v systemctl >/dev/null || die "systemd がありません。pm2 での動かし方は README を見てください。"

command -v node >/dev/null || die "node がありません。Node.js 20 以上を入れてください。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge 20 ]] || die "Node.js 20 以上が要ります（いまは $(node -v)）。"
command -v npm >/dev/null || die "npm がありません。"

NODE_PATH_REAL="$(command -v node)"
case "${NODE_PATH_REAL}" in
  /home/*|"${HOME}"/*)
    # unit は tsx を直接呼ぶ。tsx の shebang は `/usr/bin/env node` なので、
    # node が利用者ごとの場所（nvm 等）にあると xm ユーザーからは見えない
    warn "node が ${NODE_PATH_REAL} にあります。nvm など利用者ごとの導入と思われます。"
    warn "xm ユーザーからは見えないので、systemd からの起動に失敗します。"
    warn "システム全体に入る形（apt の nodejs、NodeSource 等）で入れ直してください。"
    die "Node.js の置き場所を直してからやり直してください。"
    ;;
esac
echo "node $(node -v) （${NODE_PATH_REAL}） / npm $(npm -v)"

# ---------------------------------------------------------------- 2. ユーザー
say "実行ユーザー ${APP_USER} を用意します"
if id -u "${APP_USER}" >/dev/null 2>&1; then
  echo "すでにあります。"
else
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
  echo "作りました。"
fi

# ---------------------------------------------------------------- 3. 配置
say "${APP_DIR} に配置します"
mkdir -p "${APP_DIR}"
if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
  # node_modules と状態ファイルは持ち込まない。前者は入れ直す、
  # 後者は STATE_DIR にあるべきもので、上書きすると通知履歴が飛ぶ
  tar -C "${SOURCE_DIR}" \
    --exclude=node_modules --exclude=.next --exclude=.git \
    --exclude='.signal-*' \
    -cf - . | tar -C "${APP_DIR}" -xf -
  echo "コピーしました（node_modules / .git / 状態ファイルは除く）。"
else
  echo "すでに ${APP_DIR} で実行しています。コピーは省きます。"
fi

mkdir -p "${STATE_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${STATE_DIR}"
chmod 750 "${STATE_DIR}"

say "依存を入れます（少し時間がかかります）"
# npm ci は package-lock.json のとおりに入れる。install と違って
# 勝手にロックを書き換えないので、VPS と手元で同じ版になる。
#
# --omit=dev は使えない。監視は tsx で TypeScript を直接動かしていて、
# その tsx が devDependencies にあるため、落とすと起動できなくなる
# （導入は成功したように見えて、サービスだけが上がらない）
sudo -u "${APP_USER}" env HOME="${APP_DIR}" npm ci --prefix "${APP_DIR}"

TSX_BIN="${APP_DIR}/node_modules/.bin/tsx"
[[ -x "${TSX_BIN}" ]] || die "${TSX_BIN} がありません。依存の導入に失敗しています。"

# ---------------------------------------------------------------- 4. 設定
say "${ENV_FILE} を用意します"
mkdir -p "${ENV_DIR}"
chmod 755 "${ENV_DIR}"
if [[ -f "${ENV_FILE}" ]]; then
  echo "すでにあります。中身は触りません。"
else
  install -m 600 -o root -g root "${SOURCE_DIR}/deploy/watch.env.example" "${ENV_FILE}"
  echo "雛形から作りました。SIGNAL_WEBHOOK_URL を書いてください。"
fi

WEBHOOK_SET=0
if grep -qE '^SIGNAL_WEBHOOK_URL=.+' "${ENV_FILE}"; then WEBHOOK_SET=1; fi

# ---------------------------------------------------------------- 5. 疎通
say "相場データの取得先に届くか確かめます"
# ここで落ちても導入は止めない。回線が一時的に不調なだけかもしれず、
# systemd は再起動を繰り返して自力で復帰する。ただし黙って進めると
# 「入れたのに永遠に無音」の原因が分からなくなるので必ず言う
if sudo -u "${APP_USER}" env HOME="${APP_DIR}" \
     curl -sS -m 20 -o /dev/null -w '%{http_code}' \
     'https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1h&range=5d' \
     2>/dev/null | grep -q '^200$'; then
  echo "届きました。"
else
  warn "取得先に届きません。"
  warn "この状態だと合成データにしかならず、シグナルは一切通知されません"
  warn "（合成データでは通知しない設計のため）。"
  warn "外向きHTTPSが塞がれていないか、プロキシが要るなら ${ENV_FILE} に"
  warn "HTTPS_PROXY を書いてください。"
fi

# ---------------------------------------------------------------- 6. 登録
say "systemd に登録します"
install -m 644 -o root -g root "${SOURCE_DIR}/deploy/${UNIT}" "/etc/systemd/system/${UNIT}"
systemctl daemon-reload
systemctl enable "${UNIT}" >/dev/null
echo "登録しました。"

# ---------------------------------------------------------------- 案内
say "導入できました"

if [[ ${WEBHOOK_SET} -eq 0 ]]; then
  cat <<EOF

まだ起動していません。SIGNAL_WEBHOOK_URL が空だからです。
このまま上げると判定は動きますが、通知はどこにも届きません。

  1. sudo nano ${ENV_FILE}          … SIGNAL_WEBHOOK_URL を書く
  2. sudo systemctl start ${UNIT}
  3. sudo -u ${APP_USER} bash -c 'set -a; . ${ENV_FILE}; set +a; \\
       exec ${TSX_BIN} ${APP_DIR}/scripts/watch.ts --test-notification'
     … 通知が届くか1件だけ送って確かめる
EOF
else
  cat <<EOF

  sudo systemctl start ${UNIT}

起動したら、まず疎通確認を1件送ってください:

  sudo -u ${APP_USER} bash -c 'set -a; . ${ENV_FILE}; set +a; \\
    exec ${TSX_BIN} ${APP_DIR}/scripts/watch.ts --test-notification'
EOF
fi

cat <<EOF

普段見るもの:

  systemctl status ${UNIT}
  journalctl -u ${UNIT} -f          … 判定のたびに1行出る
  journalctl -u ${UNIT} --since today

成績の突き合わせ（1か月ほど貯まってから）:

  sudo -u ${APP_USER} ${TSX_BIN} ${APP_DIR}/scripts/reconcile.ts \\
    --log ${STATE_DIR}/signal-log.jsonl

覚えておくこと: シグナルは1銘柄あたり平均4.3日に1回しか出ません。
静かなのは正常です。24時間何も無ければ「動いています」が届きます。
EOF
