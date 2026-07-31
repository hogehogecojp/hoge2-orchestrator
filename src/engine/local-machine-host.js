// 「この host は自分のマシンを指しているか」の判定。
//
// engine（resolveTaskPaneCwd）と doctor（isLocalVkTerminalsApiHost）で共有する。
// 同じ apiHost を engine は「自分のマシン」、doctor は「別マシン」と読む状態を作らないため、
// **「何が手元を指す表記か」という事実の知識はすべてこのファイルに置く**（issue #256）。
//
// 一方で doctor 固有の「判断できない値（空文字・ホストとして妥当でない文字）は必須側へ
// 倒す」フェイルセーフは doctor 側に残す。あれは事実の知識ではなく、doctor の案内を
// 消さないための方針。共有ヘルパ側は空文字を false（＝手元と断定しない）に保つ。
// 現状 engine が空文字を渡す経路は無い（config.js の resolveVkTerminalsApiHost() は
// 未設定・空白のみのときも 127.0.0.1 へフォールバックする）が、渡された場合の安全側の
// 既定として false を守る。
//
// **DNS 解決はしない。** doctor は「副作用なし・高速」を守る必要があり、名前解決を挟むと
// ネットワーク待ちが診断に入り込む。os が持っている情報（NIC のアドレスと os.hostname()）
// だけで判定する。
import { hostname, networkInterfaces } from 'os';
import { isIPv4, isIPv6 } from 'net';

export function normalizeHostForLocalComparison(host) {
  let normalized = String(host ?? '').trim().toLowerCase();
  normalized = normalized.replace(/^\[|\]$/g, '');
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }
  // 末尾のドット（`mymac.local.` のような正規の FQDN 表記）を落とす。残したままだと
  // 完全一致に失敗するうえ、後述のローカルスコープ判定でも suffix が `local.` になって
  // 許可リストを外れる（同じマシンを指す正規の書き方が別マシン扱いになる）。
  normalized = normalized.replace(/\.+$/, '');
  return normalized;
}

export function collectLocalMachineAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry?.address)
    .filter((address) => typeof address === 'string' && address.trim() !== '');
}

/**
 * 自マシンのホスト名を集める。
 *
 * apiHost には IP だけでなく `mymac.local`（mDNS）や `mymac.tailXXXX.ts.net`
 * （Tailscale MagicDNS）も書ける。NIC のアドレスとしか照合しないと、自分のマシンを
 * 指しているのに「別マシン」と判定してしまう（issue #256）。
 *
 * os.hostname() は環境・設定によって失敗しうる（例外を投げうる）ので、落ちても
 * 判定全体を止めない。取れなければホスト名照合をしないだけで、アドレス照合は従来どおり効く。
 * @returns {string[]} 正規化済みの自マシン名（取得できなければ空配列）
 */
export function collectLocalMachineHostnames() {
  let raw = '';
  try {
    raw = hostname();
  } catch {
    return [];
  }
  const normalized = normalizeHostForLocalComparison(raw);
  return normalized === '' ? [] : [normalized];
}

/**
 * IPv6 リテラルを 8 グループの数値へ展開する（`::` の省略と末尾 IPv4 表記を解く）。
 *
 * 文字列の見た目で比較すると、同じアドレスの別表記（`0:0:0:0:0:0:0:1` / `::0001` /
 * `::ffff:7f00:1`）を取りこぼす。取りこぼすと「手元なのに別マシン」と読み、診断側で
 * Claude Code 要件が任意へ落ちる＝ issue #247 が再発する向きに倒れる。
 * @param {string} normalized 正規化済みの値
 * @returns {number[]|null} 8 個の 16bit 値（IPv6 リテラルでなければ null）
 */
