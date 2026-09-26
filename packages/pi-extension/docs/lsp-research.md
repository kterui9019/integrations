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

## 2. 汎用リモートプロセストランスポートの feasibility

目的は LSP の実装ではなく、sandbox 内の長寿命プロセスと Pi の間で双方向の stdin/stdout を流せるかの確認。LSP（`typescript-language-server --stdio`）は最初のユースケースとして使う。

- API 比較: `scripts/research/process-apis.mjs`
- PTY 上のプロセス: `scripts/research/pty-process.mjs`（LSP を知らない）
- 最小 LSP クライアント: `scripts/research/lsp-client.mjs`（Daytona を知らない。`{ stdout: AsyncIterable<Uint8Array>, write() }` だけに依存）
- 通しの検証: `scripts/research/remote-process-lsp.mjs`

いずれも `DAYTONA_API_KEY` を設定して `node <script>` で実行する。daemon ソースは §1 と同じ commit `b5a5d9e` の `apps/daemon/pkg/session`・`pkg/toolbox/process/pty` を読んだ。

### 2.1 Daytona のプロセス API

| 要件 | session API（`executeSessionCommand` runAsync + `sendSessionCommandInput` + `getSessionCommandLogs` のストリーム） | PTY API（`createPty` / `connectPty`） |
|---|---|---|
| 長寿命プロセス | ○ | ○（対話ログインシェルを起動し、そこから `exec`） |
| stdin を後から書く | △ 1 回の書き込みごとに HTTP POST。**末尾に `\n` を強制付加**（`"a"` → `61 0a`）。`suppressInputEcho` を付けないと入力が stdout に混ざる | ○ WebSocket。`stty raw -echo` 後はバイト列がそのまま届く。**1 メッセージ 256 KiB でコネクションが落ちる**（64 KiB は届く）ので分割が必要 |
| stdout のリアルタイム stream | ✕ daemon がシェルの `while read -r line` で 1 行ずつラベルを付けるため**行単位でバッファされる**（`printf abc; sleep 3` の `abc` は改行が来るまで 3 秒届かない）。SDK は UTF-8 文字列にデコードして渡す | ○ 32 KiB 単位の生バイト（binary frame）。echo の往復は約 180 ms |
| stderr の分離 | ○ 別ストリーム | ✕ PTY なので stdout と同じストリームになる。ファイルへリダイレクトするしかない |
| プロセス ID | session ID + command ID | PTY session ID（`listPtySessions` で列挙できる） |
| kill | `deleteSession`（プロセスグループごと SIGTERM→SIGKILL） | `kill()`（プロセスツリーに SIGKILL、exit 137） |
| 終了コード | ○ | ○ `wait()`（例: `exit 7` → 7） |
| stdin の EOF | API がない（daemon が stdin の保持プロセスを別に立てている） | API がない。raw モードでは ^D もただのバイトとして届き、プロセスは終了しない。`cat \| cmd` で包み、先頭の `cat` を別コマンドで kill すれば EOF を届けられる（`wc -c` が `5` を出して exit 0） |
| sandbox 再起動後 | session は消える（`session not found`） | PTY は消える（`listPtySessions` が空）。ハンドルはすぐ `isConnected() === false` になる。一方 `wait()` は 5 秒待っても解決しなかった |

補足: session API の streaming で、2 回目の書き込み（`"b"`）の出力が 2.5 秒以内に届かなかったことが 1 回あった。3 session × 10 回の書き込みでは 30/30 届き（log ファイルにも 30 行）、再現しなかった。一時的な遅延だったと見ている。

**session API は byte stream として使えない。** 出力が行単位でバッファされるため、改行で終わらない LSP のメッセージ本文は、次の出力が来るまで届かない（応答待ちでデッドロックする）。さらに入力には `\n` が付加される。

### 2.2 PTY を stdio として使うときの問題と、その対処（すべて実測）

