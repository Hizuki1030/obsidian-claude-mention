# Claude Mention

Obsidianのノートに `@claude 指示` と書いて行末でEnterを押すと、Claude Codeがノート全体を読んで指示を実行するプラグインです。

## 必要なもの

- Obsidian デスクトップ版
- [Claude Code](https://claude.com/claude-code)（`claude` コマンドにログイン済みであること）

## インストール

`main.js` と `manifest.json` を `<Vault>/.obsidian/plugins/claude-mention/` に置き、Obsidianの設定でコミュニティプラグインの「Claude Mention」を有効にします。

## 使い方

```
@claude 議事録の節をですます調に直して
```

- 本文の修正・削除・並べ替えは、該当箇所をその場で編集します。
- 回答や新しい文章は、指示の位置に書き込みます。
- 実行中は指示の下に状態が出て、完了すると状態と指示の行が消えます。失敗時は理由を表示し、指示の行を残します。
- 情報が足りないとClaudeが質問をノートに書きます。`@claude 回答` と書いてEnterを押すと続行します。

貼り付けや同期で入った文字列、コードブロック内、Shift+Enter、行の途中でのEnterでは実行しません。

## 権限

許可するツールは Read、Edit、Write、Glob、Grep、WebSearch です。編集は確認なしで反映され、対象はVault内のファイルです。ノートにWebから取り込んだ文章が混ざっていても悪用されにくいよう、Bash と WebFetch は許可していません。

## 注意

- 実行後のCmd+Zでは元に戻りません。Obsidianの「ファイル復元」を使ってください。
- 実行のたびにClaude Codeの利用枠を消費します。
- 1回の実行は10分で打ち切ります。複数の指示は順番に実行します。
- Obsidianの別ウィンドウに切り離したノートでは動きません。
