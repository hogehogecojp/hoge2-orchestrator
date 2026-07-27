// -------------------------------------------------------
// ready ディスパッチ（共通ヘルパー）
// -------------------------------------------------------
// loopBody() の `status:ready` 起動判定をテスト可能にするための薄いヘルパー。
//
// 背景: ready issue の起動は、inFlightIssues によるプロセス内二重起動ガード、
// sequential ラベルによる同一作業対象リポジトリの直列化、startTask の撃ちっぱなし起動、
// そして同 tick 内の後続 sequential タスクを待たせる occupiedRepos 更新が絡む。
// この判定を index.js にインラインのまま置くと、GitHub API 失敗時の再ディスパッチ
// など副作用順序に依存する回帰をユニットテストしづらいため、done-gate.js や
// pane-resume.js と同じく GitHub / state / VK Terminals への副作用を DI で受け取る。

/**
 * ready issue を順にディスパッチする。
 *
 * @param {Array<object>} issues status:ready のタスク登録リポジトリ側 issue
 * @param {object} deps
 * @param {Set<number>} deps.inFlightIssues 起動処理中 issue 番号の Set
 * @param {Set<string>} deps.occupiedRepos sequential 判定用の作業中 repoKey Set
 * @param {function} deps.getTargetRepoKey (issue) => "owner/repo"|null
 * @param {function} deps.isSequential (issue) => boolean
 * @param {function} deps.startTask (issue) => Promise<boolean>
 * @param {function} deps.getTask (issueNumber) => Promise<object|null>
 * @param {function} deps.getStates (port) => Promise<object>
 * @param {function} deps.setStatus (issueNumber, label) => Promise<void>
 * @param {function} deps.formatErrorSummary (err) => string
 * @param {object} [options]
 * @param {number} [options.port] VK Terminals API ポート
 * @param {object} [options.logger=console] console 互換オブジェクト
 * @returns {Promise<void>}
 */
export async function dispatchReadyIssues(issues, deps, options = {}) {
  const {
    inFlightIssues,
    occupiedRepos,
    getTargetRepoKey,
    isSequential,
    startTask,
    getTask,
    getStates,
    setStatus,
    formatErrorSummary,
  } = deps;
  const { port, logger = console } = options;

  let terminalTerms = null;
  let terminalStatesLoadAttempted = false;
  let terminalStatesLoadFailed = false;

  // state.json に termId が残る ready issue がある場合だけ VK Terminals states を取得する。
  // issue ごとに API を叩くと dispatch 件数に比例して負荷と失敗面が増えるため、
  // 同じ tick 内では成功・失敗どちらも 1 回の結果を共有する。
  async function loadTerminalTermsOnce() {
    if (terminalStatesLoadAttempted) return terminalStatesLoadFailed ? null : terminalTerms;
    terminalStatesLoadAttempted = true;
    try {
      const states = await getStates(port);
      terminalTerms = states?.terminals ?? {};
      return terminalTerms;
    } catch (err) {
      terminalStatesLoadFailed = true;
      logger.warn(`[poll] VK Terminals states 取得失敗（termId 記録済み ready の起動を今回は見送り）: ${err.message}`);
      return null;
    }
  }

  for (const issue of issues) {
    if (inFlightIssues.has(issue.number)) {
      logger.log(`[poll] issue #${issue.number} は起動処理中のためスキップ`);
      continue;
    }

    const repoKey = getTargetRepoKey(issue);

    let saved = null;
    try {
      saved = await getTask(issue.number);
    } catch (err) {
      logger.warn(`  [poll] issue #${issue.number}: state 取得失敗（通常起動で続行）: ${err.message}`);
    }

    // GitHub API の一時障害で startTask 内の status:in-progress 遷移だけが失敗すると、
    // ペイン作成済み・state 記録済みなのに issue は ready のまま残る。ここで生存ペインを
    // 確認できた場合は新規ペインを作らず、ラベル遷移だけを再試行して収束させる。
    if (saved?.termId != null) {
      const terms = await loadTerminalTermsOnce();
      if (!terms) {
        logger.warn(
          `  [poll] issue #${issue.number}: termId:${saved.termId} の生死判定ができないため今回の起動を見送り`
        );
        continue;
      }

      const term = Object.values(terms).find(t => String(t.termId) === String(saved.termId));
      if (term) {
        try {
          await setStatus(issue.number, 'status:in-progress');
          logger.log(
            `  [poll] issue #${issue.number}: 既存ペイン(termId:${saved.termId})を確認 → in-progress 遷移を再試行`
          );
          if (repoKey) occupiedRepos.add(repoKey);
        } catch (err) {
          logger.warn(
            `  [poll] issue #${issue.number}: in-progress 遷移の再試行失敗（次ループ再試行）: ${err.message}`
          );
        }
        continue;
      }
    }

    // sequential ラベル付き issue は、同じ作業対象リポジトリのタスクが作業中なら
    // 起動を見送り、次のポーリングで再評価する。別 repo・汎用・ラベル無しは即起動。
    // ただし生存済みペインの in-progress 再試行は上で先に済ませる。これは新規起動ではなく、
    // GitHub ラベルだけ失敗したタスクを収束させる処理なので sequential 待機の対象にしない。
    if (isSequential(issue) && repoKey && occupiedRepos.has(repoKey)) {
      logger.log(
        `[poll] issue #${issue.number} (${repoKey}): 同じ作業対象リポジトリのタスクが作業中のため待機`
      );
      continue;
    }

    // 起動は撃ちっぱなし（ペイン作成＋送信＋state 記録で完了）。
    // inFlightIssues は「status:in-progress 反映前に並行 loop が同じ ready を拾う」レース対策。
    inFlightIssues.add(issue.number);
    try {
      const started = await startTask(issue);
      // 同ティック内の後続 sequential タスクを待たせるため occupied に追加
      if (started && repoKey) occupiedRepos.add(repoKey);
    } catch (err) {
      logger.error(`[poll] issue #${issue.number} 起動エラー: ${formatErrorSummary(err)}`);
    } finally {
      inFlightIssues.delete(issue.number);
    }
  }
}
