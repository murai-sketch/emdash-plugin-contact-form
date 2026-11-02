/**
 * 問い合わせフォーム（sandboxed プラグイン）。
 *
 * 置いているもの：
 * - `token`  …… 公開。フォームを開いたときに署名つきの札を渡す（GET）
 * - `submit` …… 公開。送信の受け口（POST、`application/x-www-form-urlencoded` か multipart）
 * - `admin`  …… 非公開。ダッシュボードのウィジェットと2ページを描く
 * - `cron`   …… 保存期間を過ぎた問い合わせと、古い回数制限の記録を毎日消す
 *
 * **公開ルートはインターネットに面している。**入口での検証を handler の中で必ず行う。
 */

import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import {
	MESSAGES_PAGE,
	PAGE_SIZE,
	SETTINGS_PAGE,
	WIDGET_ID,
	SAVE_SETTINGS,
	CLEAR_SECRET,
	CLEARABLE_SECRETS,
	isClearableSecret,
	type BlockResponse,
	type StoredMessage,
	inboxWidget,
	messageDetail,
	messagesList,
	settingsPage,
} from "./admin";
import {
	checkRate,
	readGuardState,
	issueFormToken,
	originAllowed,
	rateKeyForIp,
	validate,
	verifyFormToken,
	verifyTurnstile,
} from "./guard";
import { sendMail } from "./mail";
import { LIMITS, missingRequirements, readSettings, type Settings } from "./settings";
import { asHtmlBody, buildAutoReplyText, buildNotifyText, formatReceived } from "./templates";

/**
 * ログの口が無くても落ちないようにする。
 *
 * **ログのために問い合わせを失わない。**サンドボックスに何が渡るかは
 * ホストの版と設定で変わる。`ctx.log` が無い環境で `safeLog(ctx, "error", ...)` と書くと、
 * そこで投げて、保存した結果の書き戻しごと落ちる。
 *
 * **ただし、落ちないことと、書いていいことは別。**`ctx.log` もホストへの1回で、
 * 10回の予算から引かれる（`sandbox/index.mjs` の `log` は `bridge.log` をそのまま呼ぶ）。
 * **あとに呼び出しが残っている場所では書かない。**2026-11-01、メールの失敗を2回
 * ログへ書いたせいで記録の書き戻しが11回目になり、理由ごと落ちた——失敗を
 * 書き残すための1行が、失敗の理由を消した。**理由は記録に書く。ログには書かない。**
 */
function safeLog(
	ctx: PluginContext,
	level: "info" | "error",
	message: string,
	data?: Record<string, unknown>,
): void {
	try {
		const log = (ctx as unknown as { log?: Record<string, unknown> }).log;
		const fn = log?.[level];
		if (typeof fn === "function") (fn as (m: string, d?: unknown) => void).call(log, message, data);
	} catch {
		/* ログが出せないことは、問い合わせを落とす理由にならない */
	}
}

/** どの失敗でも同じ文面を返すもの。理由を教えると、その分だけ突破の手掛かりになる。 */
const GENERIC = "送信を受け付けられませんでした。時間をおいて、もう一度お試しください。";

/**
 * 1回の保存で書ける設定の数。
 *
 * サンドボックスは1回の実行でホストを**10回**しか呼べない。設定の読み出しで
 * 1回使うので、書けるのは残り9回。余裕を見て8件で切る。
 * **超えると保存そのものが落ちて 400 が返る**（2026-11-01、本番で発生）。
 */
const MAX_SETTING_WRITES = 8;

const PURGE_TASK = "contact-form-purge";
const COLLECTION = "messages";

type Reply = { ok: boolean; error?: string; fields?: Record<string, string> };

/* ------------------------------------------------------------------ *
 * 受け口
 * ------------------------------------------------------------------ */

/** 送られてきた form を素直な組にする。ファイルは受けない（添付は扱わない）。 */
function readForm(input: unknown): Record<string, string> | null {
	const entries = (input as { entries?: unknown } | null)?.entries;
	if (!Array.isArray(entries)) return null;
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const e = entry as { name?: unknown; kind?: unknown; value?: unknown };
		if (typeof e?.name !== "string") continue;
		if (e.kind !== "text" || typeof e.value !== "string") continue;
		// 同じ名前が2度来たら、最初のものを使う（後から上書きさせない）。
		if (!(e.name in out)) out[e.name] = e.value.slice(0, LIMITS.message + 1000);
	}
	return out;
}