function expandIPv6Groups(normalized) {
  if (!isIPv6(normalized)) return null;
  let text = normalized;
  // 末尾が IPv4 表記（`::ffff:127.0.0.1`）なら 2 グループの 16 進表記へ畳んでから展開する。
  const embeddedV4 = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embeddedV4) {
    const octets = embeddedV4[1].split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, text.length - embeddedV4[1].length)}${high}:${low}`;
  }
  const doubleColonIndex = text.indexOf('::');
  let groups;
  if (doubleColonIndex === -1) {
    groups = text.split(':');
  } else {
    const head = text.slice(0, doubleColonIndex).split(':').filter((group) => group !== '');
    const tail = text.slice(doubleColonIndex + 2).split(':').filter((group) => group !== '');
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * ドット区切りの数値、または `:` を含む値＝IP アドレス表記か。
 *
 * 後述の先頭ラベル比較を掛けてよいのは「名前」だけ。`203.0.113.10` と `203.0.113.99` は
 * 先頭ラベルがどちらも `203` なので、掛けてしまうと無関係な別マシンが手元に化ける。
 * @param {string} normalized 正規化済みの値
 * @returns {boolean}
 */
function looksLikeIpLiteral(normalized) {
  return normalized.includes(':') || /^[0-9.]+$/.test(normalized);
}

/** 最初の `.` までの部分（`mymac.local` → `mymac`）。 */
function firstLabelOf(normalized) {
  const dotIndex = normalized.indexOf('.');
  return dotIndex === -1 ? normalized : normalized.slice(0, dotIndex);
}

/** ローカルスコープとみなす接尾辞（mDNS / 一般的な宅内・社内 LAN / MagicDNS）。 */
const LOCAL_SCOPE_SUFFIXES = new Set(['local', 'lan', 'home.arpa', 'internal']);

/**
 * 名前が「手元のネットワークの中でしか意味を持たない」スコープに属するか。
 *
 * 先頭ラベル比較（後述）を掛けてよい相手をここで絞る。無制限に掛けると、自マシン名が
 * `mymac` のときに `mymac.example.com` や `mymac.attacker.tld` まで手元と判定され、
 * engine が接続先へ**手元のリポジトリの絶対パス**を渡してしまう（接続先に同じパスが
 * あれば、意図しないクローンで Claude Code が起動する）。自マシン名が `localhost` に
 * なりがちなコンテナ環境では `localhost.evil.example` も通ってしまう。
 * @param {string} normalized 正規化済みの値
 * @returns {boolean}
 */
function isLocalScopeName(normalized) {
  const dotIndex = normalized.indexOf('.');
  // 短縮名（ドット無し）は所属ドメインを名乗っていない＝手元の名前空間の話とみなす。
  if (dotIndex === -1) return true;
  const suffix = normalized.slice(dotIndex + 1);
  // `.ts.net` は Tailscale MagicDNS（`mymac.tailXXXX.ts.net`）。tailnet 名が挟まるので
  // 完全一致ではなく末尾一致で見る。
  return LOCAL_SCOPE_SUFFIXES.has(suffix) || suffix.endsWith('.ts.net');
}

/**
 * 全アドレス束縛の表記か（どの NIC で受けても、待ち受けているのは手元のプロセス）。
 */
export function isWildcardBindHost(host) {
  const normalized = normalizeHostForLocalComparison(host);
  if (normalized === '0.0.0.0') return true;
  const groups = expandIPv6Groups(normalized);
  // `::` のほか `0:0:0:0:0:0:0:0` のような書き方も同じアドレス。
  return groups !== null && groups.every((group) => group === 0);
}

/**
 * ループバックを指す表記か。
 *
 * 127.0.0.1 だけでなく 127.0.0.0/8 全体を含める。127.0.1.1 は Debian 系が自ホスト名へ
 * 割り当てる表記で、ここを 127.0.0.1 に限ると doctor と engine で結論が割れる（issue #256）。
 *
 * 判定は文字列パターンではなく net.isIPv4/isIPv6 を通す。`/^127\.\d{1,3}\./` のような
 * 正規表現は各オクテットの範囲を見ないので `127.0.0.256` まで「ループバック」と読むが、
 * この値は IP リテラルではなくホスト名として名前解決され、任意の宛先へ行きうる。
 *
 * なお `127.1`（クラス A の短縮表記）と `127.0.0.1:3010`（ポート番号付き）は対象外。
 * 前者は inet_aton 相当の実装が要り、後者は「接続先にポート付きの値を書いた」という
 * 別の設定ミスなので、別 issue で扱う。
 */
export function isLoopbackHost(host) {
  const normalized = normalizeHostForLocalComparison(host);
  if (normalized === 'localhost') return true;
  if (isIPv4(normalized)) return normalized.split('.')[0] === '127';
  const groups = expandIPv6Groups(normalized);
  if (groups === null) return false;
  // ::1（`0:0:0:0:0:0:0:1` / `::0001` も同じアドレス）
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  // ::ffff:127.0.0.0/8（IPv4 射影。`::ffff:7f00:1` のような 16 進表記も含む）
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return (groups[6] >> 8) === 127;
  }
  return false;
}

/**
 * host が「このマシン自身」を指しているか。
 *
 * 判定材料は 3 つ。いずれも os が持っている情報だけで、DNS 解決はしない。
 * 1. ループバック表記（127.0.0.0/8 / localhost / ::1 / ::ffff:127.x.x.x）
 * 2. 全アドレス束縛（0.0.0.0 / ::）
 * 3. NIC のアドレス（Tailscale IP / LAN IP をそのまま書く運用）と os.hostname()
 *
 * 2 について: 従来 engine 側は 0.0.0.0 / 127.0.1.1 を「別マシン」と読んでいたが、これらは
 * 手元を指す表記なので「手元」に変わる。engine では resolveTaskPaneCwd が作業ディレクトリ
 * 検出へ進むようになるだけで、検出できなければ従来と同じ安全既定へ落ちる。
 *
 * 3 のホスト名照合は、完全一致に加えて **先頭ラベル（最初の `.` までの部分）どうしの一致**
 * まで許す。os.hostname() は環境によって `mymac` / `mymac.local` のどちらも返しうる一方、
 * apiHost には `mymac.local`（mDNS）とも `mymac.tailXXXX.ts.net`（MagicDNS）とも書けるため、
 * 完全一致だけでは同じマシンを指す表記の大半を取りこぼす。
 *
 * ただし **先頭ラベル比較を掛けるのは、host（apiHost 側）がローカルスコープの名前
 * （短縮名・`.local` / `.lan` / `.home.arpa` / `.internal` / `*.ts.net`）のときだけ**に絞る。
 * 絞らないと `mymac.example.com` や `mymac.attacker.tld` まで手元と判定され、engine が
 * 接続先へ手元のリポジトリの絶対パスを渡してしまう（接続先に同じ絶対パスがあると、意図しない
 * クローンで Claude Code が起動する。同一ユーザーの Mac 2 台は、名前が衝突しやすく、かつ
 * 同じパスが両方に存在しやすい構成でもある）。
 *
 * **この絞り込みは host 側にだけ掛け、自マシン名の側には掛けない。** 危険なのは「接続先として
 * 書かれた値が、どこか別のドメインを指しうる」ことなので、絞る対象は host 側で足りる。両側に
 * 掛けると、os.hostname() が社内ドメインの FQDN（`mymac.corp.example.com`）を返す環境で、
 * apiHost に `mymac.local` と書いている正当な構成まで落ちてしまう。
 *
 * **残るトレードオフ**: 手元のローカルネットワークに同名の別マシンがいる場合（自マシンが
 * `mymac.local` で、`mymac.lan` が別の機械）は誤って手元と判定しうる。それでも許容するのは、
 * 誤りの向きとコストが各消費側で軽いため。
 * - doctor は「判断できない値は必須側へ倒す」方針で、誤って手元に倒れても出るのは従来どおりの
 *   案内（Claude Code を入れてください）だけ。逆に取りこぼすと claude 要件が任意へ落ち、
 *   未導入で作業が進まないのに何も案内されない状態（issue #247）が再発する＝実害が大きい。
 * - engine は resolveTaskPaneCwd で作業ディレクトリ検出に進むだけで、手元に該当リポジトリの
 *   クローンが無ければ従来と同じ安全既定へ落ちる。
 * なお IP アドレス表記には掛けない（looksLikeIpLiteral）。数値の先頭ラベルは名前ではなく、
 * `203.0.113.10` と `203.0.113.99` が一致してしまうため。
 * @param {*} host 判定対象（apiHost）
 * @param {string[]} [localAddresses] 自マシンのアドレス一覧（省略時は os から収集）
 * @param {string[]} [localHostnames] 自マシンのホスト名一覧（省略時は os から収集）
 * @returns {boolean} 手元のマシンを指していれば true
 */
export function isLocalMachineHost(
  host,
  localAddresses = collectLocalMachineAddresses(),
  localHostnames = collectLocalMachineHostnames(),
) {
  const normalized = normalizeHostForLocalComparison(host);
  if (normalized === '') return false;
  if (isLoopbackHost(normalized)) return true;
  if (isWildcardBindHost(normalized)) return true;

  const normalizedLocalAddresses = new Set(
    (localAddresses ?? [])
      .map((address) => normalizeHostForLocalComparison(address))
      .filter((address) => address !== ''),
  );
  if (normalizedLocalAddresses.has(normalized)) return true;

  const normalizedLocalHostnames = (localHostnames ?? [])
    .map((name) => normalizeHostForLocalComparison(name))
    .filter((name) => name !== '');
  if (normalizedLocalHostnames.includes(normalized)) return true;

  if (looksLikeIpLiteral(normalized)) return false;
  // 先頭ラベル比較の入口。ここを通れるのは host 側がローカルスコープの名前のときだけ
  //（理由は JSDoc）。自マシン名の側は絞らず、従来どおり先頭ラベルを取り出して比べる。
  if (!isLocalScopeName(normalized)) return false;
  const label = firstLabelOf(normalized);
  if (label === '') return false;
  return normalizedLocalHostnames.some(
    (name) => !looksLikeIpLiteral(name) && firstLabelOf(name) === label,
  );
}
