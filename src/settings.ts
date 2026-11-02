/**
 * 設定の読み取り。
 *
 * 管理画面のフォームは `emdash-plugin.jsonc` の `admin.settingsSchema` から
 * 自動で作られ、保存された値は `ctx.settings.get("<キー>")` で読める。
 * ただし**保存される前は未定義**なので、既定値はここで持つ。
 * マニフェストの `default` と、このファイルの既定は**同じ値にしておく**
 * （片方だけ変えると、保存前と保存後で挙動が変わる）。
 */

import type { PluginContext } from "emdash/plugin";

export type MailProvider = "emdash" | "cloudflare";

export type Settings = {
	siteName: string;
	notifyTo: string;
	senderAddress: string;
	allowedOrigin: string;

	turnstileSiteKey: string;
	turnstileSecretKey: string;

	mailProvider: MailProvider;
	cloudflareAccountId: string;
	cloudflareApiToken: string;

	autoReply: boolean;
	autoReplySubject: string;
	autoReplyBody: string;
	autoReplyIncludeMessage: boolean;
	autoReplyMessageHeading: string;

	retentionDays: number;
	perIpPerHour: number;
	perIpPerDay: number;
	globalPerHour: number;
	minFillSeconds: number;
	formTtlSeconds: number;
};

export const DEFAULT_AUTOREPLY_BODY = [
	"{{name}} 様",
	"",
	"お問い合わせをいただき、ありがとうございます。",
	"内容を確かに受け付けました。",
	"",
	"担当者が確認のうえ、改めてご連絡いたします。",
	"恐れ入りますが、しばらくお待ちください。",
	"",
	"受付ID：{{id}}",
	"受付日時：{{received}}",
	"",
	"※このメールは送信時に自動でお送りしています。",
	"",
	"{{site}}",
].join("\n");

/** 入力欄の上限。設定にはしない（ここを緩めると保存と通知の大きさに直で響く）。 */
export const LIMITS = {
	name: 100,
	email: 254,
	message: 4000,
	messageMin: 10,
	/** 本文全体の大きさ。これを超えたら読む前に捨てる */
	bodyBytes: 16 * 1024,
	/** 本文に含めてよいリンクの数 */
	maxLinks: 5,
} as const;

function str(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * 真偽の読み取り。
 *
 * トグルは真偽で届くが、環境によっては文字列で入ることがある。
 * **はっきり読めないときは既定へ倒す**——綴り違いで勝手に送り始めないため。
 */
function bool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const raw = value.trim().toLowerCase();
		if (["on", "true", "1", "yes", "有効"].includes(raw)) return true;
		if (["off", "false", "0", "no", "無効"].includes(raw)) return false;
	}
	return fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 設定を1回のまとめ読みで取る。1件ごとに get を呼ぶと往復が増える。
 *
 * `list()` は `{ key, value }` の配列で返るので、引きやすい組に直してから使う。
 */
export async function readSettings(ctx: PluginContext): Promise<Settings> {
	const raw: Record<string, unknown> = {};
	for (const entry of await ctx.settings.list()) raw[entry.key] = entry.value;
	const provider = str(raw.mailProvider, "emdash");

	return {
		siteName: str(raw.siteName, ""),
		notifyTo: str(raw.notifyTo, ""),
		senderAddress: str(raw.senderAddress, ""),
		allowedOrigin: str(raw.allowedOrigin, ""),

		turnstileSiteKey: str(raw.turnstileSiteKey, ""),
		turnstileSecretKey: str(raw.turnstileSecretKey, ""),

		mailProvider: provider === "cloudflare" ? "cloudflare" : "emdash",
		cloudflareAccountId: str(raw.cloudflareAccountId, ""),
		cloudflareApiToken: str(raw.cloudflareApiToken, ""),

		autoReply: bool(raw.autoReply, true),
		autoReplySubject: str(raw.autoReplySubject, "お問い合わせを受け付けました"),
		autoReplyBody: str(raw.autoReplyBody, DEFAULT_AUTOREPLY_BODY),
		autoReplyIncludeMessage: bool(raw.autoReplyIncludeMessage, false),
		autoReplyMessageHeading: str(raw.autoReplyMessageHeading, "いただいた内容"),

		retentionDays: num(raw.retentionDays, 365, 0, 3650),
		perIpPerHour: num(raw.perIpPerHour, 3, 1, 1000),
		perIpPerDay: num(raw.perIpPerDay, 10, 1, 10000),
		globalPerHour: num(raw.globalPerHour, 60, 1, 100000),
		minFillSeconds: num(raw.minFillSeconds, 3, 0, 600),
		formTtlSeconds: num(raw.formTtlSeconds, 10800, 60, 604800),
	};
}

/**
 * フォームを開けてよい状態か。
 *
 * **設定が足りないときは受け付けない**（開ける方へ倒さない）。Turnstile の
 * 秘密鍵が無いまま通すと、素通しのフォームを公開することになる。
 */
export function missingRequirements(settings: Settings): string[] {
	const missing: string[] = [];
	if (!settings.turnstileSiteKey) missing.push("Turnstile のサイトキー");
	if (!settings.turnstileSecretKey) missing.push("Turnstile の秘密鍵");
	if (!settings.notifyTo) missing.push("通知の宛先");
	if (settings.mailProvider === "cloudflare") {
		if (!settings.senderAddress) missing.push("差出人のアドレス");
		if (!settings.cloudflareAccountId) missing.push("Cloudflare のアカウントID");
		if (!settings.cloudflareApiToken) missing.push("Cloudflare の API トークン");
	}
	return missing;
}
