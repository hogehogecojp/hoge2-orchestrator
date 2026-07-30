/**
 * 配布 zip でのアップデート（インストールディレクトリの入れ替え）の判断部分。
 *
 * ここは純粋関数だけを置き、実際のダウンロード・展開・rename は
 * src/engine/update-runner.js が担う。入れ替えは一度失敗するとアプリが起動しなくなる
 * 処理なので、「どういう順番で何をするか」をデータとして取り出せる形にしておき、
 * テストで順序まで固定できるようにしている。
 *
 * 設計上の要点:
 *
 *   - 入れ替えは rename 2 回（install → backup、staged → install）。POSIX の rename は
 *     ディレクトリでも原子的に働くため、途中の中途半端な状態が外から見えない。
 *   - そのため展開先はインストールディレクトリの「兄弟」に置く（同一ファイルシステムを
 *     保証する）。親が書けない環境だけ、ホーム配下へ退避してコピー方式へ落とす。
 *   - 利用者の資産（.env / config.json など）は「展開先へ写す → 入れ替え → 旧側を backup として残す」
 *     の順で扱う。退避してから復元する方式は、復元前に落ちると資産がインストールの外に
 *     取り残されるため採らない。この順序なら資産は常に「展開先」と「backup」の 2 か所にある。
 */

import { join, isAbsolute, normalize, dirname, basename, resolve as resolvePath } from 'path';

/**
 * 入れ替え時に引き継ぐ利用者の資産（インストールディレクトリからの相対パス）。
 *
 * `.gitignore` を正にはしない。`.gitignore` には `node_modules` や `*.log` のように
 * 「引き継いではいけないもの」も並ぶため、引き継ぐものだけを専用の配列で明示する。
 */
export const PRESERVED_RELATIVE_PATHS = [
  '.env',
  'config.json',
  'vendor/vk-agents-public/config.json',
  '.claude/settings.local.json',
];

/**
 * 作業記録（journal）の保存内容が表す段階。
 * `swapping` の記録が残っていたら、前回の入れ替えが途中で終わっている。
 */
export const UPDATE_PHASES = ['staging', 'swapping', 'completed', 'reverted'];

/**
 * 相対パスが安全か（親ディレクトリへ脱出しないか）を判定する。
 * @param {string} relativePath
 * @returns {boolean}
 */
function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return false;
  if (isAbsolute(relativePath)) return false;
  const normalized = normalize(relativePath);
  if (normalized.startsWith('..')) return false;
  // 途中に `..` を含む形（a/../../b）も弾く。
  return !normalized.split(/[\\/]/).includes('..');
}

/**
 * 引き継ぐ資産の一覧を決める。
 *
 * @param {object} input
 * @param {Array<string|{path:string, symlink?:boolean}>} input.existing
 *   インストールディレクトリに実在するものの一覧（呼び出し側が測定して渡す）。
 * @param {string[]} [input.candidates] 引き継ぎ候補（既定は PRESERVED_RELATIVE_PATHS）
 * @returns {{ preserved: string[], rejected: Array<{path:string, reason:string}> }}
 */
export function computePreservedPaths({ existing = [], candidates = PRESERVED_RELATIVE_PATHS } = {}) {
  const entries = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    if (typeof item === 'string') entries.set(normalize(item), { symlink: false });
    else if (item && typeof item.path === 'string') {
      entries.set(normalize(item.path), { symlink: item.symlink === true });
    }
  }

  const preserved = [];
  const rejected = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!isSafeRelativePath(candidate)) {
      rejected.push({ path: String(candidate), reason: 'unsafe-path' });
      continue;
    }
    const key = normalize(candidate);
    const found = entries.get(key);
    if (!found) continue; // 存在しないものは列に入れない
    if (found.symlink) {
      // シンボリックリンクは指す先が読めない／インストール外を指しうるので引き継がない。
      rejected.push({ path: candidate, reason: 'symlink' });
      continue;
    }
    preserved.push(candidate);
  }
  return { preserved, rejected };
}

