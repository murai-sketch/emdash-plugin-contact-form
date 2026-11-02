/**
 * 迷惑送信の防御。
 *
 * 並べる順番には意味がある。**安いものから先に落とす。**Turnstile の照合は
 * Cloudflare への往復が1回あるので、形も通っていない要求にそれを使わない。
 * 回数制限は Turnstile より前に数える（失敗も数えないと総当たりが無料になる）。
 *
 * 方針：
 * - **IP アドレスは保存しない。**回数制限の鍵には、秘密の塩を混ぜたハッシュだけを使う。
 * - 失敗の理由は、利用者が直せるもの（入力の不備）だけ返す。それ以外は同じ文面にする。
 * - 送信された文字を画面に描き戻さない。保存はするが表示に流さない。
 *
 * **呼び出し回数の予算（これが最大の制約）。**
 *
 * サンドボックスは1回の実行でホストを **10回**しか呼べない
 * （`@emdash-cms/cloudflare` の `DEFAULT_LIMITS.subrequests = 10`。
 * 設定から変えられない）。**11回目は返ってこない**——例外も投げず、ただ止まる。
 * そこで待っているあいだに実行ごと畳まれるので、`try/catch` でも
 * `setTimeout` でも捕まえられず、何の記録も残らない。
 * **ローカルでは上限が無い**ので、`wrangler dev` では最後まで通ってしまう。
 *
 * 送信1回ぶんの予算（2026-11-01 時点）：
 *
 * | | 回数 |
 * |---|---|
 * | 設定の読み出し `settings.list()` | 1 |
 * | KV のまとめ読み `kv.list()` | 1 |
 * | 回数制限の書き戻し（IP・全体） | 2 |
 * | Turnstile の照合 | 1 |
 * | 保存 | 1 |
 * | 通知メール | 1 |
 * | 確認メール | 1 |
 * | メール結果の書き戻し | 1 |
 * | **合計** | **9**（予備1） |
 *
 * **`ctx.log` も1回に数える。**ここが落とし穴で、ログは「ついで」に見えるが
 * ホストへの呼び出しそのもの（`sandbox/index.mjs` の `log` は `bridge.log` を呼ぶ）。
 * 2026-11-01、メールが失敗したときだけ2回ログへ書いていたため、**失敗のときに限って**
 * 合計が11回になり、理由を書いた記録の書き戻しが落ちた。失敗の記録が、失敗のときだけ
 * 消える形になっていた。だから**失敗の理由は記録に書き、ログには書かない。**
 *
 * **ここに1つ足すときは、どれかを削る。**数え直さずに足すと、
 * 症状の出ない壊れ方（メールだけ出ない）になる。失敗の経路でだけ数が増える足し方は
 * とくに見つけにくい——**うまくいく場合だけでなく、失敗する場合も数える。**
 */

import type { PluginContext } from "emdash/plugin";
import { LIMITS, type Settings } from "./settings";

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ *
 * 署名の素（プラグインが自分で持つ）
 * ------------------------------------------------------------------ */

const SECRET_KEY = "formSecret";

/** サイト全体の数え。IP ごとの鍵とは別の1本。 */
const GLOBAL_KEY = "rate:g";

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** 長さと内容を漏らさない比較。== で比べると早く抜ける分だけ情報が出る。 */
function equalsConstantTime(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* ------------------------------------------------------------------ *
 * 署名つきの札（フォームを本当に開いたか・速すぎないか）
 * ------------------------------------------------------------------ */

export type TokenVerdict = "ok" | "malformed" | "bad-signature" | "too-fast" | "expired";

/** フォームに埋める `発行秒.署名`。 */
export async function issueFormToken(secret: string, now = Date.now()): Promise<string> {
	const issuedAt = Math.floor(now / 1000);
	return `${issuedAt}.${await hmacHex(secret, `form-token:${issuedAt}`)}`;
}

export async function verifyFormToken(
	secret: string,
	token: string,
	settings: Pick<Settings, "minFillSeconds" | "formTtlSeconds">,
	now = Date.now(),
): Promise<TokenVerdict> {
	const parts = token.split(".");
	if (parts.length !== 2) return "malformed";
	const [issuedAtRaw, sig] = parts;
	if (!/^\d{1,12}$/.test(issuedAtRaw) || !/^[0-9a-f]{64}$/.test(sig)) return "malformed";

	const expected = await hmacHex(secret, `form-token:${issuedAtRaw}`);
	if (!equalsConstantTime(sig, expected)) return "bad-signature";

	const ageSeconds = Math.floor(now / 1000) - Number(issuedAtRaw);
	if (ageSeconds < settings.minFillSeconds) return "too-fast";
	if (ageSeconds > settings.formTtlSeconds) return "expired";
	return "ok";
}

/* ------------------------------------------------------------------ *
 * 送信元の識別（IP は保存しない）
 * ------------------------------------------------------------------ */

/**
 * 回数制限の鍵。IP そのものではなく、秘密の塩と時間枠を混ぜたハッシュを使う。
 * 塩が無いと IPv4 は総当たりで逆算できるため、秘密必須にしている。
 */
export async function rateKeyForIp(secret: string, ip: string, scope: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`ip:${secret}:${ip}`));
	return `${scope}:${toHex(digest).slice(0, 32)}`;
}

