import { describe, expect, it } from "vitest";
import { validate } from "../src/guard";

describe("ご相談内容の下限", () => {
	const base = { name: "山田", email: "a@example.com" };

	it("ちょうど10文字は通る（画面には「10文字以上」と出している）", () => {
		const { fields, errors } = validate({ ...base, message: "あ".repeat(10) });
		expect(errors.message).toBeUndefined();
		expect(fields?.message.length).toBe(10);
	});

	it("9文字は弾く", () => {
		const { errors } = validate({ ...base, message: "あ".repeat(9) });
		expect(errors.message).toBeDefined();
	});

	it("末尾の改行や空白は数に入れない（trim するため）", () => {
		const { errors } = validate({ ...base, message: `${"あ".repeat(10)}\n  ` });
		expect(errors.message).toBeUndefined();
	});
});