type SubmitContext = {
	input: unknown;
	request: { url: string; headers: Record<string, string> };
	requestMeta?: unknown;
};

async function handleSubmit(routeCtx: SubmitContext, ctx: PluginContext): Promise<Reply> {
	const settings = await readSettings(ctx);

	// 設定が足りないときは受け付けない（開ける方へ倒さない）。
	const missing = missingRequirements(settings);
	if (missing.length > 0) {
		safeLog(ctx, "error", "問い合わせ：設定が足りないため受け付けない", { missing });
		return { ok: false, error: "フォームは準備中です。" };
	}

	// --- 1. 送信元の確認（別サイトのページから投げさせない） ---
	const origin = routeCtx.request.headers?.origin ?? null;
	if (!originAllowed(routeCtx.request.url, origin, settings.allowedOrigin)) {
		return { ok: false, error: GENERIC };
	}

	// --- 2. 本文を読む ---
	const form = readForm(routeCtx.input);
	if (!form) return { ok: false, error: GENERIC };

	// --- 3. 罠の欄（人には見えない。埋まっていたら機械） ---
	if ((form.website ?? "").length > 0) return { ok: false, error: GENERIC };

	// --- 4. フォームを本当に開いたか・速すぎないか ---
	//
	// 秘密と回数制限の数えを**1回の読みでまとめて取る**。別々に読むと、
	// それだけでホストを呼べる回数（10回）を使い切ってしまう。
	const state = await readGuardState(ctx);
	const verdict = await verifyFormToken(state.secret, form._t ?? "", settings);
	if (verdict !== "ok") {
		// 期限切れだけは、利用者が直せるので別の文面にする。
		return {
			ok: false,
			error:
				verdict === "expired"
					? "フォームを開いてから時間が経ちました。ページを再読み込みして、もう一度お試しください。"
					: GENERIC,
		};
	}

	// --- 5. 入力の検証 ---
	const { fields, errors } = validate(form);
	if (!fields) {
		return { ok: false, error: "入力をご確認ください。", fields: errors as Record<string, string> };
	}

	// --- 6. 回数制限（Turnstile の往復より先に数える） ---
	const meta = routeCtx.requestMeta as { ip?: string | null } | undefined;
	const ip = typeof meta?.ip === "string" && meta.ip.length > 0 ? meta.ip : null;
	if (!ip) {
		// 接続元が取れないと制限がかけられない。かけられないなら受けない。
		safeLog(ctx, "error", "問い合わせ：接続元が取れないため受け付けない");
		return { ok: false, error: GENERIC };
	}
	const ipKey = await rateKeyForIp(state.secret, ip, "ip");
	const rate = await checkRate(ctx, settings, state, ipKey);
	if (rate !== "ok") {
		safeLog(ctx, "info", "問い合わせ：回数制限で拒否", { reason: rate });
		return {
			ok: false,
			error: "短い間に送信が続いています。しばらく時間をおいてから、もう一度お試しください。",
		};
	}

	// --- 7. Turnstile（人かどうかを Cloudflare 側で確かめる） ---
	const turnstile = await verifyTurnstile(
		ctx,
		settings.turnstileSecretKey,
		form["cf-turnstile-response"] ?? "",
		ip,
	);
	if (!turnstile.ok) {
		safeLog(ctx, "info", "問い合わせ：Turnstile で拒否", { detail: turnstile.detail });
		return { ok: false, error: "確認に失敗しました。ページを再読み込みして、もう一度お試しください。" };
	}

	// --- 8. 保存（先に残す。メールが失敗しても問い合わせを落とさない） ---
	const id = crypto.randomUUID();
	const createdAt = new Date().toISOString();
	const record: StoredMessage = {
		name: fields.name,
		email: fields.email,
		message: fields.message,
		status: "new",
		createdAt,
		notified: false,
		autoReplied: false,
		// **メールを試す前に書く。**畳まれて書き戻しが消えても、
		// 何が渡っていたかだけは残る（2026-10-28、本番で丸ごと消えたため）。
		mailDiag: describeMailContext(ctx),
	};
	try {
		await ctx.storage[COLLECTION].put(id, record);
	} catch (error) {
		safeLog(ctx, "error", "問い合わせ：保存に失敗", { error: String(error) });
		return { ok: false, error: GENERIC };
	}

	const received = formatReceived(new Date(createdAt));
	const siteName = settings.siteName || "サイト";

	// --- 9〜10. メール。**ここで何が起きても、保存した事実は失わない。**
	//
	// 2026-10-28、本番でここから先が丸ごと落ちた。結果の書き戻しまで届かず、
	// 理由すら残らないまま、送信者にはエラーが出た。**問い合わせはもう保存済みで、
	// メールはそのあとの通知でしかない。**通知の失敗で送信者に失敗を返してはいけないし、
	// 何が起きたのかが残らないのはもっと悪い。だから丸ごと囲って、理由を記録に残す。
	try {
		await deliverMail(ctx, settings, fields, record, { id, received, siteName });
	} catch (error) {
		record.mailStageError = String(error).slice(0, 200);
	}

	// メールの結果を書き戻す。失敗しても、送信者には成功を返す（保存は済んでいる）。
	try {
		await ctx.storage[COLLECTION].put(id, record);
	} catch (error) {
		safeLog(ctx, "error", "問い合わせ：メールの結果の記録に失敗", { error: String(error) });
	}

	return { ok: true };
}

