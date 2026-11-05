// Times raw SSE text deltas from the broker for a request whose messages end with a tool result, and one without.
//   node proof/broker-sse-probe.ts [baseUrl]
const base = process.argv[2] ?? "http://127.0.0.1:19443";
async function probe(withTool: boolean) {
	const messages: unknown[] = [
		{ role: "user", content: "Run echo hi with bash, then count from 1 to 60, one number per line." },
	];
	if (withTool) {
		messages.push({
			role: "assistant",
			content: [{ type: "tool_use", id: "toolu_p1", name: "bash", input: { command: "echo hi" } }],
		});
		messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_p1", content: "hi\n" }] });
	}
	const t0 = Date.now();
	const res = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "placeholder" },
		body: JSON.stringify({
			model: "claude-opus-5-5",
			max_tokens: 1024,
			stream: true,
			messages,
			tools: [
				{
					name: "bash",
					description: "Run a bash command",
					input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				},
			],
		}),
	});
	const times: number[] = [];
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const count = (decoder.decode(value).match(/text_delta/g) ?? []).length;
		for (let i = 0; i < count; i++) times.push(Date.now() - t0);
	}
	return {
		withTool,
		status: res.status,
		deltas: times.length,
		firstDeltaMs: times[0],
		lastDeltaMs: times.at(-1),
		spreadMs: (times.at(-1) ?? 0) - (times[0] ?? 0),
	};
}
console.log(JSON.stringify(await probe(false)));
console.log(JSON.stringify(await probe(true)));