/**
 * 入れ替えの手順を配列データとして返す。
 *
 * 手順の順序が仕様そのものなので、実行側は必ずこの配列の順に処理する。
 * 先頭が必ず作業記録の書き込みであることが重要（記録より先にディレクトリを動かすと、
 * 途中で電源が落ちたときに「何が起きたのか」を次回起動時に判断できない）。
 *
 * @param {object} input
 * @param {string} input.installDir 入れ替え対象（現在のインストール先）
 * @param {string} input.stagedDir 検証済みの新しい版が入っている展開先
 * @param {boolean} input.sameDevice installDir と stagedDir が同一ファイルシステムか
 * @param {string} input.backupPath 旧インストールを残す先
 * @param {string} input.journalPath 作業記録の保存先（インストール外）
 * @param {string|null} [input.from] 旧版
 * @param {string|null} [input.to] 新版
 * @param {string[]|null} [input.argv] 入れ替え後に起動し直すときの元の引数
 * @returns {Array<object>} 手順（op 別のプレーンオブジェクト）
 */
export function planSwap({
  installDir,
  stagedDir,
  sameDevice = true,
  backupPath,
  journalPath,
  from = null,
  to = null,
  argv = null,
} = {}) {
  const journalBase = {
    installPath: installDir,
    stagedPath: stagedDir,
    backupPath,
    from,
    to,
    // 入れ替え後に「元の起動処理へ戻す」ために、起動時の引数も記録しておく。
    argv: Array.isArray(argv) ? [...argv] : null,
  };

  const steps = [
    { op: 'write-journal', path: journalPath, journal: { ...journalBase, phase: 'swapping' } },
    { op: 'rename', from: installDir, to: backupPath },
  ];

  if (sameDevice) {
    steps.push({ op: 'rename', from: stagedDir, to: installDir });
  } else {
    // 別ファイルシステムでは rename できないため copy → 展開先削除。原子的ではないので
    // 作業記録による復旧が前提になる（だからこそ記録を先に書いている）。
    steps.push({ op: 'copy-dir', from: stagedDir, to: installDir });
    steps.push({ op: 'remove-dir', path: stagedDir });
  }

  steps.push({ op: 'write-journal', path: journalPath, journal: { ...journalBase, phase: 'completed' } });
  return steps;
}

/**
 * 前回の入れ替えが途中で終わっていた場合の対処を決める。
 *
 * 呼び出し側が実際の存在有無を測って渡す（純粋関数のため）。
 *
 * 判断:
 *   - 記録がない／`swapping` でない → none（何もしない。2 回連続で呼んでも冪等）
 *   - install が無く展開先がある → complete（rename をやり直して新しい版を入れる）
 *   - install が無く backup がある → revert（旧版を戻して起動できる状態にする）
 *   - install と backup の両方がある → revert（記録が確定していない＝新版の起動確認が
 *     取れていないため、確実に動いていた旧版へ戻す方を選ぶ）
 *   - install だけがある → none（rename がまだ始まっていない）
 *
 * @param {object|null} journal
 * @returns {{ action:'complete'|'revert'|'none', reason:string }}
 */
export function recoverInterruptedUpdate(journal) {
  if (!journal || typeof journal !== 'object') {
    return { action: 'none', reason: 'no-journal' };
  }
  if (journal.phase !== 'swapping') {
    return { action: 'none', reason: 'no-pending-swap' };
  }

  const installExists = journal.installExists === true;
  const backupExists = journal.backupExists === true;
  const stagedExists = journal.stagedExists === true;

  if (!installExists && stagedExists) {
    return { action: 'complete', reason: 'staged-ready' };
  }
  if (!installExists && backupExists) {
    return { action: 'revert', reason: 'install-missing' };
  }
  if (installExists && backupExists) {
    return { action: 'revert', reason: 'swap-unconfirmed' };
  }
  if (installExists) {
    return { action: 'none', reason: 'swap-not-started' };
  }
  return { action: 'none', reason: 'nothing-to-recover' };
}

