/**
 * 本番の境界を通した試験。
 *
 * `createPluginRuntimeTestHost()` は、実際の権限・公開ルート・ストレージ・
 * メール配送・定期実行を通してくれる。**素関数だけを呼ぶ試験にしない**のが肝で、
 * 「公開ルートが本当に公開なのか」「Turnstile の往復が落ちたときに通してしまわないか」は
 * ここでしか分からない。
 *
 * 外への往復（Turnstile と Cloudflare の API）は `host.http.respond()` で差し替える。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";

type Host = Awaited<ReturnType<typeof createPluginRuntimeTestHost>>;

let host: Host | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type BlockResponseLike = { blocks: unknown[]; toast?: { type?: string; message?: string } };

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ORIGIN = "https://example.test";

/** 受け口が開く最小限の設定。試験ごとに足し引きする。 */
const READY_SETTINGS = {
	siteName: "試験サイト",
	notifyTo: "owner@example.test",
	senderAddress: "contact@example.test",
	turnstileSiteKey: "0x4AAAAAAAAAAAAAAAAAAAAA",
	turnstileSecretKey: "1x0000000000000000000000000000000AA",
	mailProvider: "emdash",
	autoReply: true,
	minFillSeconds: 0,
};

async function setup(settings: Record<string, unknown> = READY_SETTINGS): Promise<Host> {
	const created = await createPluginRuntimeTestHost();
	for (const [key, value] of Object.entries(settings)) {
		await created.fixtures.plugin.setting(key, value);
	}
	await created.actions.plugin.activate();
	return created;
}

/**
 * Turnstile の答えを決める。
 *
 * `http.respond()` は**1回使うと消える待ち行列**なので、呼ぶ回数だけ積む。
 * 積み忘れると往復が失敗し、**プラグインは通さない方へ倒す**（それが正しい挙動）。
 * 余分に積んでも害はない。
 */
async function turnstileSays(h: Host, success: boolean, times = 5) {
	for (let i = 0; i < times; i++) {
		await h.http.respond(
			TURNSTILE_URL,
			new Response(
				JSON.stringify({ success, "error-codes": success ? [] : ["invalid-input-response"] }),
				{ headers: { "content-type": "application/json" } },
			),
		);
	}
}

/** Cloudflare Email Sending の答えを決める。通知と確認メールで2回呼ばれる。 */
async function cloudflareSays(h: Host, url: string, make: () => Response, times = 4) {
	for (let i = 0; i < times; i++) await h.http.respond(url, make());
}

/**
 * ルートの応答は `{ success, data }` で包まれて返る。
 * 中身だけを見たいので、ここで一度ほどく。
 */
async function unwrap(response: Response): Promise<Record<string, unknown>> {
	const envelope = (await response.json()) as { success?: boolean; data?: unknown };
	return (envelope.data ?? envelope) as Record<string, unknown>;
}

async function getToken(h: Host): Promise<string> {
	const response = await h.actions.routes.request("token", { method: "GET", url: `${ORIGIN}/token` });
	const body = await unwrap(response);
	expect(body.ok).toBe(true);
	return body.token as string;
}

type SubmitOverrides = {
	fields?: Record<string, string>;
	origin?: string | null;
	token?: string;
	ip?: string;
};

async function submit(h: Host, overrides: SubmitOverrides = {}) {
	const token = overrides.token ?? (await getToken(h));
	const body = new URLSearchParams({
		name: "山田 太郎",
		email: "visitor@example.net",
		message: "自動返信の確認です。これは試験の送信です。",
		_t: token,
		"cf-turnstile-response": "dummy-turnstile-token",
		...overrides.fields,
	});

	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
	};
	const origin = overrides.origin === undefined ? ORIGIN : overrides.origin;
	if (origin) headers.origin = origin;
	// 接続元は `meta` ではなくヘッダから取られる。**本番の Cloudflare では
	// `cf` オブジェクトがある要求の `CF-Connecting-IP` だけが信用される**ので、
	// 試験では vitest.config.ts で同じ名前を信用するヘッダに宣言している。
	const ip = overrides.ip === undefined ? "203.0.113.9" : overrides.ip;
	if (ip) headers["cf-connecting-ip"] = ip;

	const response = await h.actions.routes.request("submit", {
		method: "POST",
		url: `${ORIGIN}/submit`,
		headers,
		rawBody: body.toString(),
	});
	return { status: response.status, body: await unwrap(response) };
}