/**
 * サンドボックスに何が渡っているかを短く記録する。
 *
 * **秘密は入れない。**型の名前だけを見る。本番でだけ落ちる理由を、
 * ログの見えない場所から持ち帰るための窓口。
 */
function describeMailContext(ctx: PluginContext): string {
	const bag = ctx as unknown as { email?: { send?: unknown }; log?: unknown; http?: unknown };
	return [
		`email:${typeof bag.email}`,
		`send:${typeof bag.email?.send}`,
		`log:${typeof bag.log}`,
		`http:${typeof bag.http}`,
	].join("/");
}

/** 通知と確認メールを出す。失敗は record に書くだけで、投げ返さない。 */
async function deliverMail(
	ctx: PluginContext,
	settings: Settings,
	fields: { name: string; email: string; message: string },
	record: StoredMessage,
	meta: { id: string; received: string; siteName: string },
): Promise<void> {
	// --- 9. 運営者への通知 ---
	const notifyText = buildNotifyText(fields, meta.id, meta.received);
	const notify = await sendMail(ctx, settings, {
		to: settings.notifyTo,
		// 件名に入力を混ぜない。混ぜると、受信箱の見た目を相手に作らせることになる。
		subject: "[問い合わせ] 新しいご相談が届きました",
		// 返信でそのまま返せるようにする。形は検証済みで、改行は落としてある。
		replyTo: fields.email,
		text: notifyText,
		html: asHtmlBody(notifyText),
	});
	if (notify.ok) {
		record.notified = true;
	} else {
		// **ここでログへ書かない。**理由は記録に残す。このあとに確認メールと
		// 書き戻しが控えていて、ログの1回でその書き戻しが予算から出る。
		record.notifyError = notify.detail;
	}

	// --- 10. 問い合わせた人への確認メール ---
	//
	// 宛先が**利用者の入力**である点が通知と決定的に違う。件名に入力を入れず、
	// 本文の写しは既定で付けない（付けると、Turnstile を通せる人が、選んだ宛先へ、
	// 選んだ文章を、このドメインの差出人で届けられることになる）。
	if (!settings.autoReply) return;

	const body = buildAutoReplyText(
		settings.autoReplyBody,
		{ name: fields.name, id: meta.id, received: meta.received, site: meta.siteName },
		fields.message,
		settings.autoReplyIncludeMessage,
		settings.autoReplyMessageHeading,
	);
	const reply = await sendMail(ctx, settings, {
		to: fields.email,
		subject: settings.autoReplySubject,
		replyTo: settings.notifyTo,
		text: body,
		html: asHtmlBody(body),
	});
	if (reply.ok) {
		record.autoReplied = true;
	} else {
		// 相手のアドレスが受け取れない（打ち間違い・存在しない）ことは普通に起きる。
		// **通知と同じで、ログへは書かない。**このあとに書き戻しが控えている。
		record.autoReplyError = reply.detail;
	}
}

/* ------------------------------------------------------------------ *
 * 管理画面
 * ------------------------------------------------------------------ */

type Interaction =
	| { type: "page_load"; page: string }
	| { type: "block_action"; action_id: string; value?: unknown; page?: string }
	| { type: "form_submit"; action_id: string; values: Record<string, unknown>; page?: string };

