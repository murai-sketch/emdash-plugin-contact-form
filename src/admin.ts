/**
 * 管理画面の表示（Block Kit）。
 *
 * sandboxed プラグインは**ブラウザで動かない。**画面は「こういう部品を並べて」
 * という JSON を返し、EmDash 側が描く。だからここには DOM も React も出てこない。
 *
 * 置いている面は3つ。
 * - ダッシュボードのウィジェット（`inbox`）…… 未読の数と直近の1件
 * - 「問い合わせ」ページ（`/messages`）…… 一覧と、1件の中身
 * - 「設定」ページ（`/settings`）…… 足りない設定と、サイトに貼る雛形
 */

import type { Settings } from "./settings";

export type StoredMessage = {
	name: string;
	email: string;
	message: string;
	status: "new" | "read";
	createdAt: string;
	notified: boolean;
	autoReplied: boolean;
	notifyError?: string;
	autoReplyError?: string;
	/** メールの段そのものが落ちたときの理由（投げられた中身） */
	mailStageError?: string;
	/** そのとき sandbox に何が渡っていたか。**秘密は入れない。型の名前だけ** */
	mailDiag?: string;
};

type Block = Record<string, unknown>;
export type BlockResponse = {
	blocks: Block[];
	toast?: { message: string; type?: "success" | "error" | "info" };
};

export const MESSAGES_PAGE = "/messages";
export const SETTINGS_PAGE = "/settings";
export const WIDGET_ID = "inbox";

/** 一覧に出す1ページ分。Block Kit の表は100行までなので、それより十分に小さく保つ。 */
export const PAGE_SIZE = 20;