/* ------------------------------------------------------------------ *
 * 設定が足りないとき
 * ------------------------------------------------------------------ */

describe("設定が足りないとき", () => {
	it("受け口は閉じている（開ける方へ倒さない）", async () => {
		host = await setup({ notifyTo: "owner@example.test" });
		await turnstileSays(host, true);
		const result = await submit(host, { token: `0.${"a".repeat(64)}` });
		expect(result.body.ok).toBe(false);
		expect(result.body.error).toBe("フォームは準備中です。");
	});

	it("札も渡さない", async () => {
		host = await setup({});
		const response = await host.actions.routes.request("token", { method: "GET", url: `${ORIGIN}/token` });
		expect((await unwrap(response)).ok).toBe(false);
	});

	it("管理画面は「閉じている」と出す", async () => {
		host = await setup({});
		const page = await host.admin.loadPage("/messages");
		const banner = page.blocks.find((b) => b.type === "banner") as { title?: string } | undefined;
		expect(banner?.title).toBe("受け口は閉じています");
	});
});

/* ------------------------------------------------------------------ *
 * 通し（保存とメール2通）
 * ------------------------------------------------------------------ */

describe("正しく送ったとき", () => {
	it("保存され、通知と確認メールが出る", async () => {
		host = await setup();
		await turnstileSays(host, true);

		const result = await submit(host);
		expect(result.body).toEqual({ ok: true });

		const stored = await host.inspect.storage.list("messages");
		expect(stored).toHaveLength(1);
		const record = stored[0].data as Record<string, unknown>;
		expect(record.name).toBe("山田 太郎");
		expect(record.email).toBe("visitor@example.net");
		expect(record.status).toBe("new");
		expect(record.notified).toBe(true);
		expect(record.autoReplied).toBe(true);

		const mails = await host.inspect.email();
		expect(mails).toHaveLength(2);
		const notify = mails.find((m) => m.to === "owner@example.test");
		const confirm = mails.find((m) => m.to === "visitor@example.net");
		expect(notify?.subject).toBe("[問い合わせ] 新しいご相談が届きました");
		expect(confirm?.subject).toBe("お問い合わせを受け付けました");
	});

	it("確認メールに定型の一文と受付IDが入る", async () => {
		host = await setup();
		await turnstileSays(host, true);
		await submit(host);

		const mails = await host.inspect.email();
		const confirm = mails.find((m) => m.to === "visitor@example.net");
		const text = String(confirm?.text ?? "");
		expect(text).toContain("山田 太郎 様");
		expect(text).toContain("担当者が確認のうえ、改めてご連絡いたします。");
		expect(text).toContain("試験サイト");

		const stored = await host.inspect.storage.list("messages");
		expect(text).toContain(stored[0].id);
	});

	it("既定では、いただいた本文の写しを付けない", async () => {
		host = await setup();
		await turnstileSays(host, true);
		await submit(host, { fields: { message: "ここは秘密の相談内容です。写してはいけません。" } });

		const mails = await host.inspect.email();
		const confirm = mails.find((m) => m.to === "visitor@example.net");
		expect(String(confirm?.text)).not.toContain("秘密の相談内容");
		// 運営者への通知には入る（読むために送っているので）。
		const notify = mails.find((m) => m.to === "owner@example.test");
		expect(String(notify?.text)).toContain("秘密の相談内容");
	});

	it("写しを on にすると付く", async () => {
		host = await setup({ ...READY_SETTINGS, autoReplyIncludeMessage: true });
		await turnstileSays(host, true);
		await submit(host, { fields: { message: "ここは秘密の相談内容です。写してはいけません。" } });

		const mails = await host.inspect.email();
		const confirm = mails.find((m) => m.to === "visitor@example.net");
		expect(String(confirm?.text)).toContain("いただいた内容：");
		expect(String(confirm?.text)).toContain("秘密の相談内容");
	});

	it("確認メールを切ると、通知だけが出る", async () => {
		host = await setup({ ...READY_SETTINGS, autoReply: false });
		await turnstileSays(host, true);
		await submit(host);

		const mails = await host.inspect.email();
		expect(mails).toHaveLength(1);
		expect(mails[0].to).toBe("owner@example.test");
		const stored = await host.inspect.storage.list("messages");
		expect((stored[0].data as Record<string, unknown>).autoReplied).toBe(false);
	});

	it("件名に入力が混ざらない", async () => {
		host = await setup();
		await turnstileSays(host, true);
		await submit(host, { fields: { name: "【緊急】至急ご確認ください" } });

		const mails = await host.inspect.email();
		for (const mail of mails) {
			expect(String(mail.subject)).not.toContain("緊急");
		}
	});

	it("名前に $& や {{id}} を入れても文面が壊れない", async () => {
		host = await setup();
		await turnstileSays(host, true);
		await submit(host, { fields: { name: "$& {{id}} $`" } });

		const mails = await host.inspect.email();
		const confirm = mails.find((m) => m.to === "visitor@example.net");
		const text = String(confirm?.text);
		expect(text).toContain("$& {{id}} $` 様");
		// 名前の中の {{id}} が二重に展開されていない＝受付ID は1か所だけ。
		const stored = await host.inspect.storage.list("messages");
		expect(text.split(stored[0].id)).toHaveLength(2);
	});
});

