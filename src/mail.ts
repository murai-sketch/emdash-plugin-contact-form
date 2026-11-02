/**
 * メールの送り方。2通りあり、設定で選ぶ。
 *
 * - **`emdash`** …… `ctx.email.send()`。EmDash 側に配送（transport）が設定されていれば
 *   それを使う。鍵を持たなくてよく、どのサイトでも同じように動く。**差出人はサイト側が
 *   決める**（`EmailMessage` に `from` が無い）。
 * - **`cloudflare`** …… Cloudflare Email Sending の REST API を直に叩く。EmDash 側に
 *   配送が無いサイトでも送れるが、**API トークンを預かることになる。**
 *
 * どちらも、送れなかったことを呼び出し側へ返すだけで**例外は投げない**。
 * 問い合わせ自体は保存済みなので、通知の失敗で送信者に失敗を返さないため。
 */

import type { PluginContext } from "emdash/plugin";
import type { Settings } from "./settings";

export type Mail = {
	to: string;
	subject: string;
	text: string;
	html?: string;
	replyTo?: string;
};

export type MailResult = { ok: true } | { ok: false; detail: string };

/**
 * 送信の待ち時間の上限。
 *
 * **返ってこない呼び出しを、返ってこないまま待たない。**2026-10-28、本番で
 * 保存のあとが丸ごと消え、例外も記録も残らなかった。待ち続けて invocation ごと
 * 畳まれると、`try/catch` では捕まえられない——**時間で切れば、捕まえられる。**
 */
const SEND_TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(label)), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export async function sendMail(
	ctx: PluginContext,
	settings: Settings,
	mail: Mail,
): Promise<MailResult> {
	if (settings.mailProvider === "cloudflare") return sendViaCloudflare(ctx, settings, mail);
	return sendViaEmDash(ctx, mail);
}

async function sendViaEmDash(ctx: PluginContext, mail: Mail): Promise<MailResult> {
	// `send` が関数であることまで見る。口はあるが呼べない形で渡ってくることがあり、
	// そこで投げると、保存した結果の書き戻しごと落ちる。**ここで黙ると「送ったつもり」になる。**
	const mailer = (ctx as unknown as { email?: { send?: unknown } }).email;
	if (typeof mailer?.send !== "function") {
		return { ok: false, detail: `emdash-no-transport(email:${typeof mailer})` };
	}
	const send = mailer.send.bind(mailer) as (m: unknown) => Promise<unknown>;
	try {
		await withTimeout(
			send({
				to: mail.to,
				subject: mail.subject,
				text: mail.text,
				html: mail.html,
				replyTo: mail.replyTo,
			}),
			SEND_TIMEOUT_MS,
			"emdash-send-timeout",
		);
		return { ok: true };
	} catch (error) {
		return { ok: false, detail: `emdash-send-failed:${String(error).slice(0, 120)}` };
	}
}

async function sendViaCloudflare(
	ctx: PluginContext,
	settings: Settings,
	mail: Mail,
): Promise<MailResult> {
	if (!ctx.http) return { ok: false, detail: "no-network-capability" };
	if (!settings.cloudflareAccountId || !settings.cloudflareApiToken || !settings.senderAddress) {
		return { ok: false, detail: "cloudflare-not-configured" };
	}

	// **REST は `address`。**Workers のバインディングは `{ email, name }` だが、
	// REST の名前付きアドレスは `{ address, name }` で、鍵の名前が違う
	// （公式 "Specify recipients" の API タブ）。間違えると送信が弾かれる。
	const from = settings.siteName
		? { address: settings.senderAddress, name: settings.siteName }
		: settings.senderAddress;

	try {
		const response = await withTimeout(
			ctx.http.fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(settings.cloudflareAccountId)}/email/sending/send`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${settings.cloudflareApiToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					to: mail.to,
					from,
					subject: mail.subject,
					text: mail.text,
					html: mail.html,
					...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
				}),
				},
			),
			SEND_TIMEOUT_MS,
			"cloudflare-send-timeout",
		);

		// 200 でも success:false が返ることがある（宛先ごとの結果が入る）。
		// **状態コードだけで成功と見ない。**
		const result = (await response.json().catch(() => null)) as
			| { success?: boolean; errors?: Array<{ code?: number; message?: string }> }
			| null;
		if (!response.ok || !result || result.success !== true) {
			const message =
				result?.errors?.map((e) => `${e.code ?? ""}${e.message ?? ""}`).join(";") ??
				`http-${response.status}`;
			return { ok: false, detail: `cloudflare:${message}`.slice(0, 160) };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, detail: `cloudflare-fetch-failed:${String(error).slice(0, 120)}` };
	}
}