| PTY 固有の問題 | 対処 | 結果 |
|---|---|---|
| echo、行規律（canonical mode）、CR/LF 変換、シグナル文字（^C） | `stty raw -echo` を実行してから `exec` | 改行なし・`\r\n`・`\x03`・UTF-8・1 MB の往復がすべてバイト単位で一致 |
| raw 化する前のプロンプトや、打ったコマンドのエコーが出力に混ざる | sentinel より前の出力を捨てる。sentinel は 2 つに分けて `printf` する（コマンド行のエコーに sentinel がそのまま現れて誤検出した） | sentinel 以降はプロセスの出力だけになる |
| raw 化する前に書いた入力は、エコーされたり行規律で加工されたりする | sentinel を受信するまで書かない | — |
| stderr が混ざる | `2>ファイル` へリダイレクト | stdout は汚れない。stderr はストリームとしては読めない |
| 子プロセスから見て stdin/stdout が TTY になる（色付けやページャなど、TTY かどうかで挙動を変える CLI がある） | `cat \| cmd \| cat` で包む | 子からはパイプに見え、往復遅延（約 170 ms）もバッファリングも変わらない |
| 大きな書き込みでコネクションが落ちる | 64 KiB 単位に分割して送る。分割した書き込みの途中に別の書き込みが割り込むと frame が壊れる（200 KB を 2 つ並行に書くと chunk が交互に届いた）ので、write 単位でキューに積んで直列化する | 4 MiB を約 1.8 秒で送れる。並行に書いた 200 KB × 2 も、呼んだ順にそのまま届く |
| 切断の検知 | `wait()` ではなく `isConnected()` と request のタイムアウトで判定する | sandbox の stop 直後に `isConnected() === false` |

### 2.3 LSP での検証（`remote-process-lsp.mjs`、すべて成功）

| 検証 | 結果 |
|---|---|
| `initialize` / `initialized` | 23 個の capability（definition / references / hover / rename など）。往復約 200 ms |
| `textDocument/didOpen` → `publishDiagnostics`（server → client の通知） | main.ts の TS2322 を受信 |
| `textDocument/definition` | main.ts の `UserRepository` → user.ts の宣言（約 200 ms） |
| `textDocument/references` | 宣言と呼び出しの 2 か所 |
| `textDocument/hover` | `const repo: UserRepository` |
| 既存の Daytona `edit` ツールで user.ts を編集 → `didChange` なし | server は古い open バッファのまま（client が所有するドキュメントなので、LSP として正しい挙動） |
| `didChange`（全文、version 2） | 変更していない main.ts にもクロスファイルの TS2339 が push され、definition も新しい行を指す |
| main.ts を編集 → `didChange` v2 | diagnostics が空になる |
| client が切断（Pi 終了を想定） | プロセスは sandbox 内で動き続け（`listPtySessions` に残る）、`connectPty` で再接続すると server の状態もそのまま使える |
| sandbox stop → start | 旧ハンドルは無効（request は失敗、`write` は `not connected`）。再 spawn + `initialize`（約 200 ms）+ client 側で保持していたドキュメントをディスクから開き直すと、definition も diagnostics も最新になる |

### 2.4 復旧の必要条件（sandbox の再起動・Pi の resume）

- 検知: `isConnected() === false`、または request のタイムアウト。`wait()` は使えない。
- 再生成: sandbox を起動し（既存の `withRecovery` の範囲）→ 新しい PTY で再 spawn → `initialize` / `initialized` → client が保持している open ドキュメントを、version を振り直してディスクの内容で `didOpen` し直す。
- Pi の resume（sandbox が動いている場合）: 2 通りある。
  - `connectPty(id)` で再接続する。server の状態が残るので速いが、前の client がどのドキュメントを開いていたかを知らない。
  - kill して再 spawn する。単純で状態がきれいになる。
  
  どちらにしても、Pi が異常終了するとプロセスが sandbox 内に残るので、`session_start` で ID プレフィックス（`pi-rp-`）を付けた PTY を `listPtySessions` から見つけて回収する必要がある。

