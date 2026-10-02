// Run every dsh-tool-podcast suite in order and summarise the outcome.
//
// The suites are deliberately separate processes: the logic suite is pure
// arithmetic and finishes instantly, the integration suite drives real ffmpeg
// against short fixtures, and the e2e suite runs a full detect→cut→normalise→
// publish pipeline. Keeping them independent means a slow or wedged encode
// cannot mask a fast assertion failure.
//
// ffmpeg and ffprobe are located through PODCAST_FFMPEG / PODCAST_FFPROBE, and
// fall back to PATH.
//
// Usage: node _test/run-all.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const SUITES = [
	{ name: "logic", file: "_test/test-logic.mjs" },
	{ name: "integration", file: "_test/test-integration.mjs" },
	{ name: "e2e", file: "_test/test-e2e.mjs" }
];

/** Run one suite as a child process and report whether it exited cleanly. */
function run(file) {
	return new Promise((settle) => {
		const child = spawn(process.execPath, [file], { stdio: "inherit", windowsHide: true, env: process.env });
		child.once("close", (code) => settle(code ?? 1));
		child.once("error", () => settle(1));
	});
}

const results = [];
for (const suite of SUITES) {
	if (!existsSync(suite.file)) {
		results.push({ ...suite, code: 1, note: "file missing" });
		continue;
	}
	console.log(`\n${"=".repeat(64)}\n${suite.name}\n${"=".repeat(64)}`);
	const code = await run(suite.file);
	results.push({ ...suite, code });
}

console.log(`\n${"=".repeat(64)}\nsummary\n${"=".repeat(64)}`);
for (const result of results) {
	console.log(`  ${result.code === 0 ? "PASS" : "FAIL"}  ${result.name}${result.note === undefined ? "" : ` (${result.note})`}`);
}

// The Python verifier is the only check that uses a second implementation, so
// it is reported here but not treated as fatal when Python is unavailable.
const verifier = "_test/verify-feed.py";
if (existsSync(verifier)) {
	console.log(`\n  independent verification:  python ${verifier} _test/samples/podcast-feed.xml`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length === 0 ? 0 : 1);