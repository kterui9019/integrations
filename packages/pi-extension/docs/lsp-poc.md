# Daytona ネイティブ LSP PoC — 調査結果と設計メモ

Pi（ローカル）から Daytona sandbox 内の language server を使う `lsp` ツールを、Daytona ネイティブ LSP API だけで実装した PoC の結果。

- 実装: `src/lsp.ts`（`LspManager`）、`src/tools.ts`（`lsp` ツール登録）
- テスト: `scripts/lsp.mjs`（オフライン、`npm run test:lsp`）、`scripts/lsp-live.mjs`（実 sandbox、`npm run test:lsp-live`）
- 検証環境: `@daytona/sdk` 0.184.0（最新 0.218.0 も LSP 面は同一）、デフォルト snapshot（typescript-language-server 5.1.3 / TypeScript 5.9.3 / Node 25.9.0）

## 既存拡張のアーキテクチャ（前提）

- sandbox は `session_start` で作成、または session entry（`daytona-session`）の `sandboxId` から `dt.get()` で再接続する。fork は常に新規 sandbox。
- 作業ディレクトリ `active.cwd` = `$HOME/<repo>`（clone 先）または `$HOME/workspace`。LSP の project root はこれをそのまま使う。
- ツールは `registerTools(pi, getActive)` で登録し、呼び出しごとに `getActive()` を引く。`--daytona` 有効かつ sandbox なしの場合はエラーにし、ホストでは絶対に実行しない。
- 停止した sandbox は `withRecovery` が状態を確認して `start()` し、1 回だけリトライする。削除済みなら `SandboxUnavailableError`。
- 終了時に sandbox は削除せず、autoStop で pause させて resume 用に残す。in-memory session だけ即削除する。

ベースライン（変更前）: `typecheck` / `smoke` / `test:no-sync` すべて成功。

## Daytona ネイティブ LSP の実挙動

SDK 実装（`LspServer.js`）、toolbox API（`/lsp/*` 7 エンドポイント）、公式ドキュメント、daemon ソース（`daytonaio/daytona` `apps/daemon/pkg/toolbox/lsp`、commit `b5a5d9e` 2026-06-23 時点。現在の公開リポジトリ HEAD は README のみ）、実 sandbox での挙動で確認した。

| 項目 | 実挙動 | 根拠 |
|---|---|---|
| project root | `createLspServer('typescript', cwd)` で bash/read/edit と同じ checkout を root にできる | live |
| 依存解決 | sandbox の `node_modules` / `tsconfig.json` で解決される（sandbox にしか存在しないパッケージの型でも補完が出る） | live |
| 未 start | `server not initialized`（HTTP 400、`DaytonaValidationError`）。エラーコードはなく、メッセージ文字列で判別するしかない | live |
| `start()` | daemon 側で初期化済みなら no-op（冪等） | live, source |
| workspace symbols | 開いているドキュメントが 1 つもないと `No Project.` エラー。検索対象は開いたファイルが属する tsconfig project のみ。空クエリは 400 | live |
| document symbols | `didOpen` していないファイル、相対パス、存在しないファイルは、いずれもエラーにならず `[]` を返す | live |
| URI | SDK が `'file://' + path` を組み立てるため、相対パスは壊れた URI になる。絶対パス必須 | source, live |
| `didOpen` | daemon がディスクから読んで `version: 1` 固定で送る。同じドキュメントを close せずに再度 open すると無視され、古い内容のまま残る | source, live |
| `didChange` | 存在しない | SDK, API, source |
| ファイル変更 | 開いているドキュメント: 編集後も古い内容のまま。`didClose`→`didOpen` で反映される。開いていないファイル: tsserver のファイル監視で自動反映（新規ファイルも約 2 秒で反映） | live |
| daemon の状態 | daemon プロセス内のシングルトン map（`languageId:pathToProject` がキー）。SDK のハンドルを新しくしても同じ server に繋がる。前 session で開いたドキュメントも開いたまま残る | source, live |
| sandbox stop→start | daemon ごと消える。旧ハンドルは `server not initialized`。`start()` 後も再度 `didOpen` しないと `No Project.` | live |
| server プロセス死亡 | `jsonrpc2: connection is closed`。daemon は初期化済みと認識しているため `start()` は no-op。`stop()` は 500 を返すがエントリは消えるので、その後の `start()` で復旧する | live |
| `stop()` | `shutdown` を request ではなく notification で送り、`exit` も送らないため、プロセスが残る（stop 後も `typescript-language-server` が生存） | source, live |
| completions | メンバー補完・識別子補完は動く。ただし project の初回ロード直後の数秒は `[]`（その後は close→open 直後でも返る）。namespace import のメンバー（`import { z } from 'zod'` の `z.`、`import * as dep` の `dep.`）は待っても 0 件（原因未特定）。フィルタなしで 1000 件超を返す | live |
| diagnostics | server→client 方向の通知（`publishDiagnostics` 等）は daemon のハンドラが捨てる。pull 型のエンドポイントもない | source |
| 言語 | SDK は `typescript` / `javascript` / `python` を受け付ける。daemon の `Get` は `javascript` を unsupported として拒否し、`Start` は map に無いキーを常に TypeScript server で作る（Python を最初に `start()` すると TS server が起動する） | source（live 未検証） |