/** 時間枠の文字列。UTC で切る（運用者の時差で境界が動かないようにする）。 */
export function windowKeys(now = new Date()): { hour: string; day: string } {
	const iso = now.toISOString();
	return { hour: iso.slice(0, 13), day: iso.slice(0, 10) };
}

/* ------------------------------------------------------------------ *
 * 入力の検証
 * ------------------------------------------------------------------ */

export type Fields = { name: string; email: string; message: string };
export type FieldErrors = Partial<Record<keyof Fields, string>>;

/** 見えない制御文字・並び替え文字。貼り付けで紛れ込むうえ、表示を偽装できる。 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁯﻿]/g;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function normalize(value: string): string {
	return value.normalize("NFC").replace(INVISIBLE, "");
}

function singleLine(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function validate(raw: Record<string, string>): {
	fields?: Fields;
	errors: FieldErrors;
} {
	const errors: FieldErrors = {};

	const name = singleLine(normalize(raw.name ?? ""));
	const email = singleLine(normalize(raw.email ?? "")).toLowerCase();
	// 本文は改行を残す（\r だけ落とす）。段落を潰すと読みにくくなる。
	const message = normalize(raw.message ?? "").replace(/\r\n?/g, "\n").trim();

	if (name.length === 0) errors.name = "お名前を入れてください。";
	else if (name.length > LIMITS.name) errors.name = `お名前は${LIMITS.name}文字までです。`;

	if (email.length === 0) errors.email = "メールアドレスを入れてください。";
	else if (email.length > LIMITS.email) errors.email = "メールアドレスが長すぎます。";
	else if (!EMAIL_SHAPE.test(email)) errors.email = "メールアドレスの形を確かめてください。";

	if (message.length < LIMITS.messageMin)
		errors.message = `ご相談内容を${LIMITS.messageMin}文字以上で書いてください。`;
	else if (message.length > LIMITS.message)
		errors.message = `ご相談内容は${LIMITS.message}文字までです。`;
	else if ((message.match(/https?:\/\//gi) ?? []).length > LIMITS.maxLinks)
		errors.message = "リンクが多すぎます。本文を短くしてお送りください。";

	if (Object.keys(errors).length > 0) return { errors };
	return { fields: { name, email, message }, errors: {} };
}

/* ------------------------------------------------------------------ *
 * 回数制限（KV）
 * ------------------------------------------------------------------ */

export type RateVerdict = "ok" | "ip-hour" | "ip-day" | "global-hour";

type Counter = { window: string; count: number };

/** KV をまとめて読んだ結果。**読みは1回だけ。** */
export type GuardState = {
	secret: string;
	entries: Map<string, unknown>;
};

/**
 * 守りに要るものを**1回の `kv.list()` で全部読む。**
 *
 * 秘密・IP ごとの数え・全体の数えを別々に読むと、それだけで3回使う。
 * 予算が10回しかないので、読みはまとめる。
 *
 * 秘密が無いときだけ1回書く（初回のみ）。`compareAndSet` ではなく `set` なのは、
 * 競った場合でもどちらかの値で揃えばよく、1回の書き込みで済ませたいため。
 */
