const { Plugin, Notice, MarkdownView } = require("obsidian");
const { spawn, execFile } = require("child_process");

const MENTION = /(?:^|\s)@claude\s+(.+?)\s*$/;
const TIMEOUT_MS = 10 * 60 * 1000;
// No Bash or WebFetch: a note can hold clipped web text, and it must not be able to run commands or send data out.
const ALLOWED_TOOLS = "Read,Edit,Write,Glob,Grep,WebSearch";
const QUESTION_PREFIX = "質問:";

// The hidden id lets a run find its own line even when one note has several running.
const statusLine = (type, text, id) => `> [!${type}] Claude ${text}${id ? ` %%${id}%%` : ""}`;

module.exports = class ClaudeMentionPlugin extends Plugin {
  onload() {
    this.running = new Set();
    this.waiting = 0;
    this.queue = Promise.resolve();
    this.status = this.addStatusBarItem();
    // Enter is the trigger, so pasted, synced, or half-typed mentions never run anything.
    this.registerDomEvent(document, "keydown", (evt) => this.onKeydown(evt), true);
    this.register(() => { for (const child of this.running) child.kill(); });
    this.app.workspace.onLayoutReady(() => this.clearStaleStatus());
  }

  // A reload or quit kills the run before it can remove its own line.
  async clearStaleStatus() {
    const data = (await this.loadData()) || {};
    for (const { path, id } of data.active || []) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) await this.setStatus(file, id, null);
    }
    this.active = [];
    await this.saveData({ active: [] });
  }

  async track(entry, add) {
    this.active = add ? [...(this.active || []), entry] : (this.active || []).filter((e) => e.id !== entry.id);
    await this.saveData({ active: this.active });
  }

  // Goes through the file rather than the editor: an editor that has not yet noticed Claude's write would undo it.
  setStatus(file, id, replacement, removeInstruction = null) {
    return this.app.vault.process(file, (text) => {
      const lines = text.split("\n");
      const at = lines.findIndex((l) => l.includes(`%%${id}%%`));
      if (at < 0) return text;
      if (removeInstruction) this.removeMention(lines, at, removeInstruction);
      const statusAt = lines.findIndex((l) => l.includes(`%%${id}%%`));
      return this.applyStatus(lines, statusAt, replacement);
    });
  }

  // Searches upward because Claude may have written between the mention and its status line.
  removeMention(lines, from, instruction) {
    for (let i = from - 1; i >= 0; i--) {
      const match = lines[i].match(MENTION);
      if (!match || match[1] !== instruction) continue;
      const rest = lines[i].slice(0, match.index);
      // A bare list or quote marker would be an empty bullet, so it goes with the mention.
      if (/^[\s>*+\-\d.]*$/.test(rest)) lines.splice(i, 1);
      else lines[i] = rest;
      return;
    }
  }

  applyStatus(lines, at, replacement) {
    if (replacement) lines[at] = replacement;
    else lines.splice(at, lines[at + 1] === "" ? 2 : 1);
    return lines.join("\n");
  }

  onKeydown(evt) {
    if (evt.key !== "Enter" || evt.isComposing || evt.keyCode === 229) return;
    if (evt.shiftKey || evt.metaKey || evt.ctrlKey || evt.altKey) return;
    if (!(evt.target instanceof Element) || !evt.target.closest(".cm-editor")) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file || !view.editor.hasFocus()) return;
    const instruction = this.mentionAtCursor(view.editor);
    if (!instruction) return;
    const line = view.editor.getCursor().line + 1;
    // Let the newline land first, then save so Claude reads what is on screen.
    window.setTimeout(() => this.enqueue(view, line, instruction), 0);
  }

  mentionAtCursor(editor) {
    const cursor = editor.getCursor();
    const text = editor.getLine(cursor.line);
    if (cursor.ch !== text.length) return null;
    const match = text.match(MENTION);
    if (!match) return null;
    // Writing about @claude in code must not trigger it.
    const before = text.slice(0, match.index + 1);
    if ((before.match(/`/g) || []).length % 2 === 1) return null;
    let fenced = false;
    for (let i = 0; i < cursor.line; i++) {
      if (/^\s*(```|~~~)/.test(editor.getLine(i))) fenced = !fenced;
    }
    return fenced ? null : match[1];
  }

  enqueue(view, line, instruction) {
    const file = view.file;
    const id = `claude-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const entry = { path: file.path, id };
    const queued = this.waiting > 0;
    view.editor.replaceRange(`${statusLine(queued ? "todo" : "info", queued ? "待機中" : "実行中…", id)}\n\n`, { line, ch: 0 });
    view.editor.setCursor(line + 2, view.editor.getLine(line + 2).length);
    const saved = view.save();
    this.track(entry, true);
    this.waiting++;
    this.updateStatus();
    // One at a time, since two runs editing one note would overwrite each other.
    this.queue = this.queue.then(async () => {
      try {
        await saved;
        if (queued) await this.setStatus(file, id, statusLine("info", "実行中…", id));
        const output = await this.runClaude(file.path, line, instruction);
        // A question keeps its mention: the answer run needs the original instruction.
        const asked = output.startsWith(QUESTION_PREFIX);
        await this.setStatus(file, id, null, asked ? null : instruction);
        if (asked) new Notice("Claude: 質問があります。ノートを確認してください", 10000);
        else new Notice(`Claude: 完了\n${output.slice(-300)}`, 10000);
      } catch (err) {
        const reason = err.message.replace(/\s+/g, " ");
        await this.setStatus(file, id, statusLine("failure", `失敗: ${reason}`));
        new Notice("Claude: 失敗しました", 10000);
      } finally {
        await this.track(entry, false);
        this.waiting--;
        this.updateStatus();
      }
    });
  }

  updateStatus() {
    this.status.setText(this.waiting ? `Claude 実行中 (${this.waiting})` : "");
  }

  // Obsidian started from the Dock has a minimal PATH, so ask the login shell.
  shellEnv() {
    if (!this.envPromise) {
      this.envPromise = new Promise((resolve, reject) => {
        const script = 'printf "\\n%s\\n%s" "$PATH" "$(command -v claude)"';
        const child = execFile("/bin/zsh", ["-ilc", script], { timeout: 15000 }, (err, stdout) => {
          const [claude, path] = stdout.trim().split("\n").reverse();
          if (err || !claude) {
            this.envPromise = null;
            reject(new Error("claude コマンドが見つかりません"));
          } else resolve({ claude, path });
        });
        child.stdin.end();
      });
    }
    return this.envPromise;
  }

  async runClaude(path, line, instruction) {
    const { claude, path: PATH } = await this.shellEnv();
    const prompt = [
      `Obsidian Vaultのノート「${path}」の${line}行目に、ユーザーが次の指示を書きました。`,
      `指示: ${instruction}`,
      "まずこのノート全体を読んでから、指示を実行してください。",
      "ノート本文の修正・書き換え・削除・並べ替えを頼まれたら、該当箇所をその場で直接編集してください。修正案や修正内容の説明をノートに追加しないでください。頼まれていない箇所は変更しないでください。",
      "質問への回答や新しく生成する文章など、本文に追加するものを頼まれたら、指示の行の下にMarkdownで書き込んでください。",
      "指示の行と、`> [!info] Claude`や`> [!todo] Claude`で始まる状態表示の行は変更しないでください（どちらも完了後に自動で消えます）。追加する内容は状態表示の行より下に、空行を挟んで書いてください。",
      "",
      "実行に必要な情報が足りず、推測で進めると的外れになる場合は、実行せずに指示の行の下へ次の形式で質問を書いて終了してください。質問は必要最小限にしてください。",
      "> [!question] Claude の質問",
      "> （質問の内容）",
      ">",
      "> 回答は `@claude 回答` と書いてEnter",
      `その場合、最後の報告は「${QUESTION_PREFIX}」で始めてください。`,
      "",
      "今回の指示が、ノート内の「Claude の質問」への回答である場合は、元の指示と回答を踏まえて元の指示を実行してください。結果は元の指示の行があった場所に書き、元の指示の行と解決した質問のブロックは削除してください。今回の回答の行は自動で消えるので変更しないでください。",
      "",
      "最後に、やったことを1文で報告してください。",
    ].join("\n");
    const args = ["-p", prompt, "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS];
    return new Promise((resolve, reject) => {
      const child = spawn(claude, args, {
        cwd: this.app.vault.adapter.getBasePath(),
        env: { ...process.env, PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.running.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = window.setTimeout(() => {
        child.kill();
        stderr = "10分でタイムアウトしました";
      }, TIMEOUT_MS);
      const finish = (settle, value) => {
        window.clearTimeout(timer);
        this.running.delete(child);
        settle(value);
      };
      child.on("error", (err) => finish(reject, err));
      child.on("close", (code) => {
        if (code === 0) finish(resolve, stdout.trim());
        else finish(reject, new Error((stderr || stdout || `終了コード ${code}`).trim().slice(-400)));
      });
    });
  }
};
