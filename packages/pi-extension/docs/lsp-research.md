# Pi Daytona 拡張の LSP 調査メモ

Pi（ローカル）から、Daytona sandbox 内の checkout・依存関係に対して language server を使うための調査結果。

## 1. Daytona ネイティブ LSP API

### 結論

**Pi のコーディングエージェント用途には足りない。** definition / references / hover / diagnostics / rename / didChange が、SDK（0.184.0 と最新 0.218.0）・toolbox API・daemon のどの層にも存在しない。このため、ネイティブ LSP API を拡張していく方針はいったん止める。

### 検証方法

- SDK の `LspServer` 実装と toolbox API（`/lsp/*` の 7 エンドポイント: start / stop / did-open / did-close / document-symbols / workspacesymbols / completions）
- daemon ソース（`daytonaio/daytona` `apps/daemon/pkg/toolbox/lsp`。commit `b5a5d9e`（2026-06-23）時点。現在の公開リポジトリ HEAD は README のみ）
- 公式ドキュメント（https://www.daytona.io/docs/en/language-server-protocol/）
- 実 sandbox での挙動: `scripts/research/native-lsp-probe.mjs`（観測した挙動を assert で固定している。失敗したら Daytona 側の挙動が変わったということ）
- workspace/document symbols と completions を返す `lsp` ツールを実装した PoC: ブランチ `poc/pi-extension-native-lsp`（本実装には入れていない）

検証環境: デフォルト snapshot（typescript-language-server 5.1.3 / TypeScript 5.9.3 / Node 25.9.0）

### 実挙動

| 項目 | 実挙動 | 根拠 |
|---|---|---|
| project root | `createLspServer('typescript', cwd)` で、bash/read/edit と同じ checkout を root にできる | live |
| 依存解決 | sandbox の `node_modules` / `tsconfig.json` で解決される（sandbox にしか存在しないパッケージの型でも補完が出る） | live |
| 未 start | `server not initialized`（HTTP 400、`DaytonaValidationError`）。エラーコードはなく、メッセージ文字列で判別するしかない | live |
| `start()` | daemon 側で初期化済みなら no-op（冪等） | live, source |
| workspace symbols | 開いているドキュメントが 1 つもないと `No Project.` エラー。検索対象は、開いたファイルが属する tsconfig project のみ。空クエリは 400 | live |
| document symbols | `didOpen` していないファイル、相対パス、存在しないファイルは、いずれもエラーにならず `[]` を返す | live |
| URI | SDK が `'file://' + path` で組み立てるため、相対パスは壊れた URI になる。絶対パス必須 | source, live |
| `didOpen` | daemon がディスクから読み、`version: 1` 固定で送る。close せずに同じドキュメントを再度 open すると無視され、古い内容のまま残る | source, live |
| `didChange` | 存在しない | SDK, API, source |
| ファイル変更 | 開いているドキュメントは、編集後も古い内容のまま（`didClose`→`didOpen` で反映）。開いていないファイルは tsserver のファイル監視で反映されるが、約 2 秒遅れる | live |
| daemon の状態 | daemon プロセス内のシングルトン map（キーは `languageId:pathToProject`）。SDK のハンドルを作り直しても同じ server に繋がり、前 session で開いたドキュメントも開いたまま残る | source, live |
| sandbox stop→start | daemon ごと消える。旧ハンドルは `server not initialized`。`start()` した後も、再度 `didOpen` しないと `No Project.` | live |
| server プロセス死亡 | `jsonrpc2: connection is closed`。daemon は初期化済みと認識しているため、`start()` は no-op。`stop()` は 500 を返すがエントリは消えるので、その後の `start()` で復旧する | live |
| `stop()` | `shutdown` を request ではなく notification で送り、`exit` も送らないため、プロセスが残る | source, live |
| completions | メンバー補完・識別子補完は動く。ただし project の初回ロード直後の数秒は `[]` を返す。namespace import のメンバー（`z.`、`dep.`）は待っても 0 件（原因未特定）。フィルタなしで 1000 件超を返す | live |
| diagnostics | server→client 方向の通知（`publishDiagnostics` 等）は daemon のハンドラが捨てる。pull 型のエンドポイントもない | source |
| 言語 | SDK は `typescript` / `javascript` / `python` を受け付ける。一方 daemon の `Get` は `javascript` を unsupported として拒否し、`Start` は map に無いキーを常に TypeScript server で作る | source（live 未検証） |

### capability matrix

| Operation | 最終形に必要 | Daytona の対応 |
|---|---:|---|
| Workspace symbols | Yes | △ あり。open ドキュメント必須、open 中の project のみが対象 |
| Document symbols | Yes | △ あり。フラットな一覧（階層なし、`containerName` なし）。未 open なら黙って `[]` |
| Completions | Useful | △ あり。起動直後は空、namespace メンバーは 0 件、resolve なし |
| Go to definition | Yes | ✕ なし |
| Find references | Yes | ✕ なし |
| Hover | Useful | ✕ なし |
| Diagnostics | Yes | ✕ なし（push 通知は daemon が捨てる） |
| Rename | Nice to have | ✕ なし |
| Document change notification | Important | ✕ `didChange` なし（`didClose`→`didOpen` で代用） |

### ライフサイクルの知見（トランスポートを変えても引き継ぐもの）

- sandbox の stop/start で、sandbox 内のプロセスとサーバー状態はすべて消える。ハンドルは作り直し、ドキュメントは開き直す必要がある。
- Pi の resume では `Sandbox` オブジェクトが新しくなる。一方、sandbox が動き続けていれば、sandbox 側の状態は残っている。前のクライアントが開いたままにしたドキュメントなどが残るので、再利用するなら状態を知らない前提で扱う。
- 停止した sandbox は、既存の `withRecovery` の範囲（状態を確認して `start()`、1 回リトライ）で扱える。LSP 固有の復旧はその内側で 1 回だけ行う。
- Daytona 側のエラーにはコードがなく、判別はメッセージ文字列頼みになる。