/**
 * 今アップデートを実行してよいかを判定する。
 *
 * 稼働中に入れ替えると、走っているタスクとターミナルを巻き込む
 * （POSIX の rename は走行中プロセスが掴んでいる古いディレクトリを生かしたままにするため、
 * 動いている GUI は古いコードで動き続け、新旧が混在した状態になる）。
 * そのため静止していることを確認できないときは実行しない。
 *
 * @param {object} input
 * @param {boolean} input.healthResponding VK Terminals API が応答しているか（＝GUI 稼働中）
 * @param {boolean} input.startLockHeld orchestrator の起動ロックが取られているか（＝engine 稼働中）
 * @param {'git'|'zip'|'off'|'unknown'} input.channel 入手経路
 * @returns {Array<{code:string, message:string, hint:string}>} 空配列なら実行可
 */
export function evaluateUpdateBlockers({
  healthResponding = false,
  startLockHeld = false,
  channel = 'unknown',
} = {}) {
  const blockers = [];

  if (channel === 'unknown') {
    blockers.push({
      code: 'channel-unresolved',
      message: 'このアプリをどうやって入れたのかが分からないため、自動では切り替えられません。',
      hint: '配布された zip を展開し直すか、`git clone` した場所から起動してください。',
    });
  }

  if (healthResponding) {
    blockers.push({
      code: 'busy-gui',
      message: 'アプリが起動中のため、アップデートを実行できません。',
      hint: 'アプリを終了してから、もう一度実行してください。',
    });
  }

  if (startLockHeld) {
    blockers.push({
      code: 'busy-engine',
      message: 'オーケストレーターが動作中のため、アップデートを実行できません。',
      hint: '実行中のタスクが終わるのを待ち、アプリを終了してから、もう一度実行してください。',
    });
  }

  return blockers;
}

/** ディレクトリ名へ埋め込んでよい版表記（パス区切り・`..` を作れない文字だけ）。 */
const SAFE_VERSION_RE = /^[0-9A-Za-z._-]+$/;

/** 版表記が読めないときにディレクトリ名へ使う代替。 */
export const UNKNOWN_VERSION_LABEL = 'unknown';

/**
 * 版表記をディレクトリ名に埋め込める形へ落とす。
 *
 * これらのパスは rename と再帰削除の対象になる。版の出どころは
 * 「インストール側 package.json の version」と「更新情報ファイルの version」で、
 * 前者は検証を通っていない外部データ（配布 zip の中身）でもありうる。
 * `1.0.0/../../..` のような値をそのまま連結すると、削除対象が親ディレクトリへ脱出する。
 * @param {unknown} version
 * @returns {string}
 */
export function sanitizeVersionForPath(version) {
  const raw = String(version ?? '').trim();
  if (raw === '' || !SAFE_VERSION_RE.test(raw)) return UNKNOWN_VERSION_LABEL;
  return raw;
}

/** 展開先ディレクトリ名の接頭辞。復旧時にパスの妥当性を確かめるのにも使う。 */
export const STAGING_DIR_PREFIX = '.vk-orchestrator-staging-';

/**
 * 展開先に置く「この展開先はどのインストールを入れ替えるためのものか」の記録。
 *
 * 入れ替えは展開先から起動したプロセスが行う（自分のディレクトリを自分で差し替えないため）。
 * そのため入れ替え先はコマンド引数で渡すことになるが、引数をそのまま信じると
 * 任意のディレクトリが rename / 再帰削除の対象になる。展開を用意した側がここへ書き、
 * 入れ替える側が引数と突き合わせることで、意図した組み合わせだけが実行される。
 */
export const STAGE_TARGET_FILENAME = '.vk-orchestrator-update-target';
/** 控えディレクトリ名の接尾辞。復旧時にパスの妥当性を確かめるのにも使う。 */
export const BACKUP_DIR_INFIX = '.backup-';

/**
 * 展開先（staging）ディレクトリのパスを組み立てる。
 * インストールディレクトリの兄弟に置くことで、同一ファイルシステムと原子的な rename を保証する。
 *
 * 版のほかに識別子（通常はプロセス ID）を付ける。展開先が版だけで決まると、
 * 二重起動した更新処理が同じ展開先を掴み、後から始まった側が先に進んでいた側の
 * 展開先を消してしまう（先発が入れ替えの途中なら、インストールが一時的に存在しなくなる）。
 * @param {string} parentDir インストールディレクトリの親
 * @param {string} version 新しい版
 * @param {string|number|null} [uniqueSuffix] 同時実行を区別する識別子
 * @returns {string}
 */