export async function readGuardState(ctx: PluginContext): Promise<GuardState> {
	const entries = new Map<string, unknown>();
	for (const row of await ctx.kv.list()) entries.set(row.key, row.value);

	const stored = entries.get(SECRET_KEY);
	if (typeof stored === "string" && stored.length >= 32) {
		return { secret: stored, entries };
	}

	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const generated = toHex(bytes.buffer);
	await ctx.kv.set(SECRET_KEY, generated);
	entries.set(SECRET_KEY, generated);
	return { secret: generated, entries };
}

/** IP ごとの数え。時・日を**1つの値にまとめる**（鍵を分けると書き込みが2回になる）。 */
type IpCounters = { h: Counter; d: Counter };

function nextCount(current: unknown, window: string): Counter {
	const value = current as Counter | undefined;
	return value && value.window === window ? { window, count: value.count + 1 } : { window, count: 1 };
}

/**
 * 回数制限。**狭いものから順に数える。**
 * 全体の蓋を最後にするのは、1人の総当たりでサイト全体の枠を使い切らせないため。
 *
 * 読みは `readGuardState` で済ませてあるので、ここで使うのは**書き込みだけ**
 * （IP ぶん1回、全体ぶん1回）。**超えたときは書かずに返す**ので、
 * 弾いた要求で予算を使わない。
 *
 * `compareAndSet` ではなく `set` にしている。版を取り直すと読みが増えて
 * 予算に収まらないため。**同時に来た2本が互いの加算を踏む可能性は残る**が、
 * 問い合わせフォームの頻度（既定で1時間に3件）では実害が無く、
 * **数え落としても「通りすぎる」側に1件ずれるだけ**で、閉じる側には倒れない。
 */
export async function checkRate(
	ctx: PluginContext,
	settings: Settings,
	state: GuardState,
	ipKey: string,
	now = new Date(),
): Promise<RateVerdict> {
	const { hour, day } = windowKeys(now);
	const key = `rate:${ipKey}`;
	const current = state.entries.get(key) as IpCounters | undefined;

	const h = nextCount(current?.h, hour);
	if (h.count > settings.perIpPerHour) return "ip-hour";
	const d = nextCount(current?.d, day);
	if (d.count > settings.perIpPerDay) return "ip-day";

	const g = nextCount(state.entries.get(GLOBAL_KEY), hour);
	if (g.count > settings.globalPerHour) return "global-hour";

	await ctx.kv.set(key, { h, d } satisfies IpCounters);
	await ctx.kv.set(GLOBAL_KEY, g);
	return "ok";
}

/* ------------------------------------------------------------------ *
 * Turnstile
 * ------------------------------------------------------------------ */

export type TurnstileResult = { ok: boolean; detail: string };

/**
 * 人かどうかを Cloudflare 側で確かめる。
 *
 * **失敗は「通さない」に倒す。**往復が落ちたときに通してしまうと、
 * Cloudflare が不調なあいだフォームが素通しになる。
 */
export async function verifyTurnstile(
	ctx: PluginContext,
	secretKey: string,
	token: string,
	remoteIp: string | null,
): Promise<TurnstileResult> {
	if (!token) return { ok: false, detail: "no-token" };
	if (!ctx.http) return { ok: false, detail: "no-network-capability" };

	const body = new URLSearchParams({ secret: secretKey, response: token });
	if (remoteIp) body.set("remoteip", remoteIp);

	try {
		const response = await ctx.http.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});
		const result = (await response.json()) as {
			success?: boolean;
			"error-codes"?: string[];
		};
		if (result.success === true) return { ok: true, detail: "ok" };
		return { ok: false, detail: (result["error-codes"] ?? ["unknown"]).join(",") };
	} catch (error) {
		return { ok: false, detail: `fetch-failed:${String(error).slice(0, 80)}` };
	}
}

/* ------------------------------------------------------------------ *
 * 送信元のオリジン
 * ------------------------------------------------------------------ */

/**
 * 別サイトのページから投げさせない。
 *
 * 設定が空なら**受け口と同じオリジンだけ**を許す。これは使う側が何も決めなくても
 * 安全側に働く既定で、別ドメインのページから送りたいときだけ設定を入れる。
 */
export function originAllowed(requestUrl: string, origin: string | null, allowedOrigin: string): boolean {
	if (!origin) return false;
	let expected: string;
	if (allowedOrigin) {
		try {
			expected = new URL(allowedOrigin).origin;
		} catch {
			return false;
		}
	} else {
		try {
			expected = new URL(requestUrl).origin;
		} catch {
			return false;
		}
	}
	return origin === expected;
}