/* ------------------------------------------------------------------ *
 * 防御
 * ------------------------------------------------------------------ */

describe("防御", () => {
	it("罠の欄が埋まっていたら弾く", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const result = await submit(host, { fields: { website: "http://spam.example" } });
		expect(result.body.ok).toBe(false);
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
		expect(await host.inspect.email()).toHaveLength(0);
	});

	it("Origin が無いと弾く", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const result = await submit(host, { origin: null });
		expect(result.body.ok).toBe(false);
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("別サイトの Origin なら弾く", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const result = await submit(host, { origin: "https://evil.example" });
		expect(result.body.ok).toBe(false);
	});

	it("札が改ざんされていたら弾く", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const token = await getToken(host);
		const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
		const result = await submit(host, { token: tampered });
		expect(result.body.ok).toBe(false);
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("札の形が違えば弾く", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const result = await submit(host, { token: "not-a-token" });
		expect(result.body.ok).toBe(false);
	});

	it("速すぎたら弾く", async () => {
		host = await setup({ ...READY_SETTINGS, minFillSeconds: 60 });
		await turnstileSays(host, true);
		const result = await submit(host);
		expect(result.body.ok).toBe(false);
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("入力の不備は欄ごとの文面で返す", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const result = await submit(host, { fields: { email: "not-an-email", message: "短い" } });
		expect(result.body.ok).toBe(false);
		expect(result.body.error).toBe("入力をご確認ください。");
		expect(result.body.fields).toEqual({
			email: "メールアドレスの形を確かめてください。",
			message: "ご相談内容を10文字以上で書いてください。",
		});
	});

	it("リンクが多すぎる本文を弾く", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const links = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(" ");
		const result = await submit(host, { fields: { message: `ご相談です ${links}` } });
		expect(String((result.body.fields as Record<string, string>).message)).toContain("リンクが多すぎます");
	});

	it("Turnstile が不合格なら弾く", async () => {
		host = await setup();
		await turnstileSays(host, false);
		const result = await submit(host);
		expect(result.body.ok).toBe(false);
		expect(String(result.body.error)).toContain("確認に失敗しました");
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("Turnstile の往復が落ちたら、通さない方へ倒す", async () => {
		host = await setup();
		// 応答を用意しない＝往復が失敗する。**ここで通してしまうと素通しになる。**
		const result = await submit(host);
		expect(result.body.ok).toBe(false);
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("接続元が取れないと受け付けない", async () => {
		host = await setup();
		await turnstileSays(host, true);
		const result = await submit(host, { ip: "" });
		expect(result.body.ok).toBe(false);
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("回数制限は、同じ送信元の4回目で効く（1時間に3回まで）", async () => {
		host = await setup({ ...READY_SETTINGS, perIpPerHour: 3 });
		await turnstileSays(host, true);

		for (let i = 0; i < 3; i++) {
			const ok = await submit(host, { fields: { message: `${i} 回目の送信です。試験です。` } });
			expect(ok.body.ok).toBe(true);
		}
		const blocked = await submit(host, { fields: { message: "4 回目の送信です。試験です。" } });
		expect(blocked.body.ok).toBe(false);
		expect(String(blocked.body.error)).toContain("短い間に送信が続いています");
		expect(await host.inspect.storage.list("messages")).toHaveLength(3);
	});

	it("別の送信元は、相手の制限に巻き込まれない", async () => {
		host = await setup({ ...READY_SETTINGS, perIpPerHour: 1 });
		await turnstileSays(host, true);
		expect((await submit(host, { ip: "203.0.113.1" })).body.ok).toBe(true);
		expect((await submit(host, { ip: "203.0.113.1" })).body.ok).toBe(false);
		expect((await submit(host, { ip: "198.51.100.2" })).body.ok).toBe(true);
	});

	it("サイト全体の蓋も効く", async () => {
		host = await setup({ ...READY_SETTINGS, perIpPerHour: 10, globalPerHour: 2 });
		await turnstileSays(host, true);
		expect((await submit(host, { ip: "203.0.113.1" })).body.ok).toBe(true);
		expect((await submit(host, { ip: "198.51.100.2" })).body.ok).toBe(true);
		expect((await submit(host, { ip: "192.0.2.3" })).body.ok).toBe(false);
	});

	it("保存した記録に IP そのものが入っていない", async () => {
		host = await setup();
		await turnstileSays(host, true);
		await submit(host, { ip: "203.0.113.9" });

		const stored = JSON.stringify(await host.inspect.storage.list("messages"));
		expect(stored).not.toContain("203.0.113.9");
		const kv = JSON.stringify(await host.inspect.kv.list());
		expect(kv).not.toContain("203.0.113.9");
	});
});

/* ------------------------------------------------------------------ *
 * メールが届かなかったとき
 * ------------------------------------------------------------------ */

describe("メールが届かなかったとき", () => {
	const CLOUDFLARE = {
		...READY_SETTINGS,
		mailProvider: "cloudflare",
		cloudflareAccountId: "acct123",
		cloudflareApiToken: "token123",
	};
	const SEND_URL = "https://api.cloudflare.com/client/v4/accounts/acct123/email/sending/send";

	it("問い合わせは落とさず、理由を記録に残す", async () => {
		host = await setup(CLOUDFLARE);
		await turnstileSays(host, true);
		await cloudflareSays(host, SEND_URL, () =>
			new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "nope" }] }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await submit(host);
		// **送信者には成功を返す**（保存は済んでいるので、再送を促す意味がない）。
		expect(result.body).toEqual({ ok: true });

		const stored = await host.inspect.storage.list("messages");
		const record = stored[0].data as Record<string, unknown>;
		expect(record.notified).toBe(false);
		expect(String(record.notifyError)).toContain("cloudflare");
	});

	it("Cloudflare へ送る中身が、公式の鍵の名前と合っている", async () => {
		// REST の名前付きアドレスは `{ address, name }`、返信先は `reply_to`。
		// Workers のバインディング（`{ email, name }` / `replyTo`）とは**鍵の名前が違う**。
		host = await setup({ ...CLOUDFLARE, siteName: "野良コンサル山田" });
		await turnstileSays(host, true);
		await cloudflareSays(host, SEND_URL, () =>
			new Response(JSON.stringify({ success: true, errors: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await submit(host);

		const sent = host.http.requests().filter((r) => r.url === SEND_URL);
		expect(sent.length).toBeGreaterThan(0);
		const body = JSON.parse(new TextDecoder().decode(sent[0].body)) as Record<string, unknown>;
		expect(body.from).toEqual({ address: "contact@example.test", name: "野良コンサル山田" });
		expect(body).toHaveProperty("reply_to");
		expect(body).not.toHaveProperty("replyTo");
		expect(typeof body.to).toBe("string");
		expect(typeof body.subject).toBe("string");
	});

	it("メールの経路に何が渡っていたかを記録に残す", async () => {
		// 本番で2通とも「未送信・理由なし」になり、保存のあとが丸ごと落ちていた。
		// **何が渡っていたか**が残っていれば、ログの見えない場所からでも辿れる。
		host = await setup(CLOUDFLARE);
		await turnstileSays(host, true);
		await cloudflareSays(host, SEND_URL, () =>
			new Response(JSON.stringify({ success: false, errors: [] }), {
				status: 500,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await submit(host);
		expect(result.body).toEqual({ ok: true });

		const stored = await host.inspect.storage.list("messages");
		const record = stored[0].data as Record<string, unknown>;
		const diag = String(record.mailDiag);
		expect(diag).toContain("email:");
		expect(diag).toContain("log:");
		// 秘密は入れない。型の名前しか出さない。
		expect(diag).not.toContain("token123");
	});

	it("200 でも success:false なら成功と見ない", async () => {
		host = await setup(CLOUDFLARE);
		await turnstileSays(host, true);
		await cloudflareSays(host, SEND_URL, () =>
			new Response(JSON.stringify({ success: false, errors: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await submit(host);
		const stored = await host.inspect.storage.list("messages");
		expect((stored[0].data as Record<string, unknown>).notified).toBe(false);
	});

	it("API トークンはヘッダにだけ載り、本文には出ない", async () => {
		host = await setup(CLOUDFLARE);
		await turnstileSays(host, true);
		await cloudflareSays(host, SEND_URL, () =>
			new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }),
		);
		await submit(host);

		const calls = host.http.requests().filter((r) => r.url.includes("api.cloudflare.com"));
		expect(calls).toHaveLength(2);
		expect(calls[0].headers.authorization).toBe("Bearer token123");
		expect(new TextDecoder().decode(calls[0].body)).not.toContain("token123");
	});
});

/* ------------------------------------------------------------------ *
 * 保存期間の後始末
 * ------------------------------------------------------------------ */

describe("保存期間の後始末", () => {
	async function seed(h: Host) {
		const day = 24 * 60 * 60 * 1000;
		const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
		const base = {
			name: "名前",
			email: "a@example.net",
			message: "本文",
			status: "new",
			notified: true,
			autoReplied: true,
		};
		await h.fixtures.plugin.storage("messages", "old-1", { ...base, createdAt: ago(400) });
		await h.fixtures.plugin.storage("messages", "old-2", { ...base, createdAt: ago(366) });
		await h.fixtures.plugin.storage("messages", "edge", { ...base, createdAt: ago(364) });
		await h.fixtures.plugin.storage("messages", "fresh", { ...base, createdAt: ago(1) });
	}

	it("1年を過ぎたものだけ消える", async () => {
		host = await setup({ ...READY_SETTINGS, retentionDays: 365 });
		await seed(host);

		await host.transport.invokeHook("cron", { name: "contact-form-purge" });

		const left = (await host.inspect.storage.list("messages")).map((e) => e.id).sort();
		expect(left).toEqual(["edge", "fresh"]);
	});

	it("走った記録が残る（0件と未実行を区別するため）", async () => {
		host = await setup({ ...READY_SETTINGS, retentionDays: 365 });
		await seed(host);
		await host.transport.invokeHook("cron", { name: "contact-form-purge" });

		const state = await host.inspect.kv.get<Record<string, unknown>>("state:lastPurge");
		expect(state?.status).toBe("ok");
		expect(state?.messages).toBe(2);
		expect(state?.retentionDays).toBe(365);
		expect(typeof state?.at).toBe("string");
	});

	it("0 なら消さない（「削除しない」設定）", async () => {
		host = await setup({ ...READY_SETTINGS, retentionDays: 0 });
		await seed(host);
		await host.transport.invokeHook("cron", { name: "contact-form-purge" });
		expect(await host.inspect.storage.list("messages")).toHaveLength(4);
	});

	it("別の名前の定期実行では何もしない", async () => {
		host = await setup({ ...READY_SETTINGS, retentionDays: 365 });
		await seed(host);
		await host.transport.invokeHook("cron", { name: "someone-elses-task" });
		expect(await host.inspect.storage.list("messages")).toHaveLength(4);
		expect(await host.inspect.kv.get("state:lastPurge")).toBeNull();
	});

	it("有効にしたときに毎日の後始末を登録する", async () => {
		host = await setup();
		const tasks = await host.inspect.scheduledTasks();
		expect(JSON.stringify(tasks)).toContain("contact-form-purge");
	});

	it("古い回数制限の記録を落とす", async () => {
		host = await setup({ ...READY_SETTINGS, retentionDays: 365 });
		await host.fixtures.plugin.kv("rate:h:old", { window: "2020-01-01T00", count: 3 });
		await host.fixtures.plugin.kv("rate:g", { window: new Date().toISOString().slice(0, 13), count: 1 });

		await host.transport.invokeHook("cron", { name: "contact-form-purge" });

		expect(await host.inspect.kv.get("rate:h:old")).toBeNull();
		expect(await host.inspect.kv.get("rate:g")).not.toBeNull();
	});
});

/* ------------------------------------------------------------------ *
 * 管理画面とダッシュボード
 * ------------------------------------------------------------------ */

describe("管理画面", () => {
	async function withOneMessage(): Promise<Host> {
		const h = await setup();
		await turnstileSays(h, true);
		await submit(h);
		return h;
	}

	it("ダッシュボードのウィジェットに未読の数が出る", async () => {
		host = await withOneMessage();
		const widget = await host.admin.loadWidget("inbox");
		const stats = widget.blocks.find((b) => b.type === "stats") as
			| { items: Array<{ label: string; value: unknown }> }
			| undefined;
		expect(stats?.items[0]).toMatchObject({ label: "未読", value: 1 });
		expect(stats?.items[1]).toMatchObject({ label: "保存されている数", value: 1 });

		const context = widget.blocks.find((b) => b.type === "context") as { text?: string } | undefined;
		expect(context?.text).toContain("山田 太郎 様");
	});

	it("問い合わせが無いウィジェットは、無いと言う", async () => {
		host = await setup();
		const widget = await host.admin.loadWidget("inbox");
		const context = widget.blocks.find((b) => b.type === "context") as { text?: string } | undefined;
		expect(context?.text).toBe("まだ問い合わせはありません。");
	});

	it("一覧に表が出て、本文の先頭が見える", async () => {
		host = await withOneMessage();
		const page = await host.admin.loadPage("/messages");
		const table = page.blocks.find((b) => b.type === "table") as
			| { rows: Array<Record<string, string>> }
			| undefined;
		expect(table?.rows).toHaveLength(1);
		expect(table?.rows[0]).toMatchObject({ name: "山田 太郎", status: "未読" });
		expect(table?.rows[0].excerpt).toContain("自動返信の確認です");
	});

	it("1件を開くと本文の全文と、メールの結果が出る", async () => {
		host = await withOneMessage();
		const stored = await host.inspect.storage.list("messages");
		const detail = await host.admin.act("/messages", "open", { value: stored[0].id });

		const code = detail.blocks.find((b) => b.type === "code") as { code?: string } | undefined;
		expect(code?.code).toContain("自動返信の確認です。これは試験の送信です。");

		const fields = detail.blocks.find((b) => b.type === "fields") as
			| { fields: Array<{ label: string; value: string }> }
			| undefined;
		const byLabel = Object.fromEntries((fields?.fields ?? []).map((f) => [f.label, f.value]));
		expect(byLabel["運営者への通知"]).toBe("送信済み");
		expect(byLabel["確認メール"]).toBe("送信済み");
	});

	it("既読にできる", async () => {
		host = await withOneMessage();
		const stored = await host.inspect.storage.list("messages");
		const after = await host.admin.act("/messages", "mark_read", { value: stored[0].id });
		expect(after.toast?.message).toBe("既読にしました。");

		const record = await host.inspect.storage.get<Record<string, unknown>>("messages", stored[0].id);
		expect(record?.status).toBe("read");

		const widget = await host.admin.loadWidget("inbox");
		const stats = widget.blocks.find((b) => b.type === "stats") as
			| { items: Array<{ value: unknown }> }
			| undefined;
		expect(stats?.items[0].value).toBe(0);
	});

	it("削除できる", async () => {
		host = await withOneMessage();
		const stored = await host.inspect.storage.list("messages");
		const after = await host.admin.act("/messages", "delete", { value: stored[0].id });
		expect(after.toast?.message).toBe("削除しました。");
		expect(await host.inspect.storage.list("messages")).toHaveLength(0);
	});

	it("設定ページに、貼る雛形と受け口の URL が出る", async () => {
		host = await setup();
		const page = await host.admin.loadPage("/settings");
		const code = page.blocks.find((b) => b.type === "code") as { code?: string } | undefined;
		expect(code?.code).toContain('name="website"');
		expect(code?.code).toContain('data-sitekey="0x4AAAAAAAAAAAAAAAAAAAAA"');
		expect(code?.code).toContain("/submit");
		expect(code?.code).toContain("/token");
	});

	it("設定ページに入力フォームが出る（ここが無いと設定を入れる場所が無い）", async () => {
		host = await setup();
		const page = await host.admin.loadPage("/settings");
		const form = page.blocks.find((b) => b.type === "form") as
			| { fields: Array<{ action_id: string; type: string; has_value?: boolean }>; submit: { action_id: string } }
			| undefined;
		expect(form).toBeDefined();
		expect(form?.submit.action_id).toBe("save_settings");
		const ids = (form?.fields ?? []).map((f) => f.action_id);
		// 20項目すべてに欄がある
		expect(ids).toHaveLength(20);
		for (const key of ["notifyTo", "turnstileSecretKey", "mailProvider", "autoReplyBody", "retentionDays"]) {
			expect(ids).toContain(key);
		}
		// 秘密は secret_input で、入っていることだけ示す
		const secret = form?.fields.find((f) => f.action_id === "turnstileSecretKey");
		expect(secret?.type).toBe("secret_input");
		expect(secret?.has_value).toBe(true);
	});

	/**
	 * 「秘密を消す」ボタンだけを取り出す。
	 *
	 * **`type: "actions"` の最初のブロックを取ってはいけない。**設定が足りないときは
	 * `readinessBlocks` も actions を出すので、そちらを拾ってしまう。
	 */
	function clearButtons(page: BlockResponseLike): string[] {
		for (const block of page.blocks as Array<{ type: string; elements?: unknown }>) {
			if (block.type !== "actions" || !Array.isArray(block.elements)) continue;
			const values = (block.elements as Array<{ action_id?: string; value?: string }>)
				.filter((e) => e.action_id === "clear_secret")
				.map((e) => String(e.value));
			if (values.length > 0) return values.sort();
		}
		return [];
	}

	/** 秘密の欄が「入っている」と言っているか。**プラグインが見ている値そのもの。** */
	function hasValue(page: BlockResponseLike, actionId: string): boolean | undefined {
		const form = (page.blocks as Array<{ type: string; fields?: unknown }>).find(
			(b) => b.type === "form",
		);
		const fields = (form?.fields ?? []) as Array<{ action_id: string; has_value?: boolean }>;
		return fields.find((f) => f.action_id === actionId)?.has_value;
	}

	it("預かっている秘密を、ボタンで消せる", async () => {
		// **空で保存しても消えない作り**なので、消す口が無いと一度入れた鍵は残り続ける。
		host = await setup({ ...READY_SETTINGS, cloudflareApiToken: "token123" });
		const before = await host.admin.loadPage("/settings");
		expect(clearButtons(before)).toEqual(["cloudflareApiToken", "turnstileSecretKey"]);

		const after = await host.admin.act("/settings", "clear_secret", {
			value: "cloudflareApiToken",
		});
		expect(after.toast?.type).toBe("success");

		// **プラグインから見て空になっていること**を見る。保存されている値そのものは
		// 暗号化された入れ物のままで（空文字も暗号化を通る）、生で比べても分からない。
		expect(hasValue(after, "cloudflareApiToken")).toBe(false);
		// もう片方は触っていない
		expect(hasValue(after, "turnstileSecretKey")).toBe(true);

		// 消したので、そのボタンは出なくなる
		const reloaded = await host.admin.loadPage("/settings");
		expect(clearButtons(reloaded)).toEqual(["turnstileSecretKey"]);
	});

	it("消せるのは秘密の2つだけ（任意の設定を空にされない）", async () => {
		host = await setup();
		const after = await host.admin.act("/settings", "clear_secret", { value: "notifyTo" });
		expect(after.toast?.type).toBe("error");
		// 消えていない
		expect(await host.inspect.setting("notifyTo")).toBe(READY_SETTINGS.notifyTo);
	});

	it("秘密が入っていなければ、消すボタンは出ない", async () => {
		host = await setup({ ...READY_SETTINGS, turnstileSecretKey: "" });
		const page = await host.admin.loadPage("/settings");
		expect(clearButtons(page)).toEqual([]);
	});

	it("フォームから保存できる", async () => {
		host = await setup();
		const after = await host.admin.submit("/settings", "save_settings", {
			siteName: "新しい名前",
			notifyTo: "new@example.test",
			autoReply: false,
			retentionDays: 30,
			turnstileSecretKey: "",
		});
		expect(after.toast?.type).toBe("success");

		expect(await host.inspect.setting("siteName")).toBe("新しい名前");
		expect(await host.inspect.setting("notifyTo")).toBe("new@example.test");
		expect(await host.inspect.setting("autoReply")).toBe(false);
		expect(await host.inspect.setting("retentionDays")).toBe(30);
		// **空で出した秘密は上書きしない**（うっかり消さないため）
		expect(await host.inspect.setting("turnstileSecretKey")).toBe(READY_SETTINGS.turnstileSecretKey);
	});

	it("フォームに無い項目は触らない", async () => {
		host = await setup();
		await host.admin.submit("/settings", "save_settings", { siteName: "名前だけ変える" });
		expect(await host.inspect.setting("siteName")).toBe("名前だけ変える");
		expect(await host.inspect.setting("notifyTo")).toBe(READY_SETTINGS.notifyTo);
		expect(await host.inspect.setting("minFillSeconds")).toBe(READY_SETTINGS.minFillSeconds);
	});

	it("設定ページを開くと、後始末の登録を確かめる", async () => {
		host = await setup();
		await host.admin.loadPage("/settings");
		expect(JSON.stringify(await host.inspect.scheduledTasks())).toContain("contact-form-purge");
	});

	it("写しを on にしていると、設定ページが警告する", async () => {
		host = await setup({ ...READY_SETTINGS, autoReplyIncludeMessage: true });
		const page = await host.admin.loadPage("/settings");
		const banners = page.blocks.filter((b) => b.type === "banner") as Array<{ title?: string }>;
		expect(banners.some((b) => b.title === "確認メールに本文の写しを付けています")).toBe(true);
	});
});

/* ------------------------------------------------------------------ *
 * 文面の設定が実際に効くか
 * ------------------------------------------------------------------ */

describe("文面の設定", () => {
	it("件名と本文の雛形を差し替えられる", async () => {
		host = await setup({
			...READY_SETTINGS,
			autoReplySubject: "受付番号 のご連絡",
			autoReplyBody: "{{name}} さん／{{site}}／{{id}}",
		});
		await turnstileSays(host, true);
		await submit(host);

		const confirm = (await host.inspect.email()).find((m) => m.to === "visitor@example.net");
		expect(confirm?.subject).toBe("受付番号 のご連絡");
		const stored = await host.inspect.storage.list("messages");
		expect(String(confirm?.text)).toBe(`山田 太郎 さん／試験サイト／${stored[0].id}`);
	});

	it("写しの見出しを差し替えられる", async () => {
		host = await setup({
			...READY_SETTINGS,
			autoReplyIncludeMessage: true,
			autoReplyMessageHeading: "ご相談の内容",
		});
		await turnstileSays(host, true);
		await submit(host);

		const confirm = (await host.inspect.email()).find((m) => m.to === "visitor@example.net");
		expect(String(confirm?.text)).toContain("ご相談の内容：");
		expect(String(confirm?.text)).not.toContain("いただいた内容：");
	});

	it("保存期間の日数を差し替えられる（30日）", async () => {
		host = await setup({ ...READY_SETTINGS, retentionDays: 30 });
		const day = 24 * 60 * 60 * 1000;
		const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
		const base = { name: "名前", email: "a@example.net", message: "本文", status: "new", notified: true, autoReplied: true };
		await host.fixtures.plugin.storage("messages", "d40", { ...base, createdAt: ago(40) });
		await host.fixtures.plugin.storage("messages", "d20", { ...base, createdAt: ago(20) });

		await host.transport.invokeHook("cron", { name: "contact-form-purge" });

		const left = (await host.inspect.storage.list("messages")).map((e) => e.id);
		expect(left).toEqual(["d20"]);
	});
});

describe("設定の保存", () => {
	// 1回の実行でホストを呼べるのは10回まで。設定の読み出しで1回使うので、
	// **20項目を毎回書くと落ちる**（2026-11-01、本番で 400 が返った）。
	// 変わったものだけ書く、が守られているかを見る。
	it("変わっていない項目は書かない", async () => {
		host = await setup(READY_SETTINGS);
		const before = await host.admin.loadPage("/settings");
		expect(before.blocks.length).toBeGreaterThan(0);

		const same = await host.admin.submit("/settings", "save_settings", {
			siteName: READY_SETTINGS.siteName,
			notifyTo: READY_SETTINGS.notifyTo,
			turnstileSiteKey: READY_SETTINGS.turnstileSiteKey,
			// 秘密は空＝触らない
			turnstileSecretKey: "",
			cloudflareApiToken: "",
		});
		expect(String(same.toast?.message)).toContain("0件");
	});

	it("変えた項目だけ書く", async () => {
		host = await setup(READY_SETTINGS);
		const after = await host.admin.submit("/settings", "save_settings", {
			siteName: "別の名前",
			notifyTo: READY_SETTINGS.notifyTo,
			turnstileSecretKey: "",
		});
		expect(String(after.toast?.message)).toContain("1件");
	});
});
