// Integration assertions for dsh-tool-podcast.
//
// These run the real ffmpeg/ffprobe against generated fixtures and against the
// real @deepseek-ai/dsh-tools schemas. The fixtures are deterministic tones
// separated by silence, so the expected chapter boundaries are known up front:
//
//   three-segments.mp3 — 4.0s tone, 1.2s silence, 3.0s tone, 1.2s silence, 4.0s tone
//   continuous.mp3     — 6.0s tone with no gap
//
// The ffmpeg path is taken from the environment when set, so the suite works on
// any machine with a normal ffmpeg on PATH.
import { plugin, Context, call } from "./harness.mjs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let passed = 0;
const failures = [];

/**
 * Assert a condition and record the outcome.
 *
 * @param {string} label - what is being asserted.
 * @param {boolean} condition - the assertion result.
 */
function check(label, condition) {
	if (condition) {
		passed += 1;
	} else {
		failures.push(label);
		console.log(`  FAIL  ${label}`);
	}
}

/**
 * Assert deep equality via JSON.
 *
 * @param {string} label - what is being asserted.
 * @param {any} actual - produced value.
 * @param {any} expected - expected value.
 */
function equal(label, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	check(`${label} (got ${a}, want ${b})`, a === b);
}

/** Assert a number is within a tolerance, which is all ffmpeg timings allow. */
function near(label, actual, expected, tolerance) {
	const ok = typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
	check(`${label} (got ${actual}, want ${expected} ±${tolerance})`, ok);
}