function readInteraction(input: unknown): Interaction | null {
	const raw = input as Record<string, unknown> | null;
	if (!raw || typeof raw.type !== "string") return null;
	if (raw.type === "page_load" && typeof raw.page === "string") {
		return { type: "page_load", page: raw.page };
	}
	if (raw.type === "block_action" && typeof raw.action_id === "string") {
		return {
			type: "block_action",
			action_id: raw.action_id,
			value: raw.value,
			page: typeof raw.page === "string" ? raw.page : undefined,
		};
	}
	if (raw.type === "form_submit" && typeof raw.action_id === "string") {
		return {
			type: "form_submit",
			action_id: raw.action_id,
			values: (raw.values as Record<string, unknown>) ?? {},
			page: typeof raw.page === "string" ? raw.page : undefined,
		};
	}
	return null;
}

/**
 * 秘密が入っているかだけを見る。**値は画面に返さない。**
 *
 * 読み込み済みの設定から出す。`ctx.settings.get()` を2回呼ぶと、
 * それだけでホストを呼べる回数（10回）を2つ使う。
 */
function hasSecretsOf(settings: Settings) {
	return {
		turnstileSecretKey: settings.turnstileSecretKey.length > 0,
		cloudflareApiToken: settings.cloudflareApiToken.length > 0,
	};
}

/** 文字で入れる項目。空文字も「消した」として受ける（宛先を空にしたいことはある）。 */
const TEXT_KEYS = [
	"siteName",
	"notifyTo",
	"senderAddress",
	"allowedOrigin",
	"turnstileSiteKey",
	"mailProvider",
	"cloudflareAccountId",
	"autoReplySubject",
	"autoReplyBody",
	"autoReplyMessageHeading",
] as const;

const BOOL_KEYS = ["autoReply", "autoReplyIncludeMessage"] as const;

const NUMBER_KEYS = [
	"retentionDays",
	"perIpPerHour",
	"perIpPerDay",
	"globalPerHour",
	"minFillSeconds",
	"formTtlSeconds",
] as const;

/** 空のまま保存されたら**上書きしない**項目（うっかり秘密を消さないため）。 */
const SECRET_KEYS = ["turnstileSecretKey", "cloudflareApiToken"] as const;

/**
 * フォームから来た値を設定へ書く。
 *
 * **届いた項目だけを書く。**フォームに無い項目を既定値で埋めると、
 * 画面に出していない設定を黙って書き換えてしまう。
 */
async function saveSettings(
	ctx: PluginContext,
	values: Record<string, unknown>,
	current: Settings,
): Promise<{ saved: number; skipped: number; next: Settings }> {
	const next: Settings = { ...current };
	const changes: Array<[string, unknown]> = [];

	for (const key of TEXT_KEYS) {
		if (!(key in values)) continue;
		const value = values[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed === (current as unknown as Record<string, unknown>)[key]) continue;
		changes.push([key, trimmed]);
		(next as unknown as Record<string, unknown>)[key] = trimmed;
	}

	for (const key of BOOL_KEYS) {
		if (!(key in values)) continue;
		const value = values[key] === true;
		if (value === (current as unknown as Record<string, unknown>)[key]) continue;
		changes.push([key, value]);
		(next as unknown as Record<string, unknown>)[key] = value;
	}

	for (const key of NUMBER_KEYS) {
		if (!(key in values)) continue;
		const n = Number(values[key]);
		if (!Number.isFinite(n)) continue;
		const value = Math.floor(n);
		if (value === (current as unknown as Record<string, unknown>)[key]) continue;
		changes.push([key, value]);
		(next as unknown as Record<string, unknown>)[key] = value;
	}

	for (const key of SECRET_KEYS) {
		const value = values[key];
		// 空（または未入力）なら触らない。**入れ直さずに他の項目だけ直せるようにする。**
		if (typeof value !== "string" || value.trim().length === 0) continue;
		const trimmed = value.trim();
		if (trimmed === (current as unknown as Record<string, unknown>)[key]) continue;
		changes.push([key, trimmed]);
		(next as unknown as Record<string, unknown>)[key] = trimmed;
	}

	// **1回に書ける数には上限がある。**設定の読み出しで1回使うので、
	// 書けるのは残り9回。余裕を見て8件で切り、残りは次の保存に回す。
	// ここを超えて書くと、ホスト側で止まって**保存そのものが落ちる**（400 が返る）。
	const writable = changes.slice(0, MAX_SETTING_WRITES);
	for (const [key, value] of writable) await ctx.settings.set(key, value);

	// ログは書かない。**`ctx.log` も1回**で、8件書いた直後は 1+8+1 で上限ちょうどになる。
	// 保存できたことは画面に出るので、ログで確かめる必要もない。
	const skipped = changes.length - writable.length;
	return { saved: writable.length, skipped, next };
}

