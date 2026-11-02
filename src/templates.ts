/**
 * メールの文面づくり。
 *
 * 置き換えの印は `{{name}}` `{{id}}` `{{received}}` `{{site}}` の4つだけ。
 * **置き換えは1回で終わり、置き換えた結果の中の印は見ない**——名前欄に
 * `{{id}}` と書かれても二重に展開しない。
 */

export type TemplateVars = {
	/** 送った人の名前（検証済み・1行） */
	name: string;
	/** 受付ID */
	id: string;
	/** 受け付けた日時（表示用の文字列） */
	received: string;
	/** サイト名 */
	site: string;
};

const PLACEHOLDER = /\{\{\s*(name|id|received|site)\s*\}\}/g;

/**
 * 印を値に置き換える。
 *
 * `replace` に**関数**を渡しているのが肝。文字列を渡すと `$&` などが効いてしまい、
 * 名前に `$` が入っただけで出力が崩れる。
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
	return template.replace(PLACEHOLDER, (_match, key: string) => {
		switch (key) {
			case "name":
				return vars.name;
			case "id":
				return vars.id;
			case "received":
				return vars.received;
			case "site":
				return vars.site;
			default:
				return "";
		}
	});
}

/**
 * 受付日時の表示。
 *
 * 時差は分で渡す（既定は JST の +540）。サイトごとに読む人の居場所が違うので、
 * ここで固定しない。
 */
export function formatReceived(at: Date = new Date(), offsetMinutes = 540, label = "日本時間"): string {
	const shifted = new Date(at.getTime() + offsetMinutes * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日`;
	const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
	return label ? `${date} ${time}（${label}）` : `${date} ${time}`;
}

export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** 送られてきた内容を `<pre>` で包む。整形は捨てずに、タグとしては効かせない。 */
export function asHtmlBody(text: string): string {
	return `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
}

/** 運営者への通知。件名に入力を混ぜない（受信箱の見た目を他人に作らせないため）。 */
export function buildNotifyText(fields: { name: string; email: string; message: string }, id: string, received: string): string {
	return [
		"サイトの問い合わせフォームに新しいご相談が届きました。",
		"",
		`お名前　　　：${fields.name}`,
		`メール　　　：${fields.email}`,
		`受付ID　　　：${id}`,
		`受付日時　　：${received}`,
		"",
		"ご相談内容：",
		fields.message,
	].join("\n");
}

/** 問い合わせた人への確認メール。写しを付けるかは設定に従う。 */
export function buildAutoReplyText(
	body: string,
	vars: TemplateVars,
	message: string,
	includeMessage: boolean,
	heading = "いただいた内容",
): string {
	const rendered = renderTemplate(body, vars);
	if (!includeMessage) return rendered;
	return [rendered, "", "---", `${heading}：`, message].join("\n");
}
