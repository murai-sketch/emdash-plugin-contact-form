import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	test: {
		env: {
			// 試験は Cloudflare の上で走らないので、要求に `cf` オブジェクトが付かない。
			// EmDash はそのとき `CF-Connecting-IP` を信用しない（偽装できるため）ので、
			// **信用するヘッダをここで宣言する。**本番の Cloudflare では宣言は要らない。
			EMDASH_TRUSTED_PROXY_HEADERS: "cf-connecting-ip",

			// 秘密の設定は**読み書きのどちらも暗号化を通る。**空にするときも通るので、
			// この鍵が無いと「消す」が試験できない（本番には設定済み）。
			//
			// **これは中身がゼロの、見ればそれと分かる試験用の値。**形だけ合わせてある
			// （`emdash_enc_v1_` ＋ 32バイトを base64url にした43文字）。
			// **本番の鍵をここに書かない。**本物は `wrangler secret put` で入れる。
			EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		},
	},
});
