// Regenerate the audio fixtures the integration and e2e suites depend on.
//
// The fixtures are synthesised rather than committed as binaries: they are
// deterministic (pure sine tones, known durations, known gaps), so regenerating
// them on any machine with ffmpeg yields equivalent files. That keeps the repo
// small and makes the expected chapter boundaries self-documenting.
//
//   three-segments.mp3 — 4.0s of 440Hz, 1.2s silence, 3.0s of 660Hz,
//                        1.2s silence, 4.0s of 880Hz  → 13.4s, two gaps
//   continuous.mp3     — 6.0s of 440Hz with no gap
//
// With the default threshold (-35dB, 0.8s) the gaps are detected at
// 4.0–5.2 and 8.2–9.4, so the chapter boundaries land at 4.6s and 8.8s.
//
// Usage:
//   node _test/make-fixtures.mjs
//   PODCAST_FFMPEG=/path/to/ffmpeg node _test/make-fixtures.mjs
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const FFMPEG = process.env.PODCAST_FFMPEG ?? "ffmpeg";
const DIRECTORY = resolve(new URL("./fixtures", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

/** Run ffmpeg and reject on a non-zero exit. */
function run(args) {
	return new Promise((settle, fail) => {
		const child = spawn(FFMPEG, args, { windowsHide: true, shell: false });
		let stderr = "";
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => fail(new Error(`cannot start ffmpeg: ${error.message}`)));
		child.once("close", (code) => (code === 0 ? settle() : fail(new Error(stderr.trim().split("\n").slice(-4).join("\n")))));
	});
}

await mkdir(DIRECTORY, { recursive: true });

// Three tone bursts with silence between them, concatenated in the filter graph.
await run([
	"-hide_banner", "-loglevel", "error", "-y",
	"-f", "lavfi", "-i", "sine=frequency=440:duration=4",
	"-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2",
	"-f", "lavfi", "-i", "sine=frequency=660:duration=3",
	"-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2",
	"-f", "lavfi", "-i", "sine=frequency=880:duration=4",
	"-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[out]",
	"-map", "[out]", "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "4",
	resolve(DIRECTORY, "three-segments.mp3")
]);
console.log("wrote three-segments.mp3");

// A single unbroken tone, so chapter detection has nothing to find.
await run([
	"-hide_banner", "-loglevel", "error", "-y",
	"-f", "lavfi", "-i", "sine=frequency=440:duration=6",
	"-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "4",
	resolve(DIRECTORY, "continuous.mp3")
]);
console.log("wrote continuous.mp3");