/**
 * 毎日の後始末が登録されていることを確かめる。
 *
 * `plugin:activate` でも登録しているが、**設定で読み込まれるプラグインでは
 * その hook が走らないことがある**（本番で実測。`_plugin_state` に行が出ない）。
 * 登録は同じ名前なら上書きなので、何度呼んでも増えない。
 */
async function ensurePurgeTask(ctx: PluginContext): Promise<void> {
	try {
		// 毎日1回。UTC 18:17 ＝ 日本時間の翌 3:17。
		await ctx.cron?.schedule(PURGE_TASK, { schedule: "17 18 * * *" });
	} catch (error) {
		safeLog(ctx, "error", "後始末の登録に失敗", { error: String(error) });
	}
}

async function listState(ctx: PluginContext, cursor?: string) {
	const collection = ctx.storage[COLLECTION];
	const [page, total, unread] = await Promise.all([
		collection.query({ orderBy: { createdAt: "desc" }, limit: PAGE_SIZE, cursor }),
		collection.count(),
		collection.count({ status: "new" }),
	]);
	return {
		items: page.items as Array<{ id: string; data: StoredMessage }>,
		cursor: page.hasMore ? page.cursor : undefined,
		total,
		unread,
	};
}

/** 受け口の URL。設定ページの雛形に出すので、推測ではなく要求の URL から作る。 */
function routeUrls(requestUrl: string): { origin: string; submitUrl: string; tokenUrl: string } {
	try {
		const url = new URL(requestUrl);
		// `/_emdash/api/plugins/<id>/admin` から末尾の `/admin` を落とす。
		const base = `${url.origin}${url.pathname.replace(/\/[^/]*$/, "")}`;
		return { origin: url.origin, submitUrl: `${base}/submit`, tokenUrl: `${base}/token` };
	} catch {
		return { origin: "", submitUrl: "/submit", tokenUrl: "/token" };
	}
}