function shorten(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 日時の表示。保存は UTC の ISO で、読む人のために時差をずらして出す。 */
export function showDate(iso: string, offsetMinutes = 540): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const shifted = new Date(at.getTime() + offsetMinutes * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
		`${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
	);
}

/**
 * 設定が足りないときの帯。
 *
 * **足りないまま「動いています」と見せない。**受け口は閉じているので、
 * 画面にもそう出す。
 */
function readinessBlocks(missing: string[]): Block[] {
	if (missing.length === 0) {
		return [
			{
				type: "banner",
				title: "受け付けています",
				description: "必要な設定はそろっています。",
			},
		];
	}
	return [
		{
			type: "banner",
			variant: "alert",
			title: "受け口は閉じています",
			description: `次の設定が足りません：${missing.join("、")}。そろうまで、送信は受け付けません（素通しのフォームを公開しないため）。`,
		},
		{
			type: "actions",
			elements: [{ type: "link", label: "設定を開く", target: { kind: "plugin-settings" }, appearance: "primary" }],
		},
	];
}

/* ------------------------------------------------------------------ *
 * ダッシュボードのウィジェット
 * ------------------------------------------------------------------ */

export function inboxWidget(input: {
	unread: number;
	total: number;
	latest?: { id: string; data: StoredMessage };
	missing: string[];
}): BlockResponse {
	const blocks: Block[] = [];

	if (input.missing.length > 0) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "受け口は閉じています",
			description: `足りない設定：${input.missing.join("、")}`,
		});
	}

	blocks.push({
		type: "stats",
		items: [
			{
				label: "未読",
				value: input.unread,
				trend: input.unread > 0 ? "up" : "neutral",
				description: input.unread > 0 ? "読んでいないものがあります" : "すべて読み終えています",
			},
			{ label: "保存されている数", value: input.total },
		],
	});

	if (input.latest) {
		blocks.push({
			type: "context",
			text: `直近：${showDate(input.latest.data.createdAt)}　${input.latest.data.name} 様 — ${shorten(input.latest.data.message, 40)}`,
		});
	} else {
		blocks.push({ type: "context", text: "まだ問い合わせはありません。" });
	}

	blocks.push({
		type: "actions",
		elements: [
			{
				type: "link",
				label: "問い合わせを見る",
				target: { kind: "plugin-page", path: MESSAGES_PAGE },
				appearance: "primary",
			},
		],
	});

	return { blocks };
}

/* ------------------------------------------------------------------ *
 * 一覧
 * ------------------------------------------------------------------ */

export function messagesList(input: {
	items: Array<{ id: string; data: StoredMessage }>;
	cursor?: string;
	unread: number;
	total: number;
	missing: string[];
	toast?: BlockResponse["toast"];
}): BlockResponse {
	const blocks: Block[] = [
		{ type: "header", text: "問い合わせ" },
		...readinessBlocks(input.missing),
		{
			type: "stats",
			items: [
				{ label: "未読", value: input.unread, trend: input.unread > 0 ? "up" : "neutral" },
				{ label: "保存されている数", value: input.total },
			],
		},
	];

	if (input.items.length === 0) {
		blocks.push({
			type: "empty",
			title: "まだ問い合わせはありません",
			description: "サイトのフォームから届くと、ここに並びます。",
		});
		return { blocks, toast: input.toast };
	}

	blocks.push({
		type: "table",
		page_action_id: "browse",
		empty_text: "まだ問い合わせはありません。",
		next_cursor: input.cursor,
		columns: [
			{ key: "createdAt", label: "受付" },
			{ key: "name", label: "お名前" },
			{ key: "email", label: "メール" },
			{ key: "status", label: "状態" },
			{ key: "excerpt", label: "内容" },
		],
		rows: input.items.map(({ data }) => ({
			createdAt: showDate(data.createdAt),
			name: data.name,
			email: data.email,
			status: data.status === "new" ? "未読" : "既読",
			excerpt: shorten(data.message, 50),
		})),
	});

	// 表の行は押せないので、開く先はここから選ぶ。
	blocks.push({
		type: "actions",
		elements: [
			{
				type: "menu",
				action_id: "open",
				label: "1件を開く",
				items: input.items.map(({ id, data }) => ({
					label: `${showDate(data.createdAt)}　${data.name} 様`,
					value: id,
				})),
			},
		],
	});

	// 届かなかったメールがあれば、一覧の段で気づけるようにする。
	const failed = input.items.filter((i) => !i.data.notified || (i.data.autoReplied === false && i.data.autoReplyError));
	if (failed.length > 0) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: `メールが送れていないものが ${failed.length} 件あります`,
			description: "1件ずつ開くと、理由が出ます。問い合わせ自体は保存されています。",
		});
	}

	return { blocks, toast: input.toast };
}

/* ------------------------------------------------------------------ *
 * 1件の中身
 * ------------------------------------------------------------------ */

export function messageDetail(id: string, data: StoredMessage, toast?: BlockResponse["toast"]): BlockResponse {
	const mailState = (sent: boolean, error?: string) =>
		sent ? "送信済み" : error ? `未送信（${error}）` : "未送信";

	return {
		blocks: [
			{ type: "header", text: `${data.name} 様からの問い合わせ` },
			{
				type: "fields",
				fields: [
					{ label: "受付", value: showDate(data.createdAt) },
					{ label: "状態", value: data.status === "new" ? "未読" : "既読" },
					{ label: "メール", value: data.email },
					{ label: "受付ID", value: id },
					{ label: "運営者への通知", value: mailState(data.notified, data.notifyError) },
					{ label: "確認メール", value: mailState(data.autoReplied, data.autoReplyError) },
					// 2通とも「未送信」で理由が空のときに、何が起きたのかを辿れるようにする。
					...(data.mailStageError
						? [{ label: "メールの段で落ちた", value: data.mailStageError }]
						: []),
					...(data.mailDiag && !(data.notified && data.autoReplied)
						? [{ label: "メールの経路", value: data.mailDiag }]
						: []),
				],
			},
			{ type: "divider" },
			{ type: "code", code: data.message },
			{
				type: "actions",
				elements: [
					data.status === "new"
						? { type: "button", label: "既読にする", action_id: "mark_read", value: id, style: "primary" }
						: { type: "button", label: "未読に戻す", action_id: "mark_new", value: id },
					{
						type: "button",
						label: "削除する",
						action_id: "delete",
						value: id,
						style: "danger",
						confirm: {
							title: "この問い合わせを削除しますか",
							text: "元に戻せません。返信がまだなら、先に返信してください。",
							confirm: "削除する",
							deny: "やめる",
							style: "danger",
						},
					},
					{ type: "link", label: "一覧へ戻る", target: { kind: "plugin-page", path: MESSAGES_PAGE } },
				],
			},
			{
				type: "context",
				text: "返信はご自身のメールソフトから。このプラグインは返信を送りません（送った記録が残らないため）。",
			},
		],
		toast,
	};
}

/* ------------------------------------------------------------------ *
 * 設定ページ（足りないものと、サイトに貼る雛形）
 * ------------------------------------------------------------------ */

export function settingsPage(input: {
	settings: Settings;
	missing: string[];
	origin: string;
	submitUrl: string;
	tokenUrl: string;
	/** すでに入っている秘密。**値は渡さない**（画面に書き戻さないため） */
	hasSecrets: { turnstileSecretKey: boolean; cloudflareApiToken: boolean };
	toast?: BlockResponse["toast"];
}): BlockResponse {
	const { settings } = input;
	const snippet = formSnippet(input.submitUrl, input.tokenUrl, settings.turnstileSiteKey || "（サイトキーを設定してください）");

	return {
		blocks: [
			{ type: "header", text: "設定" },
			...readinessBlocks(input.missing),
			settingsForm(settings, input.hasSecrets),
			...clearSecretBlocks(input.hasSecrets),
			{ type: "divider" },
			{
				type: "fields",
				fields: [
					{ label: "メールの送り方", value: settings.mailProvider === "cloudflare" ? "Cloudflare Email Sending" : "EmDash のメール配送" },
					{ label: "通知の宛先", value: settings.notifyTo || "（未設定）" },
					{ label: "差出人", value: settings.senderAddress || "（未設定）" },
					{ label: "確認メール", value: settings.autoReply ? "送る" : "送らない" },
					{
						label: "本文の写しを付ける",
						value: settings.autoReplyIncludeMessage
							? `付ける（見出し：${settings.autoReplyMessageHeading}）`
							: "付けない",
					},
					{ label: "保存する日数", value: settings.retentionDays === 0 ? "削除しない" : `${settings.retentionDays}日` },
					{ label: "回数制限", value: `IP 1時間 ${settings.perIpPerHour} / IP 1日 ${settings.perIpPerDay} / 全体 1時間 ${settings.globalPerHour}` },
					{ label: "最短の送信時間", value: `${settings.minFillSeconds}秒` },
				],
			},
			...(settings.autoReplyIncludeMessage
				? [
						{
							type: "banner",
							variant: "alert",
							title: "確認メールに本文の写しを付けています",
							description:
								"Turnstile を通せる人が、選んだ宛先へ、選んだ文章を、あなたのドメインの差出人で届けられる状態です。必要がなければ切ってください。",
						} as Block,
					]
				: []),
			{
				type: "context",
				text:
					"接続元（IP）が取れない要求は受け付けません。Cloudflare の上で動いていれば自動で取れますが、" +
					"別の構成（リバースプロキシの後ろなど）では EMDASH_TRUSTED_PROXY_HEADERS に信用するヘッダ名を宣言してください。" +
					"宣言が無いと、偽装できるヘッダを信用しないため、すべての送信が落ちます。",
			},
			{
				type: "banner",
				title: "保存期間は、書いた文面と揃えてください",
				description: `いまの設定は ${settings.retentionDays === 0 ? "「削除しない」" : `${settings.retentionDays}日`} です。プライバシーポリシーに別の期間を書いていると、文面が嘘になります。`,
			},
			{ type: "divider" },
			{ type: "header", text: "サイトに貼る雛形" },
			{
				type: "context",
				text: "フォームの見た目はサイト側で作ります。札（_t）を受け口から取り、Turnstile を置き、罠の欄を人から隠すところだけ決まっています。",
			},
			// `language` は ts/tsx/jsonc/bash/css しか受け付けない。html は無いので付けない。
			{ type: "code", code: snippet },
		],
		toast: input.toast,
	};
}

/** 設定フォームの action_id。保存のときにこの名前で値が返ってくる。 */
export const SAVE_SETTINGS = "save_settings";

/**
 * 預かっている秘密を消す action_id。`value` に消す項目の名前が入る。
 *
 * **これが無いと、一度入れた秘密を消す口がどこにも無い。**秘密の欄は
 * 「空のまま保存したら変えない」作りで（他の項目だけ直せるようにするため）、
 * 空にしても消えない。入れた鍵が要らなくなっても残り続けるのは、
 * **預かる理由が無くなったものを預かり続ける**ということ。
 */
export const CLEAR_SECRET = "clear_secret";

/** 消せる秘密。**ここに無い名前は受け付けない**（任意の設定を空にされないため）。 */
export const CLEARABLE_SECRETS = {
	turnstileSecretKey: {
		label: "Turnstile の秘密鍵",
		warning: "消すと、設定し直すまでフォームは送信を受け付けません（照合できないため）。",
	},
	cloudflareApiToken: {
		label: "Cloudflare の API トークン",
		warning:
			"消しても、メールの送り方が「EmDash のメール配送」なら影響はありません。Cloudflare 側のトークンも、あわせて削除してください（ここで消えるのは預かっている写しだけです）。",
	},
} as const;

export type ClearableSecret = keyof typeof CLEARABLE_SECRETS;

/** 画面から来た名前が、消してよい項目かどうか。 */
export function isClearableSecret(value: unknown): value is ClearableSecret {
	return typeof value === "string" && value in CLEARABLE_SECRETS;
}

/**
 * 預かっている秘密を消すボタン。**入っているものだけ出す。**
 *
 * フォームの外に置く。フォームの中に入れると、保存と同じ往復に混ざって
 * 「消したのか保存したのか」が分からなくなる。
 */
function clearSecretBlocks(hasSecrets: {
	turnstileSecretKey: boolean;
	cloudflareApiToken: boolean;
}): Block[] {
	const held = (Object.keys(CLEARABLE_SECRETS) as ClearableSecret[]).filter(
		(key) => hasSecrets[key],
	);

	// **空で保存したときの扱いが、欄によって違う。**ここに書いていなかったため、
	// アカウントIDを空のまま保存して消してしまった（2026-11-02）。
	const asymmetry: Block = {
		type: "context",
		text:
			"空のまま保存したときの扱いは、欄によって違います。" +
			"**秘密の欄（Turnstile の秘密鍵・API トークン）は変わりません**——他の項目だけ直せるようにするためです。" +
			"**それ以外の欄は、空が保存されます。**消したくない値は、空のまま保存しないでください。",
	};
	if (held.length === 0) return [asymmetry];

	return [
		asymmetry,
		{
			type: "context",
			text:
				"要らなくなった鍵は、下のボタンで消してください。" +
				"**預かる理由が無くなったものを、預かり続けないために。**",
		},
		{
			type: "actions",
			elements: held.map((key) => ({
				type: "button",
				label: `${CLEARABLE_SECRETS[key].label}を消す`,
				action_id: CLEAR_SECRET,
				value: key,
				style: "danger",
				confirm: {
					title: `${CLEARABLE_SECRETS[key].label}を消しますか`,
					text: `${CLEARABLE_SECRETS[key].warning}\n\n消したあと、ここから値を見ることはできません。`,
					confirm: "消す",
					deny: "やめる",
					style: "danger",
				},
			})) as Block["elements"],
		},
	] as Block[];
}

/**
 * 設定を入れるフォーム。
 *
 * **ここが無いと、設定を入れる場所がどこにも無い。**`settingsSchema` は
 * 「どれを暗号化するか」をホストに伝えるものなので、それだけでは画面に欄が出ない。
 *
 * 秘密の欄は `has_value` で「入っている」ことだけを示し、**値は書き戻さない。**
 * 空のまま保存したときは**上書きしない**（うっかり消さないため）。
 */
export function settingsForm(
	settings: Settings,
	hasSecrets: { turnstileSecretKey: boolean; cloudflareApiToken: boolean },
): Block {
	return {
		type: "form",
		block_id: "contact-form-settings",
		submit: { label: "保存する", action_id: SAVE_SETTINGS },
		fields: [
			{ type: "text_input", action_id: "siteName", label: "サイト名", initial_value: settings.siteName, placeholder: "野良コンサル山田" },
			{ type: "text_input", action_id: "notifyTo", label: "通知の宛先", initial_value: settings.notifyTo, placeholder: "you@example.com" },
			{ type: "text_input", action_id: "senderAddress", label: "差出人のアドレス", initial_value: settings.senderAddress, placeholder: "contact@example.com" },
			{ type: "text_input", action_id: "allowedOrigin", label: "許す送信元（空なら受け口と同じオリジンだけ）", initial_value: settings.allowedOrigin },

			{ type: "text_input", action_id: "turnstileSiteKey", label: "Turnstile のサイトキー", initial_value: settings.turnstileSiteKey, placeholder: "0x…" },
			{
				type: "secret_input",
				action_id: "turnstileSecretKey",
				label: "Turnstile の秘密鍵（空のままなら変えません）",
				has_value: hasSecrets.turnstileSecretKey,
			},

			{
				type: "select",
				action_id: "mailProvider",
				label: "メールの送り方",
				initial_value: settings.mailProvider,
				options: [
					{ value: "emdash", label: "EmDash のメール配送を使う" },
					{ value: "cloudflare", label: "Cloudflare Email Sending（API トークン）" },
				],
			},
			{ type: "text_input", action_id: "cloudflareAccountId", label: "Cloudflare のアカウントID", initial_value: settings.cloudflareAccountId },
			{
				type: "secret_input",
				action_id: "cloudflareApiToken",
				label: "Cloudflare の API トークン（空のままなら変えません）",
				has_value: hasSecrets.cloudflareApiToken,
			},

			{ type: "toggle", action_id: "autoReply", label: "問い合わせた人に確認メールを送る", initial_value: settings.autoReply },
			{ type: "text_input", action_id: "autoReplySubject", label: "確認メールの件名", initial_value: settings.autoReplySubject },
			{ type: "text_input", action_id: "autoReplyBody", label: "確認メールの本文（{{name}} {{id}} {{received}} {{site}} が置き換わります）", initial_value: settings.autoReplyBody, multiline: true },
			{
				type: "toggle",
				action_id: "autoReplyIncludeMessage",
				label: "確認メールに、いただいた本文の写しを付ける",
				description: "付けると、Turnstile を通せる人が、選んだ宛先へ、選んだ文章を、あなたのドメインの差出人で届けられます。",
				initial_value: settings.autoReplyIncludeMessage,
			},
			{ type: "text_input", action_id: "autoReplyMessageHeading", label: "写しの見出し", initial_value: settings.autoReplyMessageHeading },

			{ type: "number_input", action_id: "retentionDays", label: "問い合わせを残す日数（0 なら削除しない）", initial_value: settings.retentionDays, min: 0, max: 3650 },
			{ type: "number_input", action_id: "perIpPerHour", label: "同じ送信元から1時間に何回まで", initial_value: settings.perIpPerHour, min: 1, max: 1000 },
			{ type: "number_input", action_id: "perIpPerDay", label: "同じ送信元から1日に何回まで", initial_value: settings.perIpPerDay, min: 1, max: 10000 },
			{ type: "number_input", action_id: "globalPerHour", label: "サイト全体で1時間に何回まで", initial_value: settings.globalPerHour, min: 1, max: 100000 },
			{ type: "number_input", action_id: "minFillSeconds", label: "送信までの最短秒数", initial_value: settings.minFillSeconds, min: 0, max: 600 },
			{ type: "number_input", action_id: "formTtlSeconds", label: "フォームの有効期限（秒）", initial_value: settings.formTtlSeconds, min: 60, max: 604800 },
		],
	};
}

/** サイト側に貼る最小の雛形。**見た目は作り込まない**（サイトの流儀に合わせるため）。 */
export function formSnippet(submitUrl: string, tokenUrl: string, siteKey: string): string {
	return `<form id="contact" novalidate>
  <label>お名前<input name="name" required maxlength="100"></label>
  <label>メールアドレス<input name="email" type="email" required maxlength="254"></label>
  <label>ご相談内容<textarea name="message" required minlength="10" maxlength="4000"></textarea></label>

  <!-- 罠の欄。人には見せない（CSS で隠す。hidden 属性だと機械にも分かる） -->
  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <input name="website" tabindex="-1" autocomplete="off">
  </div>

  <input type="hidden" name="_t" value="">
  <div class="cf-turnstile" data-sitekey="${siteKey}"></div>
  <button type="submit">送信する</button>
  <p id="contact-result" role="status"></p>
</form>

<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script type="module">
  const form = document.getElementById("contact");
  const result = document.getElementById("contact-result");

  // 札は開いたときに取る。これで「開いてから送るまでの時間」が測れる。
  const token = await fetch("${tokenUrl}", { credentials: "omit" }).then((r) => r.json());
  form.elements._t.value = token.token;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    result.textContent = "送信しています…";
    const response = await fetch("${submitUrl}", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)),
    });
    const body = await response.json();
    result.textContent = body.ok
      ? "送信しました。確認のメールをお送りしています。"
      : body.error ?? "送信を受け付けられませんでした。";
    if (body.ok) form.reset();
  });
</script>`;
}
