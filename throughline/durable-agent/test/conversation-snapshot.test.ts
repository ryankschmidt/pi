// The snapshot writer writes every byte or fails (Rereview5-2 #1): a short write must never leave an incomplete file
// that the tool then publishes as complete.
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeAll } from "../src/conversation-snapshot.ts";

const text = `${JSON.stringify({ entry: { id: 1, text: "Plain ascii, then multibyte: é 漢字 🙂" } })}\n`.repeat(40);

test("short writes are continued until every byte is written, across multibyte text", () => {
	const file = join(mkdtempSync(join(tmpdir(), "snapshot-write-")), "out");
	const fd = openSync(file, "w");
	// Each call writes at most 7 bytes, so writes end inside multibyte characters and records.
	writeAll(fd, Buffer.from(text), (handle, bytes, offset, length) => writeSync(handle, bytes, offset, Math.min(7, length)));
	closeSync(fd);
	assert.equal(readFileSync(file, "utf8"), text);
});

test("a write that makes no progress fails instead of returning", () => {
	const fd = openSync(join(mkdtempSync(join(tmpdir(), "snapshot-write-")), "out"), "w");
	assert.throws(() => writeAll(fd, Buffer.from(text), () => 0), /wrote no bytes/);
	closeSync(fd);
});
