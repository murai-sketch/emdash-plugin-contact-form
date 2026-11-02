/** Vite の `?raw`。**ソースそのものを束に入れて持ち込む**ための宣言。 */
declare module "*?raw" {
	const content: string;
	export default content;
}