## 3. アーキテクチャ判断

**A（既存 API だけで実現可能）。ただし PTY を使い、§2.2 の PTY 固有の問題を transport 層で吸収することが条件。**

- session API（パイプ）は行バッファと `\n` の付加があるため、byte stream としては使えない。
- PTY は、そのままでは stdio として安全ではない（B の懸念はその通り）。しかし `stty raw -echo`・sentinel・stderr のリダイレクト・64 KiB 分割と write の直列化・パイプで包む、の 5 点で、今回の検証範囲ではバイト単位で一致し、LSP の全フロー（push 通知、didChange、definition / references / hover）が動いた。
- 残る制約: stderr をストリームとして読めない。stdin の EOF は、パイプで包んで feeder を kill する回避策でしか送れない。1 往復に約 180〜200 ms（Daytona までのネットワーク往復が支配的）。

### 構成（§4 で実装済み）

```text
Pi extension
├── src/remote-process.ts   RemoteProcess（PTY 実装。LSP を知らない）
│     spawnRemoteProcess(sandbox, command, { id, cwd, env }) → { write, stdout, kill, isConnected }
│     raw 化・sentinel・stderr のリダイレクト・64 KiB 分割と write の直列化・ID プレフィックスでの回収
├── src/lsp-client.ts       JSON-RPC の frame 処理・request・通知の購読（transport を知らない）
└── src/lsp.ts              ドキュメント同期・diagnostics・復旧・lsp ツール
```

interface は、PTY 実装で提供でき、かつ使うものだけにした（`write` / `stdout` / `kill` / `isConnected`）。`stderr` はストリームで提供できず、`wait()` は sandbox 停止時に解決しないので持たせていない。

### Daytona upstream への feature request（C の観点。PTY の回避策を不要にする最小 API）

session API に「raw（パイプ）モード」を足すだけで、PTY の回避策はすべて不要になる。

| 最小 API | 現状 | 必要な変更 |
|---|---|---|
| spawn（パイプ、TTY なし） | `executeSessionCommand({ runAsync })` がある | 変更なし |
| stdin への生の書き込み | `sendInput` が `\n` を付加する | `raw: true` で付加しない（バイナリなら WebSocket で受ける） |
| stdout / stderr の生ストリーム | 行単位のラベル付け（シェルの `read -r line`） | `read` によるラベル付けをやめ、stdout と stderr をそれぞれ独立したバイトストリームとして WebSocket で流す |
| stdin の close（EOF） | なし | `closeInput(sessionId, commandId)` |
| kill / 終了コード | `deleteSession` / exitCode ファイル | 変更なし（1 command 単位の kill があるとよりよい） |

## 4. 本実装（`lsp` ツール）

`--daytona` セッションでのみ登録される。actions: definition / references / hover / rename（ファイルを編集する）/ diagnostics / document_symbols / workspace_symbols / status。位置は 1-based の `line` と、その行にある `symbol` 名で指定する（列を数えなくてよい）。テスト: `npm run test:lsp`（オフライン、fake PTY + fake language server）、`npm run test:lsp-live`（実 sandbox）。