async function handleAdmin(
	routeCtx: { input: unknown; request: { url: string }; ui?: unknown },
	ctx: PluginContext,
): Promise<BlockResponse> {
	const interaction = readInteraction(routeCtx.input);
	if (!interaction) return { blocks: [] };

	const settings = await readSettings(ctx);
	const missing = missingRequirements(settings);
	const surface = (routeCtx.ui as { surface?: string } | undefined)?.surface;
	const collection = ctx.storage[COLLECTION];

	// --- ダッシュボードのウィジェット ---
	if (surface === "dashboard-widget" || interaction.page === WIDGET_ID) {
		const state = await listState(ctx);
		return inboxWidget({
			unread: state.unread,
			total: state.total,
			latest: state.items[0],
			missing,
		});
	}

	// --- 設定の保存 ---
	if (interaction.type === "form_submit" && interaction.action_id === SAVE_SETTINGS) {
		// **読み直さない。**書いた値は手元にあるので、もう一度 `settings.list()` を
		// 呼ぶと、それだけで書ける数が1つ減る。
		const { saved, skipped, next } = await saveSettings(ctx, interaction.values, settings);
		return settingsPage({
			settings: next,
			missing: missingRequirements(next),
			...routeUrls(routeCtx.request.url),
			hasSecrets: hasSecretsOf(next),
			toast:
				skipped > 0
					? {
							message: `${saved}件を保存しました。一度に保存できるのは${MAX_SETTING_WRITES}件までです。残り${skipped}件は、もう一度「保存する」を押してください。`,
							type: "info",
						}
					: { message: `設定を保存しました（${saved}件）。`, type: "success" },
		});
	}

	// --- 預かっている秘密を消す ---
	//
	// **消す口が無いと、要らなくなった鍵を預かり続けることになる。**
	// 秘密の欄は空保存で変えない作りなので、画面からは消せなかった。
	if (interaction.type === "block_action" && interaction.action_id === CLEAR_SECRET) {
		if (!isClearableSecret(interaction.value)) {
			// 名前が合わないものは受け付けない。**任意の設定を空にされないため。**
			return settingsPage({
				settings,
				missing,
				...routeUrls(routeCtx.request.url),
				hasSecrets: hasSecretsOf(settings),
				toast: { message: "その項目は消せません。", type: "error" },
			});
		}
		const key = interaction.value;
		// **秘密の設定は、空にするときも暗号化を通る。**`EMDASH_ENCRYPTION_KEY` が
		// 無いサイトでは、ここで投げて 400 になる。**消せないことを画面で言う**ほうが、
		// 原因の分からない 400 よりよい（入れている人には直せる理由だから）。
		try {
			await ctx.settings.set(key, "");
		} catch (error) {
			return settingsPage({
				settings,
				missing,
				...routeUrls(routeCtx.request.url),
				hasSecrets: hasSecretsOf(settings),
				toast: {
					message: `${CLEARABLE_SECRETS[key].label}を消せませんでした。${
						String(error).includes("EMDASH_ENCRYPTION_KEY")
							? "秘密の設定には EMDASH_ENCRYPTION_KEY が必要です（空にするときも暗号化を通るため）。"
							: String(error).slice(0, 120)
					}`,
					type: "error",
				},
			});
		}
		const next: Settings = { ...settings, [key]: "" };
		return settingsPage({
			settings: next,
			missing: missingRequirements(next),
			...routeUrls(routeCtx.request.url),
			hasSecrets: hasSecretsOf(next),
			toast: {
				message: `${CLEARABLE_SECRETS[key].label}を消しました。`,
				type: "success",
			},
		});
	}

	// --- 設定ページ ---
	if (interaction.type === "page_load" && interaction.page === SETTINGS_PAGE) {
		// **有効化の hook に頼らずに、ここでも後始末の登録を確かめる。**
		// 設定で読み込まれるプラグインは plugin:activate が走らないことがある。
		await ensurePurgeTask(ctx);
		return settingsPage({
			settings,
			missing,
			...routeUrls(routeCtx.request.url),
			hasSecrets: hasSecretsOf(settings),
		});
	}

	// --- 1件を開く・状態を変える・削除する ---
	if (interaction.type === "block_action") {
		const id = typeof interaction.value === "string" ? interaction.value : "";

		if (interaction.action_id === "open" && id) {
			const data = (await collection.get(id)) as StoredMessage | null;
			if (!data) {
				const state = await listState(ctx);
				return messagesList({
					...state,
					missing,
					toast: { message: "その問い合わせは見つかりませんでした。", type: "error" },
				});
			}
			return messageDetail(id, data);
		}

		if ((interaction.action_id === "mark_read" || interaction.action_id === "mark_new") && id) {
			const next = interaction.action_id === "mark_read" ? "read" : "new";
			const data = (await collection.get(id)) as StoredMessage | null;
			if (data) {
				const updated: StoredMessage = { ...data, status: next };
				await collection.put(id, updated);
				return messageDetail(id, updated, {
					message: next === "read" ? "既読にしました。" : "未読に戻しました。",
					type: "success",
				});
			}
		}

		if (interaction.action_id === "delete" && id) {
			const deleted = await collection.delete(id);
			const state = await listState(ctx);
			return messagesList({
				...state,
				missing,
				toast: deleted
					? { message: "削除しました。", type: "success" }
					: { message: "すでに削除されています。", type: "info" },
			});
		}

		if (interaction.action_id === "browse") {
			const next = (interaction.value as { cursor?: string } | undefined)?.cursor;
			const state = await listState(ctx, typeof next === "string" ? next : undefined);
			return messagesList({ ...state, missing });
		}
	}

	// --- 一覧（既定） ---
	await ensurePurgeTask(ctx);
	const state = await listState(ctx);
	return messagesList({ ...state, missing });
}

/* ------------------------------------------------------------------ *
 * 保存期間の後始末
 * ------------------------------------------------------------------ */

/**
 * 保存期間を過ぎた問い合わせを消す。
 *
 * **設定に「1年」と入れた以上、書いたとおりに消えなければ文面が嘘になる。**
 * 消すのは本文・氏名・メールを含む記録そのものなので、取り違えないよう
 * `createdAt` だけを基準にする（`status` では判断しない）。
 */
