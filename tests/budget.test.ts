/**
 * 呼び出し回数の予算の見張り。
 *
 * サンドボックスは1回の実行でホストを **10回**しか呼べないが、
 * **試験のホストには上限が無い**（`wrangler dev` と同じ）。だから
 * 「11回目で落ちる」ことは試験では再現できない。**再現できない制約は、
 * 書き方の規則として見張る。**
 *
 * 2026-11-01、メールの失敗を2回ログへ書いていたため、**失敗のときだけ**
 * 合計が11回になり、理由を書いた記録の書き戻しが落ちた。失敗の記録が、
 * 失敗のときだけ消えていた。
 */

import { describe, expect, it } from "vitest";

// 試験は workerd の中で動くのでファイルを読めない。**中身は束に入れて持ち込む。**
import source from "../src/plugin.ts?raw";

/**
 * `async function 名` から、次の行頭 `}` までを切り出し、**注釈を落とす。**
 * 落とさないと、規則を説明した注釈そのものが規則違反に見える。
 */
function body(name: string): string {
	const start = source.indexOf(`async function ${name}(`);
	expect(start, `${name} が見つからない`).toBeGreaterThan(-1);
	const end = source.indexOf("\n}", start);
	return source
		.slice(start, end)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

describe("呼び出し回数の予算", () => {
	it("メールの段では、ログを書かない", () => {
		// 理由は記録（`notifyError` / `autoReplyError`）に書く。ログは1回を食う。
		const deliver = body("deliverMail");
		expect(deliver).not.toContain("safeLog");
		expect(deliver).not.toContain("ctx.log");
		expect(deliver).toContain("record.notifyError");
		expect(deliver).toContain("record.autoReplyError");
	});

	it("設定の保存でも、ログを書かない", () => {
		// 8件書いた直後は 1+8 で、ログを足すと上限ちょうどになる。
		const save = body("saveSettings");
		expect(save).not.toContain("safeLog");
		expect(save).not.toContain("ctx.log");
	});

	it("送信の受け口は、書き戻しのあとでしかログを書かない", () => {
		const submit = body("handleSubmit");
		// 最後の書き戻しより前に残っていてよいログは、そこで `return` する経路だけ。
		const writeBack = submit.lastIndexOf("storage[COLLECTION].put");
		const logsAfterDeliver = submit.slice(submit.indexOf("deliverMail"), writeBack);
		expect(logsAfterDeliver).not.toContain("safeLog");
	});
});
