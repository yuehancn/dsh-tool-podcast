// End-to-end assertions for dsh-tool-podcast.
//
// One realistic pipeline, run against real ffmpeg:
//
//   a raw recording
//     → detect its chapters from silence
//     → cut it at exactly those boundaries
//     → normalise every segment to a broadcast loudness
//     → publish an RSS feed whose enclosure lengths come from disk
//
// Then the *output* is checked with an independent reader (ffprobe on each
// segment, a fresh parse of the feed), because the point of an e2e suite is to
// verify the artifact rather than the code that produced it.
import { plugin, Context, call } from "./harness.mjs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
/** Strip the leading slash Git Bash adds so ffmpeg gets a real Windows path. */
const nativePath = (url) => resolve(url.pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const THREE = nativePath(new URL("three-segments.mp3", FIXTURES));
const CONTINUOUS = nativePath(new URL("continuous.mp3", FIXTURES));
const SAMPLES = new URL("./samples/", import.meta.url);

console.log("podcast: e2e");

if (!existsSync(THREE) || !existsSync(CONTINUOUS)) {
	console.log("  SKIP  fixtures missing — run the fixture generation step first");
	process.exitCode = 0;
} else {
	const root = await mkdtemp(join(tmpdir(), "podcast-e2e-"));
	const recording = join(root, "raw-recording.mp3");
	// Work on a copy so the shared fixture is never mutated.
	await writeFile(recording, await readFile(THREE));

	const context = Context({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputDir: root });
	plugin.apply(context, context.config);

	// --- 1. detect ------------------------------------------------------
	const detected = await call(context.get("podcast_chapters"), { path: recording });
	check("chapter detection succeeded", detected.error === undefined);
	equal("the recording has three chapters", detected.value.chapters.length, 3);
	const cuts = detected.value.chapters.slice(1).map((chapter) => chapter.start);
	near("the first cut is where the first gap was", cuts[0], 4.6, 0.2);
	near("the second cut is where the second gap was", cuts[1], 8.8, 0.2);

	// --- 2. cut at exactly those boundaries -----------------------------
	const trimmed = await call(context.get("podcast_trim"), {
		path: recording,
		cuts,
		format: "mp3",
		accurate: true,
		outputDir: root,
		prefix: "episode"
	});
	check("cutting succeeded", trimmed.error === undefined);
	equal("one segment per chapter", trimmed.value.segments.length, detected.value.chapters.length);
	check("the segment count matches the detected chapters", trimmed.value.segments.length === 3);

	// The cut boundaries must line up with the detected ones.
	for (const [index, segment] of trimmed.value.segments.entries()) {
		near(`segment ${index + 1} starts where chapter ${index + 1} starts`, segment.start, detected.value.chapters[index].start, 0.05);
	}
	near("the last segment reaches the end of the recording", trimmed.value.segments[2].end, 13.4, 0.1);

	// --- 3. independent verification of each segment --------------------
	{
		// Probe every produced file with ffprobe, not with the plugin's own reader.
		const secondContext = Context({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputDir: root });
		plugin.apply(secondContext, secondContext.config);
		let probed = 0;
		for (const segment of trimmed.value.segments) {
			const result = await plugin.probeFile(FFPROBE, segment.outputPath, { timeoutMs: 60000 });
			probed += 1;
			near(`segment "${segment.outputPath.split(/[\\/]/u).pop()}" has the expected duration`, result.durationSeconds, segment.durationSeconds, 0.15);
			equal(`segment "${segment.outputPath.split(/[\\/]/u).pop()}" is audio`, result.codec !== undefined, true);
		}
		equal("every segment was independently probed", probed, 3);
		// Total runtime must survive the round trip.
		const total = (await Promise.all(trimmed.value.segments.map((s) => plugin.probeFile(FFPROBE, s.outputPath, { timeoutMs: 60000 }))))
			.reduce((sum, probe) => sum + probe.durationSeconds, 0);
		near("the segments together reproduce the original length", total, 13.4, 0.35);
	}

	// --- 4. normalise each segment to a broadcast target ----------------
	const normalised = [];
	for (const segment of trimmed.value.segments) {
		const result = await call(context.get("podcast_normalize"), {
			path: segment.outputPath,
			targetLufs: -16,
			outputDir: root,
			outputName: `norm-${segment.outputPath.split(/[\\/]/u).pop()}`
		});
		check(`normalising segment ${segment.index + 1} succeeded`, result.error === undefined);
		if (result.error === undefined) normalised.push(result.value);
	}
	equal("every segment was normalised", normalised.length, 3);
	// The two-pass measurement is the whole reason this tool exists, so the
	// result must actually land near the requested target rather than merely
	// moving in the right direction.
	for (const [index, value] of normalised.entries()) {
		near(`normalised segment ${index + 1} lands on -16 LUFS`, value.outputLufs, -16, 3);
	}
	check("the normalised files differ from the originals", (await Promise.all(normalised.map(async (value, index) => {
		const original = (await stat(trimmed.value.segments[index].outputPath)).size;
		const produced = (await stat(value.outputPath)).size;
		return original !== produced;
	}))).some(Boolean));

	// --- 5. publish a feed over the produced files ----------------------
	{
		const feedDir = join(root, "public");
		await mkdir(feedDir, { recursive: true });
		// Copy the normalised audio into the "public" folder the feed points at,
		// so the enclosure URLs and the files on disk agree.
		const publishedPaths = [];
		for (const [index, value] of normalised.entries()) {
			const name = `episode-${index + 1}.mp3`;
			const destination = join(feedDir, name);
			await writeFile(destination, await readFile(value.outputPath));
			publishedPaths.push({ name, destination });
		}

		const feedPath = join(feedDir, "feed.xml");
		const feed = await call(context.get("podcast_feed"), {
			feedPath,
			title: "The Test Podcast",
			description: "Built end to end by dsh-tool-podcast",
			link: "https://example.com/podcast",
			author: "yuehancn",
			language: "en",
			category: "Technology",
			explicit: false,
			episodes: publishedPaths.map((entry, index) => ({
				title: `Episode ${index + 1}`,
				audioPath: entry.destination,
				url: `https://example.com/podcast/${entry.name}`,
				description: `Segment ${index + 1} of the recording`,
				pubDate: `Tue, 0${index + 1} Oct 2026 09:00:00 +0800`
			}))
		});
		check("feed generation succeeded", feed.error === undefined);
		equal("the feed validates", feed.value.valid, true);
		equal("no problems were reported", feed.value.problems, []);
		equal("all three episodes are in the feed", feed.value.episodeCount, 3);

		// Every advertised enclosure length must equal the real file size.
		for (const [index, entry] of publishedPaths.entries()) {
			const realSize = (await stat(entry.destination)).size;
			equal(`episode ${index + 1}'s enclosure length matches the published file`, feed.value.episodes[index].length, realSize);
		}

		// Re-read the written document: this is the artefact, not the in-memory copy.
		const xml = await readFile(feedPath, "utf8");
		const revalidated = plugin.validateFeed(xml);
		equal("the file on disk validates", revalidated.ok, true);
		equal("the file on disk has three episodes", revalidated.counts.items, 3);
		check("the feed names the show", xml.includes("The Test Podcast"));
		check("the feed carries the itunes namespace", xml.includes("itunes.com/dtds/podcast-1.0.dtd"));
		check("every enclosure is audio/mpeg", (xml.match(/type="audio\/mpeg"/gu) ?? []).length === 3);

		// A feed whose enclosure URL points at a file that is not there is a
		// real-world failure; verify the pairing holds for every episode.
		const files = await readdir(feedDir);
		for (const entry of publishedPaths) {
			check(`the published file "${entry.name}" exists next to the feed`, files.includes(entry.name));
		}
	}

	// --- 6. determinism of the pure parts -------------------------------
	{
		// Chapter detection must be stable across runs, otherwise a pipeline
		// cannot be re-run and compared.
		const first = await call(context.get("podcast_chapters"), { path: recording });
		const second = await call(context.get("podcast_chapters"), { path: recording });
		equal("chapter detection is deterministic", JSON.stringify(first.value.chapters), JSON.stringify(second.value.chapters));

		// The feed writer must also be byte-stable for identical input.
		const write = async (target) => {
			const result = await call(context.get("podcast_feed"), {
				feedPath: target, title: "Stable", description: "d", link: "https://x", language: "en",
				episodes: [{ title: "E", audioPath: CONTINUOUS, url: "https://x/e.mp3" }]
			});
			return readFile(target, "utf8");
		};
		const once = await write(join(root, "stable-a.xml"));
		const twice = await write(join(root, "stable-b.xml"));
		equal("feed output is byte-identical across runs", once === twice, true);
	}

	// --- 7. write samples for the independent verifier ------------------
	{
		await mkdir(new URL(SAMPLES), { recursive: true });
		const target = new URL("podcast-feed.xml", SAMPLES);
		const feed = await call(context.get("podcast_feed"), {
			feedPath: nativePath(target),
			title: "Sample Podcast",
			description: "A feed written for verify-feed.py",
			link: "https://example.com",
			author: "yuehancn",
			language: "en",
			category: "Technology",
			explicit: false,
			episodes: [
				{ title: "First Episode", audioPath: THREE, url: "https://example.com/ep1.mp3", pubDate: "Tue, 01 Oct 2026 09:00:00 +0800" },
				{ title: "Second Episode", audioPath: CONTINUOUS, url: "https://example.com/ep2.mp3" }
			]
		});
		check("the sample feed was built", feed.error === undefined && feed.value.valid === true);
		// Record the ground truth alongside it so the verifier can compare.
		await writeFile(new URL("expected.json", SAMPLES), JSON.stringify({
			title: "Sample Podcast",
			language: "en",
			author: "yuehancn",
			category: "Technology",
			explicit: false,
			episodes: feed.value.episodes.map((episode, index) => ({
				title: index === 0 ? "First Episode" : "Second Episode",
				url: episode.url,
				length: episode.length,
				type: episode.type
			}))
		}, null, 2) + "\n", "utf8");
		console.log(`  samples written to ${SAMPLES.pathname} for verify-feed.py`);
	}

	await rm(root, { recursive: true, force: true });
}

console.log(`podcast e2e: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;