export async function purgeMessages(ctx: PluginContext, settings: Settings): Promise<number> {
	if (settings.retentionDays <= 0) return 0;
	const cutoff = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000).toISOString();
	const collection = ctx.storage[COLLECTION];

	let removed = 0;
	// 1周で消し切らないことがあるので、取れた分だけ消して残りは次の実行に任せる。
	for (let page = 0; page < 20; page++) {
		const result = await collection.query({
			where: { createdAt: { lt: cutoff } },
			orderBy: { createdAt: "asc" },
			limit: 100,
		});
		if (result.items.length === 0) break;
		removed += await collection.deleteMany(result.items.map((item) => item.id));
		if (!result.hasMore) break;
	}
	return removed;
}

/**
 * 古い回数制限の記録を消す。
 *
 * 数え上げは枠ごとに行を増やさず上書きしているので、残るのは
 * **もう来ない送信元の分だけ。**日をまたいだものを落とす。
 */
export async function purgeRateKeys(ctx: PluginContext, now = new Date()): Promise<number> {
	const today = now.toISOString().slice(0, 10);
	const entries = await ctx.kv.list("rate:");
	let removed = 0;
	for (const entry of entries) {
		const value = entry.value as { window?: unknown } | null;
		const window = typeof value?.window === "string" ? value.window : "";
		// 枠の文字列は、時なら `2026-10-28T09`、日なら `2026-10-28`。どちらも先頭10文字が日付。
		if (window.slice(0, 10) < today) {
			if (await ctx.kv.delete(entry.key)) removed += 1;
		}
	}
	return removed;
}

/* ------------------------------------------------------------------ *
 * 組み立て
 * ------------------------------------------------------------------ */

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			// 署名の素をここで用意しておく（最初の送信で作ると、その1回ぶん余計に呼ぶ）。
			await readGuardState(ctx);
			// 毎日1回。UTC 18:17 ＝ 日本時間の翌 3:17。
			await ensurePurgeTask(ctx);
			safeLog(ctx, "info", "問い合わせフォーム：有効にした", { task: PURGE_TASK });
		},

		cron: async (event, ctx) => {
			if (event.name !== PURGE_TASK) return;
			const settings = await readSettings(ctx);
			try {
				const messages = await purgeMessages(ctx, settings);
				const rates = await purgeRateKeys(ctx);
				// **走ったことを後から確かめられるようにする。**件数だけでは
				// 「0件だった」と「動いていない」の区別がつかない。
				await ctx.kv.set("state:lastPurge", {
					at: new Date().toISOString(),
					retentionDays: settings.retentionDays,
					messages,
					rates,
					status: "ok",
				});
				safeLog(ctx, "info", "問い合わせフォーム：後始末", {
					messages,
					rates,
					retentionDays: settings.retentionDays,
				});
			} catch (error) {
				await ctx.kv.set("state:lastPurge", {
					at: new Date().toISOString(),
					status: "error",
					detail: String(error).slice(0, 300),
				});
				safeLog(ctx, "error", "問い合わせフォーム：後始末に失敗", { error: String(error) });
				throw error;
			}
		},
	},

	routes: {
		// フォームを開いたときに取る札。**公開**（まだ誰でもない人が取るものなので）。
		token: {
			public: true,
			methods: ["GET"],
			cacheControl: "no-store",
			request: { body: "none" },
			handler: async (_routeCtx, ctx) => {
				const settings = await readSettings(ctx);
				if (missingRequirements(settings).length > 0) {
					return { ok: false, error: "フォームは準備中です。" };
				}
				const { secret } = await readGuardState(ctx);
				return {
					ok: true,
					token: await issueFormToken(secret),
					siteKey: settings.turnstileSiteKey,
					minFillSeconds: settings.minFillSeconds,
				};
			},
		},

		// 送信の受け口。**公開**。入口での検証はすべて handler の中で行う。
		submit: {
			public: true,
			methods: ["POST"],
			cacheControl: "no-store",
			request: {
				body: "form-data",
				maxBytes: LIMITS.bodyBytes,
				// 宣言した名前のヘッダだけが handler に届く。
				headers: ["origin"],
			},
			handler: async (routeCtx, ctx) => handleSubmit(routeCtx as SubmitContext, ctx),
		},

		// 管理画面。既定で非公開（権限が要る）。
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx, ctx),
		},
	},
};

export default plugin;