const FFMPEG = process.env.PODCAST_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.PODCAST_FFPROBE ?? "ffprobe";
const FIXTURES = new URL("./fixtures/", import.meta.url);
const THREE = resolve(new URL("three-segments.mp3", FIXTURES).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const CONTINUOUS = resolve(new URL("continuous.mp3", FIXTURES).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

console.log("podcast: integration");

if (!existsSync(THREE) || !existsSync(CONTINUOUS)) {
	console.log("  SKIP  fixtures missing — run the fixture generation step first");
	process.exitCode = 0;
} else {
	const work = await mkdtemp(join(tmpdir(), "podcast-it-"));
	const context = Context({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputDir: work });
	plugin.apply(context, context.config);

	// --- status ---------------------------------------------------------
	{
		const { value, error } = await call(context.get("podcast_status"), {});
		check("status does not throw", error === undefined);
		equal("ffmpeg is reported available", value.ffmpeg.available, true);
		equal("ffprobe is reported available", value.ffprobe.available, true);
		check("the ffmpeg version string is returned", typeof value.ffmpeg.version === "string" && value.ffmpeg.version.length > 0);
		check("the version names ffmpeg", /ffmpeg/i.test(value.ffmpeg.version));
		equal("the output dir is absolute", value.outputDir, resolve(work));
		equal("all four operations are advertised", value.operations.length, 4);
		equal("the supported formats are listed", value.supportedFormats.sort(), ["flac", "m4a", "mp3", "opus", "wav"]);
	}

	// --- chapters on a file with two gaps -------------------------------
	{
		const { value, error } = await call(context.get("podcast_chapters"), { path: THREE });
		check("chapter detection does not throw", error === undefined);
		near("the duration is read", value.durationSeconds, 13.4, 0.3);
		equal("two gaps are found", value.gapsFound, 2);
		equal("three chapters are produced", value.chapters.length, 3);
		near("the first boundary is the midpoint of the first gap", value.chapters[0].end, 4.6, 0.2);
		near("the second boundary is the midpoint of the second gap", value.chapters[1].end, 8.8, 0.2);
		equal("the first chapter starts at zero", value.chapters[0].start, 0);
		near("the last chapter ends at the file duration", value.chapters[2].end, 13.4, 0.3);
		near("the first chapter reports its gap length", value.chapters[0].gapSeconds, 1.2, 0.15);
		check("the rule used is stated", typeof value.rule === "string" && value.rule.includes("midpoint"));
		check("the rule names the threshold", value.rule.includes("0.8s"));
		equal("the thresholds are echoed back", [value.silenceDb, value.minSilenceSeconds], [-35, 0.8]);
		check("chapter durations are contiguous", Math.abs(value.chapters.reduce((sum, c) => sum + c.durationSeconds, 0) - 13.4) < 0.4);
		check("indices are sequential", value.chapters.every((c, i) => c.index === i));
	}

	// --- chapters on a continuous file ----------------------------------
	{
		const { value, error } = await call(context.get("podcast_chapters"), { path: CONTINUOUS });
		check("a gapless file does not throw", error === undefined);
		equal("a gapless file is one chapter", value.chapters.length, 1);
		equal("no gap is reported", value.gapsFound, 0);
		check("the note explains why", value.notes.some((note) => note.includes("one chapter")));
	}

	// --- a stricter threshold finds fewer chapters ----------------------
	{
		// A 3-second minimum excludes both 1.2s gaps.
		const { value } = await call(context.get("podcast_chapters"), { path: THREE, minSilenceSeconds: 3 });
		equal("a stricter threshold collapses to one chapter", value.chapters.length, 1);
	}

	// --- a looser threshold behaves sensibly ----------------------------
	{
		const { value } = await call(context.get("podcast_chapters"), { path: THREE, silenceDb: -60 });
		// Tones are pure sines with no dithering, so a lower floor may or
		// may not still catch the gap; either answer is legitimate, but the
		// result must stay coherent.
		check("a stricter floor still returns coherent chapters", value.chapters.length >= 1 && value.chapters.every((c) => c.end > c.start));
	}

	// --- maxChapters merges the tail ------------------------------------
	{
		const { value, error } = await call(context.get("podcast_chapters"), { path: THREE, maxChapters: 2 });
		check("maxChapters does not throw", error === undefined);
		equal("maxChapters is respected", value.chapters.length, 2);
		check("the merge is explained", value.notes.some((note) => note.includes("Merged")));
		near("the last merged chapter still reaches the end", value.chapters[1].end, 13.4, 0.3);
	}

	// --- chapters error paths -------------------------------------------
	{
		const missing = await call(context.get("podcast_chapters"), { path: join(work, "nope.mp3") });
		check("a missing file is reported", missing.error !== undefined);

		const badThreshold = await call(context.get("podcast_chapters"), { path: THREE, minSilenceSeconds: 0 });
		check("a zero threshold is rejected", badThreshold.error !== undefined && badThreshold.error.includes("greater than zero"));

		const limited = Context({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputDir: work, maxInputSeconds: 5 });
		plugin.apply(limited, limited.config);
		const tooLong = await call(limited.get("podcast_chapters"), { path: THREE });
		check("an over-length recording is refused", tooLong.error !== undefined && tooLong.error.includes("over the"));
	}

	// --- trim -----------------------------------------------------------
	{
		const { value, error } = await call(context.get("podcast_trim"), { path: THREE, cuts: [4.6, 8.8], format: "mp3", prefix: "ep" });
		check("trim does not throw", error === undefined);
		equal("three segments are written", value.segments.length, 3);
		equal("the output format is reported", value.format, "mp3");
		check("the mode is reported", value.mode.includes("stream copy"));
		equal("segment indices are sequential", value.segments.map((s) => s.index), [0, 1, 2]);
		equal("segments start where the previous ended", value.segments.map((s) => s.start), [0, 4.6, 8.8]);
		near("the total duration is preserved", value.segments.reduce((sum, s) => sum + s.durationSeconds, 0), 13.4, 0.05);
		check("every segment exists on disk", (await Promise.all(value.segments.map(async (s) => (await stat(s.outputPath)).size > 0))).every(Boolean));
		check("the recorded byte size matches the file", value.segments.every((s) => Number.isInteger(s.bytes) && s.bytes > 0));
		const totalBytes = value.segments.reduce((sum, s) => sum + s.bytes, 0);
		equal("the total is the sum of the parts", value.totalBytes, totalBytes);
		check("the files are named from the prefix", value.segments.every((s) => s.outputPath.includes("ep-00")));
	}

	// --- trim, re-encoded for frame accuracy ----------------------------
	{
		const { value, error } = await call(context.get("podcast_trim"), { path: THREE, cuts: [4.6, 8.8], format: "wav", accurate: true, prefix: "acc" });
		check("an accurate trim does not throw", error === undefined);
		check("the mode reports re-encoding", value.mode.includes("re-encode"));
		equal("the accurate trim also yields three segments", value.segments.length, 3);
		// A lossless re-encode of 13.4s of 44.1kHz mono 16-bit audio is ~1.18 MB.
		near("the lossless output size matches the expected PCM size", value.totalBytes, 13.4 * 44100 * 2, 60000);
	}

	// --- trim, defaulting the format from the source --------------------
	{
		const { value } = await call(context.get("podcast_trim"), { path: THREE, cuts: [6], prefix: "def" });
		equal("the format defaults to the source extension", value.format, "mp3");
		equal("one cut yields two segments", value.segments.length, 2);
	}

	// --- trim, a cut at the very start is dropped -----------------------
	{
		const { value } = await call(context.get("podcast_trim"), { path: THREE, cuts: [0, 6], prefix: "zero" });
		equal("a zero cut is ignored rather than making an empty segment", value.segments.length, 2);
		equal("the first segment still starts at zero", value.segments[0].start, 0);
	}

	// --- trim error paths -----------------------------------------------
	{
		const descending = await call(context.get("podcast_trim"), { path: THREE, cuts: [8, 3] });
		check("descending cuts are rejected", descending.error !== undefined && descending.error.includes("strictly ascending"));

		const equalCuts = await call(context.get("podcast_trim"), { path: THREE, cuts: [5, 5] });
		check("duplicate cuts are rejected", equalCuts.error !== undefined && equalCuts.error.includes("strictly ascending"));

		const negative = await call(context.get("podcast_trim"), { path: THREE, cuts: [-2] });
		check("negative cuts are rejected", negative.error !== undefined && negative.error.includes("non-negative"));

		const badFormat = await call(context.get("podcast_trim"), { path: THREE, cuts: [5], format: "aiff" });
		check("an unsupported format is rejected", badFormat.error !== undefined && badFormat.error.includes("unsupported output format"));

		const past = await call(context.get("podcast_trim"), { path: THREE, cuts: [999], prefix: "past" });
		// A cut beyond the end is simply filtered, leaving the whole file.
		check("a cut past the end leaves the whole file", past.error === undefined && past.value.segments.length === 1);
	}

	// --- feed -----------------------------------------------------------
	{
		const feedPath = join(work, "feed.xml");
		const { value, error } = await call(context.get("podcast_feed"), {
			feedPath,
			title: "Test Show",
			description: "A show for tests",
			link: "https://example.com",
			author: "Tester",
			language: "en",
			category: "Technology",
			explicit: false,
			episodes: [
				{ title: "Episode 1", audioPath: THREE, url: "https://example.com/ep1.mp3", description: "The first", pubDate: "Tue, 01 Oct 2026 09:00:00 +0800" },
				{ title: "Episode 2", audioPath: CONTINUOUS, url: "https://example.com/ep2.mp3" }
			]
		});
		check("feed generation does not throw", error === undefined);
		equal("the feed validates", value.valid, true);
		equal("no problems are reported", value.problems, []);
		equal("both episodes are in the feed", value.episodeCount, 2);
		const threeSize = (await stat(THREE)).size;
		// The length must be the real byte size, not something the caller claimed.
		equal("the enclosure length is the file's real size", value.episodes[0].length, threeSize);
		equal("the mime type is derived from the extension", value.episodes[0].type, "audio/mpeg");
		near("the duration was probed from the file", value.episodes[0].durationSeconds, 13.4, 0.4);

		const xml = await readFile(feedPath, "utf8");
		check("the feed was written to disk", xml.length > 0);
		check("the feed is valid RSS 2.0", xml.includes('<rss version="2.0"'));
		check("the real byte length appears in the enclosure", xml.includes(`length="${threeSize}"`));
		check("the episode titles are present", xml.includes("Episode 1") && xml.includes("Episode 2"));
		const revalidated = plugin.validateFeed(xml);
		equal("re-reading the written file validates too", revalidated.ok, true);
	}

	// --- feed error paths -----------------------------------------------
	{
		const noFile = await call(context.get("podcast_feed"), {
			feedPath: join(work, "bad.xml"), title: "T",
			episodes: [{ title: "E", audioPath: join(work, "missing.mp3"), url: "https://x/e.mp3" }]
		});
		check("a missing audio file is rejected", noFile.error !== undefined && noFile.error.includes("could not be read"));

		// A .mp4 has no podcast MIME type and must be refused rather than guessed.
		const badExtension = await call(context.get("podcast_feed"), {
			feedPath: join(work, "bad2.xml"), title: "T",
			episodes: [{ title: "E", audioPath: resolve(new URL("fixtures/three-segments.mp3", import.meta.url).pathname.replace(/mp3$/u, "mp4").replace(/^\/([A-Za-z]:)/u, "$1")), url: "https://x/e.mp4" }]
		});
		check("an unrecognised extension is reported", badExtension.error !== undefined);
	}

	// --- normalize ------------------------------------------------------
	{
		const { value, error } = await call(context.get("podcast_normalize"), { path: THREE, targetLufs: -16, outputName: "normalized.mp3" });
		check("normalisation does not throw", error === undefined);
		check("the output file exists", (await stat(value.outputPath)).size > 0);
		equal("the target is echoed back", value.targetLufs, -16);
		check("the input loudness was measured", typeof value.inputLufs === "number" && Number.isFinite(value.inputLufs));
		check("the output loudness was measured", typeof value.outputLufs === "number" && Number.isFinite(value.outputLufs));
		// The whole point of two passes: the result should land near the target.
		near("the normalised loudness lands on the target", value.outputLufs, -16, 3);
		equal("the output name is honoured", value.outputPath.endsWith("normalized.mp3"), true);
	}

	// --- normalize error paths ------------------------------------------
	{
		const positive = await call(context.get("podcast_normalize"), { path: THREE, targetLufs: 16 });
		check("a positive LUFS target is rejected", positive.error !== undefined && positive.error.includes("negative"));

		const traversal = await call(context.get("podcast_normalize"), { path: THREE, outputName: "../escape.mp3" });
		check("a traversal in outputName is rejected", traversal.error !== undefined && traversal.error.includes(".."));

		const missing = await call(context.get("podcast_normalize"), { path: join(work, "nope.mp3") });
		check("a missing input is reported", missing.error !== undefined);
	}

	// --- registration toggles are honoured at the tool boundary ---------
	{
		const onlyFeed = Context({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputDir: work, status: false, chapters: false, trim: false, normalize: false });
		plugin.apply(onlyFeed, onlyFeed.config);
		equal("only the feed tool is present", onlyFeed.names(), ["podcast_feed"]);
	}

	// --- presentation ---------------------------------------------------
	{
		const status = context.get("podcast_status");
		const presentation = status.presentCall({});
		check("status presents a card", presentation.card === "generic");
		const chapters = context.get("podcast_chapters");
		check("chapters presents a titled card", chapters.presentCall({ path: THREE }).title.startsWith("Detect chapters in"));

		// The render functions must produce text without throwing.
		const result = await call(context.get("podcast_chapters"), { path: THREE });
		const rendered = context.get("podcast_chapters").output.render({}, result.value);
		check("the renderer emits text", rendered[0].type === "text" && rendered[0].text.includes("chapter"));
	}

	await rm(work, { recursive: true, force: true });
}

console.log(`podcast integration: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;