| 決めたこと | 理由（実測） |
|---|---|
| 初回の呼び出しで spawn し、以後は使い回す | TypeScript は初回が約 4 秒（spawn + initialize + project ロード）、2 回目以降は約 0.2〜0.6 秒 |
| tsls に `initializationOptions.tsserver.useSyntaxServer: 'never'` を渡す | 構文専用 tsserver が project のロード中に応答し、definition が宣言ではなく import のバインディングを返した（約 3 秒後には正しくなる）。全 request を semantic server に回せば初回から正しい |
| TypeScript の diagnostics は `workspace/executeCommand` の `typescript.tsserverRequest`（`syntacticDiagnosticsSync` + `semanticDiagnosticsSync`）で pull する | tsls は pull diagnostics を持たず、push 通知には `version` が付かない。user.ts と main.ts を続けて変更すると、main.ts の変更前に計算された push が変更後に届き、古い結果を最新と誤認した（rename 後に TS2339 が残った）。tsserver の request は順序通りに処理されるので、直前の `didChange` を必ず反映する |
| Python（pylsp）の diagnostics は push を使い、`version` で新旧を判定する | pylsp は変更したドキュメントだけに `version` 付きで push する。デフォルト snapshot の pylsp には lint plugin がない（jedi のみ）ので、diagnostics には `pyflakes` などの追加が必要 |
| edit / write ツールの書き込みは、その場でサーバーに送る（`fileWritten`）。open 中のファイルは、各呼び出しの前に `md5sum` 1 回で sandbox と照合する | edit 直後の diagnostics（ファイルをまたぐものも含む）が即座に正しくなる。bash で変えたファイル（`sed`・`git checkout`・フォーマッタ）も次の呼び出しで反映される。一度も開いていないファイルは、サーバー自身のファイル監視（約 2 秒）に任せる |
| 同期と request は 1 サーバーにつき直列に実行する | 並行したツール呼び出しで、didOpen の二重送信や version の逆転を起こさない |
| 復旧は 1 回だけ: `isConnected()` が false、または接続が閉じていたら再 spawn する（sandbox が止まっていれば `withRecovery` で起動する） | idle による一時停止（デフォルト 15 分）は日常的に起きる。再 spawn 後は、次の呼び出しで必要なファイルを開き直すだけで足りる |
| 最初の spawn の前に、`pi-lsp-` で始まる PTY を kill する。`session_shutdown` でも kill する | Pi が異常終了すると、サーバーは sandbox 内で動き続ける（§2.3）。sandbox は session ごとなので、残っているものは前回の Pi のもの |
| バイナリの有無を `command -v` で先に確認し、なければインストール方法を返す。初期化に失敗したら stderr ログの末尾を添える | `exec` の失敗は stderr のリダイレクト先に消え、initialize のタイムアウトとしか見えなくなる |
| `lsp` の呼び出しが 5 分なかったら、サーバーを停止する（同時に動いている呼び出しがすべて終わってから数える） | PTY の WebSocket がつながっている間、sandbox は idle で一時停止しない。autoStop 1 分での実測: PTY 接続あり → 240 秒後も `started`、PTY なし（対照）→ 約 90 秒で `stopped`、PTY プロセスは残して WebSocket だけ切断 → 約 90 秒で `stopped`。したがって、止まらなくなる原因は接続であり、異常終了した Pi が残したサーバーは一時停止を妨げない |
| rename は、読み取りだけの計画（rename request と元内容の読み込み）と書き込みに分ける。書き込みは自動リトライしない。途中で失敗したら書き込み済みのファイルを元に戻し、戻せなかったファイルはエラーに列挙する | 書き込みの途中でサーバーが落ちたときに rename 全体を再実行すると、元の名前がもう無いため失敗し、一部のファイルだけが改名済みのまま残った |
| transport は SDK の `PtyHandle.wait()` を使わず、`isConnected()` を監視する（unref したタイマー。切断・kill で止める）。kill では自分側の WebSocket も閉じる | `wait()` は exit code が届くまで 100 ms ごとにタイマーを張り直す。sandbox の停止で接続だけが切れると exit code は来ないので、Node のプロセスが終了しなくなり、stdout も閉じなかった |

### 残り

- Daytona に session API の raw モードを提案する（§3）。採用されたら `remote-process.ts` の実装だけを差し替える。
- diagnostics はサーバーが開いたファイルだけが対象。プロジェクト全体は `tsc --noEmit` などを bash で実行する。