## 実装の要点（上記の実挙動から決めたこと）

- 遅延起動: `LspManager.getOrCreate` は最初のクエリ時に `createLspServer` + `start()` する。`status` では起動しない。
- ドキュメントは常に「`didClose` → `didOpen` → クエリ → `didClose`」の一時 open にする（`withDocument`）。`didChange` がなく再 open も無視されるので、ディスクの最新内容を確実に読ませる方法はこれしかない。前 session が残した open 状態もこれで消える。
- workspace symbols は anchor ファイル（`src/` 優先で最初のソース）を一時 open してから検索する。monorepo で別 project を検索したいときは `path` を指定する。
- 復旧は 1 回だけ: `withRecovery`（sandbox 停止）の内側で、`server not initialized` なら `start()`、`connection is closed` なら `stop()`+`start()` してからリトライする。
- Pi resume では `Sandbox` オブジェクトが新しくなるので、LSP クライアントも作り直す（daemon 側の server が生きていれば `start()` は no-op）。
- ローカル fallback はしない。sandbox がなければエラーにする。
- `dispose()` は作っていない。`stop()` はプロセスをリークさせ、sandbox は resume 用に残すので、止めても得るものがない。

## capability matrix

| Operation | 最終形に必要 | Daytona の対応 |
|---|---:|---|
| Workspace symbols | Yes | △ あり。open ドキュメント必須、open 中 project のみが対象 |
| Document symbols | Yes | △ あり。フラットな一覧（階層なし、`containerName` なし）。未 open なら黙って `[]` |
| Completions | Useful | △ あり。起動直後は空、namespace メンバーは 0 件、resolve（ドキュメント取得）なし |
| Go to definition | Yes | ✕ なし |
| Find references | Yes | ✕ なし |
| Hover | Useful | ✕ なし |
| Diagnostics | Yes | ✕ なし（push 通知は daemon が捨てる） |
| Rename | Nice to have | ✕ なし |
| Document change notification | Important | ✕ `didChange` なし（`didClose`→`didOpen` で代用） |

## Option A: Daytona ネイティブ LSP を拡張する

```text
Pi → @daytona/pi → Daytona LSP API → sandbox 内 language server
```

必要な Daytona 側の変更:

- エンドポイント追加: `definition` / `references` / `hover` / `rename`（`textDocument/*` の request を中継するだけ）。
- diagnostics: daemon が `publishDiagnostics` を URI ごとに保持して返す（状態を持つ設計変更）か、`textDocument/diagnostic`（pull）の中継。
- `didChange`（または `didOpen` 時に open 済みなら close してから開き直す daemon 側の修正）。
- `stop()` の修正（`shutdown` を request に、その後 `exit`）、エラーコード（未初期化とプロセス死亡の区別）、`start()` が languageId を無視するバグの修正。
- 汎用の `request(method, params)` 中継エンドポイントを 1 つ足せば、個別エンドポイントを増やさずに済む。

利点: sandbox ライフサイクル・認証・プロキシを既存のまま使える。拡張側はステートレスに近い。
欠点: daemon・API・SDK のリリースが必要で、この拡張だけでは完結しない（daemon の公開ソースも現在は README のみ）。メソッドを増やすたびに Daytona 側の変更が要る。

## Option B: 汎用リモートプロセストランスポート

```text
Pi LSP client → remote process transport → sandbox → typescript-language-server --stdio
```

SDK には長寿命プロセス向けの部品がある: session command の非同期実行 + `sendSessionCommandInput`（stdin）+ `getSessionCommandLogs` のストリーミング、および WebSocket PTY（`createPty` / `sendInput`）。LSP の `Content-Length` フレーミングを欠落・改変なく双方向に流せるか（PTY の改行変換やエコー、stdin 送信が 1 リクエスト 1 HTTP であることの遅延など）は未検証。

利点: LSP の全機能（diagnostics の push、didChange、任意の request）が使える。DAP・watch・dev server にも流用できる。
欠点: トランスポートの信頼性（再接続、sandbox 停止時のプロセス消失、順序保証）をすべて拡張側で持つことになる。今回の PoC の範囲外。

## 推奨

**Daytona のネイティブ LSP API だけでは、Pi のコーディングエージェント用途には足りない。** 現状使えるのはシンボル検索・アウトライン・補完だけで、エージェントに必要な definition / references / diagnostics がない。補完も起動直後の空応答や namespace メンバー 0 件の問題があり、単独では信頼できない。

次の一手:

1. 当面は現 PoC（workspace/document symbols 中心）を experimental のまま出す。grep より正確な「宣言の場所」検索としては今でも役に立つ。
2. Daytona に Option A の最小セットを提案する: 汎用 `request` 中継（definition / references / hover / rename をまとめてカバー）、diagnostics の保持、`didChange`、`stop()` とエラーコードの修正。daemon の変更量は小さく、この拡張側の `LspManager` はそのまま使える。
3. Daytona 側の対応が見込めない場合に限り、Option B を検討する。その前に、session command の stdin/stdout で LSP フレーミングが往復できるかを小さく検証する（今回は未実施）。