export function stagingDirFor(parentDir, version, uniqueSuffix = null) {
  const safe = sanitizeVersionForPath(version);
  const suffix = uniqueSuffix === null || uniqueSuffix === undefined || uniqueSuffix === ''
    ? ''
    : `-${sanitizeVersionForPath(uniqueSuffix)}`;
  return join(parentDir, `${STAGING_DIR_PREFIX}${safe}${suffix}`);
}

/**
 * 旧インストールを残す backup ディレクトリのパスを組み立てる。
 * 世代は 1 つだけ残す（版名を含めるので、次の更新時に古い世代を消す）。
 * @param {string} installDir
 * @param {string|null} previousVersion
 * @returns {string}
 */
export function backupDirFor(installDir, previousVersion) {
  return `${installDir}${BACKUP_DIR_INFIX}${sanitizeVersionForPath(previousVersion)}`;
}

/**
 * 作業記録に書かれたパスが、いま動いているインストールのものかを確かめる。
 *
 * 復旧処理は毎起動の先頭で必ず走り、記録に書かれたパスを rename / 再帰削除の対象にする。
 * 記録が別のインストール（clone 側と zip 側を併用している等）や書き換えられた内容を
 * 指していた場合、無関係なディレクトリを消してしまう。そこで処理する前に
 *   - installPath が「今動いているインストール」と一致すること
 *   - backupPath / stagedPath が installPath の兄弟で、規定の命名に一致すること
 * を必須にする。外れたら何もしない（安全側）。
 *
 * パスの実体解決（シンボリックリンクの解決）は呼び出し側が行い、ここは比較だけを担う。
 *
 * @param {object} input
 * @param {object|null} input.journal 作業記録
 * @param {string} input.installDir 今動いているインストールの絶対パス（実体解決済み）
 * @param {string} input.recordedInstallDir 記録の installPath（実体解決済み。解決できなければ生値）
 * @param {string[]} [input.allowedStagedParents] 展開先を置いてよい親ディレクトリ
 *   （インストールの親と、親が書けない環境での退避先の 2 通り）
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateUpdateJournalPaths({
  journal,
  installDir,
  recordedInstallDir,
  allowedStagedParents = [],
}) {
  if (!journal || typeof journal !== 'object') return { ok: false, reason: 'no-journal' };

  const install = normalizeDir(installDir);
  const recorded = normalizeDir(recordedInstallDir ?? journal.installPath);
  if (install === null || recorded === null) return { ok: false, reason: 'install-path-unresolved' };
  if (install !== recorded) return { ok: false, reason: 'install-path-mismatch' };

  const parent = dirname(install);
  const base = basename(install);

  const backup = normalizeDir(journal.backupPath);
  if (backup !== null) {
    if (dirname(backup) !== parent) return { ok: false, reason: 'backup-path-outside' };
    if (!basename(backup).startsWith(`${base}${BACKUP_DIR_INFIX}`)) {
      return { ok: false, reason: 'backup-path-unexpected-name' };
    }
  }

  const staged = normalizeDir(journal.stagedPath);
  if (staged !== null) {
    // 展開先は原則インストールの兄弟だが、親が書けない環境ではホーム配下へ退避する。
    // 名前だけを見て場所を見ないと、規定の名前を付けた任意のディレクトリが
    // 「復旧の続行」で install として据えられてしまう（次回起動でその中のコードが動く）。
    // そのため場所と名前の両方を必須にする。
    const stagedParent = dirname(staged);
    const allowed = [parent, ...(Array.isArray(allowedStagedParents) ? allowedStagedParents : [])]
      .map((p) => normalizeDir(p))
      .filter((p) => p !== null);
    if (!allowed.includes(stagedParent)) return { ok: false, reason: 'staged-path-outside' };
    if (!basename(staged).startsWith(STAGING_DIR_PREFIX)) {
      return { ok: false, reason: 'staged-path-unexpected-name' };
    }
  }

  return { ok: true };
}

function normalizeDir(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return resolvePath(trimmed);
}
