// Pure-logic assertions for dsh-tool-podcast.
//
// Everything here is deterministic and touches no disk beyond reading the plugin
// source: the config schema, silence parsing, chapter inference, timestamp and
// duration formatting, slug/XML escaping, the RSS writer and its validator.
// The ffmpeg-facing behaviour belongs to the integration and e2e suites.
import { plugin, Context } from "./harness.mjs";

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

console.log("podcast: logic");

// --- module shape --------------------------------------------------------
{
	equal("the plugin is named", plugin.name, "dsh-tool-podcast");
	equal("it injects the tools service", plugin.inject, ["tools"]);
	equal("Config is a schemastery constructor", typeof plugin.Config, "function");
	check("apply is a function", typeof plugin.apply === "function");
}

// --- config defaults and overrides ---------------------------------------
{
	const defaults = plugin.Config({});
	equal("ffmpegPath default", defaults.ffmpegPath, "ffmpeg");
	equal("ffprobePath default", defaults.ffprobePath, "ffprobe");
	equal("outputDir default", defaults.outputDir, "podcast-output");
	equal("silenceDb default", defaults.silenceDb, -35);
	equal("minSilenceSeconds default", defaults.minSilenceSeconds, 0.8);
	equal("maxInputSeconds default", defaults.maxInputSeconds, 21600);
	equal("timeoutMs default", defaults.timeoutMs, 900000);
	equal("status default", defaults.status, true);
	equal("chapters default", defaults.chapters, true);
	equal("trim default", defaults.trim, true);
	equal("feed default", defaults.feed, true);
	equal("normalize default", defaults.normalize, true);

	const overridden = plugin.Config({ silenceDb: -50, minSilenceSeconds: 1.5, outputDir: "C:/tmp/pod", ffmpegPath: "C:/AI/ffmpeg/ffmpeg.exe" });
	equal("silenceDb override", overridden.silenceDb, -50);
	equal("minSilenceSeconds override", overridden.minSilenceSeconds, 1.5);
	equal("outputDir override", overridden.outputDir, "C:/tmp/pod");
	equal("ffmpegPath override", overridden.ffmpegPath, "C:/AI/ffmpeg/ffmpeg.exe");
	equal("untouched keys keep defaults", overridden.silenceDb === -50 && overridden.maxInputSeconds === 21600, true);
}

// --- registration toggles ------------------------------------------------
{
	const all = Context({});
	plugin.apply(all, all.config);
	equal("all five tools register by default", all.names().sort(), ["podcast_chapters", "podcast_feed", "podcast_normalize", "podcast_status", "podcast_trim"]);

	const none = Context({ status: false, chapters: false, trim: false, feed: false, normalize: false });
	plugin.apply(none, none.config);
	equal("every tool can be switched off", none.names(), []);

	const onlyStatus = Context({ chapters: false, trim: false, feed: false, normalize: false });
	plugin.apply(onlyStatus, onlyStatus.config);
	equal("only status registers when the rest are off", onlyStatus.names(), ["podcast_status"]);
}

// --- tool schema normalisation -------------------------------------------
{
	const context = Context({});
	plugin.apply(context, context.config);
	const chapters = context.get("podcast_chapters");
	check("chapters requires path", chapters.parameters.required.includes("path"));
	check("chapters does not require the optional knobs", !chapters.parameters.required.includes("silenceDb") && !chapters.parameters.required.includes("minSilenceSeconds"));
	equal("chapters has no additionalProperties escape hatch", chapters.parameters.additionalProperties, undefined);
	equal("chapters accepts the four documented knobs", Object.keys(chapters.parameters.properties), ["path", "silenceDb", "minSilenceSeconds", "maxChapters"]);

	const trim = context.get("podcast_trim");
	check("trim requires path and cuts", trim.parameters.required.includes("path") && trim.parameters.required.includes("cuts"));
	equal("trim cuts is an array of numbers", [trim.parameters.properties.cuts.type, trim.parameters.properties.cuts.items.type], ["array", "number"]);

	const feed = context.get("podcast_feed");
	check("feed requires feedPath and title and episodes", ["feedPath", "title", "episodes"].every((key) => feed.parameters.required.includes(key)));
	check("feed episode items declare required title/audioPath/url", ["title", "audioPath", "url"].every((key) => feed.parameters.properties.episodes.items.required.includes(key)));

	const status = context.get("podcast_status");
	equal("status takes no parameters", Object.keys(status.parameters.properties), []);
	// status is a read-only capability check, so it may run concurrently.
	equal("status is concurrency safe", status.isConcurrencySafe({}), true);
	equal("chapters is concurrency safe", chapters.isConcurrencySafe({ path: "x.mp3" }), true);
	equal("normalize is concurrency safe", context.get("podcast_normalize").isConcurrencySafe({ path: "x.mp3" }), true);
	// trim writes files under a caller-chosen prefix, so it must serialise.
	equal("trim is not concurrency safe", trim.isConcurrencySafe({ path: "x.mp3", cuts: [10] }), false);
}

// --- duration and timestamp formatting -----------------------------------
{
	equal("humanDuration of 0", plugin.humanDuration(0), "0:00");
	equal("humanDuration of 59", plugin.humanDuration(59), "0:59");
	equal("humanDuration of 60", plugin.humanDuration(60), "1:00");
	equal("humanDuration of 3599", plugin.humanDuration(3599), "59:59");
	equal("humanDuration of 3600", plugin.humanDuration(3600), "1:00:00");
	equal("humanDuration of 3725", plugin.humanDuration(3725), "1:02:05");
	equal("humanDuration rounds", plugin.humanDuration(61.6), "1:02");
	equal("humanDuration of a non-number", plugin.humanDuration(Number.NaN), "unknown");
	equal("humanDuration clamps negatives", plugin.humanDuration(-5), "0:00");

	equal("ffmpegTimestamp pads correctly", plugin.ffmpegTimestamp(3725.5), "01:02:05.500");
	equal("ffmpegTimestamp handles zero", plugin.ffmpegTimestamp(0), "00:00:00.000");
	equal("ffmpegTimestamp carries milliseconds", plugin.ffmpegTimestamp(12.3456), "00:00:12.346");
	equal("ffmpegTimestamp of 60", plugin.ffmpegTimestamp(60), "00:01:00.000");

	equal("rssDuration matches the HH:MM:SS shape", plugin.rssDuration(3725), "1:02:05");
	equal("rssDuration under an hour", plugin.rssDuration(125), "2:05");
}

// --- slugify (CJK-safe) --------------------------------------------------
{
	equal("slugify lowercases and hyphenates", plugin.slugify("Hello World"), "hello-world");
	equal("slugify collapses punctuation runs", plugin.slugify("Ep. 12 — The, Big? Idea!"), "ep-12-the-big-idea");
	equal("slugify keeps CJK letters", plugin.slugify("第一期 播客"), "第一期-播客");
	equal("slugify trims leading and trailing separators", plugin.slugify("---abc---"), "abc");
	equal("slugify falls back when empty", plugin.slugify("!!!", "episode"), "episode");
	equal("slugify falls back for undefined", plugin.slugify(undefined), "episode");
	check("slugify caps length", plugin.slugify("a".repeat(200)).length <= 60);
}

// --- classify ------------------------------------------------------------
{
	equal("classifies mp3", plugin.classify("a.mp3"), "audio");
	equal("classifies m4a", plugin.classify("a.m4a"), "audio");
	equal("classifies uppercase extension", plugin.classify("A.MP3"), "audio");
	equal("classifies flac", plugin.classify("a.flac"), "audio");
	equal("classifies opus", plugin.classify("a.opus"), "audio");
	equal("rejects mp4 as unknown", plugin.classify("a.mp4"), "unknown");
	equal("rejects txt as unknown", plugin.classify("a.txt"), "unknown");
}

// --- escapeXml -----------------------------------------------------------
{
	equal("escapeXml escapes ampersand", plugin.escapeXml("Tom & Jerry"), "Tom &amp; Jerry");
	equal("escapeXml escapes angle brackets", plugin.escapeXml("<b>hi</b>"), "&lt;b&gt;hi&lt;/b&gt;");
	equal("escapeXml escapes both quotes", plugin.escapeXml('"x" and \'y\''), "&quot;x&quot; and &apos;y&apos;");
	equal("escapeXml escapes the ampersand first", plugin.escapeXml("&lt;"), "&amp;lt;");
	equal("escapeXml leaves CJK alone", plugin.escapeXml("中文标题"), "中文标题");
	equal("escapeXml drops control characters", plugin.escapeXml("a\u0000b\u0007c"), "abc");
	equal("escapeXml keeps ordinary whitespace", plugin.escapeXml("a\tb\nc"), "a\tb\nc");
}

// --- parseSilence --------------------------------------------------------
{
	const sample = [
		"[silencedetect @ 0x55d] silence_start: 12.3456",
		"[silencedetect @ 0x55d] silence_end: 13.9876 | silence_duration: 1.642",
		"[silencedetect @ 0x55d] silence_start: 40.5",
		"[silencedetect @ 0x55d] silence_end: 42.0 | silence_duration: 1.5"
	].join("\n");
	const parsed = plugin.parseSilence(sample);
	equal("parseSilence finds both intervals", parsed.length, 2);
	equal("parseSilence reads the first start", parsed[0].start, 12.3456);
	equal("parseSilence reads the first end", parsed[0].end, 13.9876);
	equal("parseSilence reads the first duration", parsed[0].duration, 1.642);
	equal("parseSilence reads the second start", parsed[1].start, 40.5);

	const openEnded = plugin.parseSilence("[silencedetect @ 0x] silence_start: 100.25");
	equal("an unterminated silence is still reported", openEnded.length, 1);
	equal("the open-ended start is kept", openEnded[0].start, 100.25);
	equal("the open end is null, not zero", openEnded[0].end, null);
	equal("the open duration is null", openEnded[0].duration, null);

	equal("parseSilence ignores unrelated output", plugin.parseSilence("frame= 100 fps=50 q=-0.0 size=N/A time=00:00:02.00").length, 0);
	equal("parseSilence of empty text", plugin.parseSilence("").length, 0);
	equal("parseSilence of non-string", plugin.parseSilence(undefined).length, 0);
	// A duration is recomputed when only start and end are present.
	const derived = plugin.parseSilence("silence_start: 5.0\nsilence_end: 7.5");
	equal("duration is derived from start and end", derived[0].duration, 2.5);
}

// --- chaptersFromSilence -------------------------------------------------
{
	const silences = [
		{ start: 30, end: 32, duration: 2 },   // qualifies
		{ start: 0.2, end: 0.4, duration: 0.2 }, // too short
		{ start: 90, end: 91.5, duration: 1.5 } // qualifies
	];
	const chapters = plugin.chaptersFromSilence(silences, 150, 0.8);
	equal("a short gap is not a boundary", chapters.length, 3);
	equal("the first chapter starts at zero", chapters[0].start, 0);
	equal("the boundary lands at the midpoint of the gap", chapters[0].end, 31);
	equal("the second chapter continues from there", chapters[1].start, 31);
	equal("the second boundary is the second midpoint", chapters[1].end, 90.75);
	equal("the last chapter ends at the file duration", chapters[2].end, 150);
	equal("chapter durations are contiguous", chapters.reduce((sum, c) => sum + c.durationSeconds, 0), 150);
	equal("the qualifying gap length is reported", chapters[0].gap, 2);

	const none = plugin.chaptersFromSilence([], 60, 0.8);
	equal("no silence means one chapter", none.length, 1);
	equal("the single chapter spans the whole file", [none[0].start, none[0].end], [0, 60]);

	// An open-ended trailing silence must not create an empty final chapter.
	const trailing = plugin.chaptersFromSilence([{ start: 95, end: null, duration: null }], 100, 0.8);
	equal("a cut at the very end is dropped", trailing.length, 1);
	equal("the file stays one chapter", [trailing[0].start, trailing[0].end], [0, 100]);

	// Unordered input must still yield ordered chapters.
	const shuffled = plugin.chaptersFromSilence([
		{ start: 80, end: 82, duration: 2 },
		{ start: 20, end: 22, duration: 2 }
	], 120, 0.8);
	equal("chapters come out in ascending order", [shuffled[0].end, shuffled[1].end], [21, 81]);
}

// --- MIME types and targets ----------------------------------------------
{
	equal("mp3 mime type", plugin.MIME_TYPES.mp3, "audio/mpeg");
	equal("m4a mime type", plugin.MIME_TYPES.m4a, "audio/mp4");
	equal("flac mime type", plugin.MIME_TYPES.flac, "audio/flac");
	equal("opus mime type", plugin.MIME_TYPES.opus, "audio/opus");
	equal("wav mime type", plugin.MIME_TYPES.wav, "audio/wav");
	check("every supported output target has a mime type", Object.keys(plugin.TARGETS).every((key) => plugin.MIME_TYPES[key] !== undefined));
	equal("wav output is uncompressed PCM", plugin.TARGETS.wav.acodec, "pcm_s16le");
	equal("mp3 output uses libmp3lame", plugin.TARGETS.mp3.acodec, "libmp3lame");
	equal("flac output uses the flac codec", plugin.TARGETS.flac.acodec, "flac");
	// The copy decision is driven by codec compatibility, not by the encoder
	// name, because MP3→MP3 is a copy while MP3→WAV is not.
	equal("mp3 target maps to the mp3 codec", plugin.CODEC_FOR_TARGET.mp3, "mp3");
	equal("m4a target maps to aac", plugin.CODEC_FOR_TARGET.m4a, "aac");
	equal("wav target maps to pcm_s16le", plugin.CODEC_FOR_TARGET.wav, "pcm_s16le");
	equal("opus target maps to opus", plugin.CODEC_FOR_TARGET.opus, "opus");
	equal("flac target maps to flac", plugin.CODEC_FOR_TARGET.flac, "flac");
	check("every output target has a native codec", Object.keys(plugin.TARGETS).every((key) => plugin.CODEC_FOR_TARGET[key] !== undefined));
}

// --- buildFeed -----------------------------------------------------------
{
	const xml = plugin.buildFeed(
		{ title: "The Show", link: "https://example.com", description: "A show", language: "en", author: "Someone", category: "Technology", explicit: false },
		[{
			title: "Episode 1",
			description: "First one",
			url: "https://example.com/ep1.mp3",
			length: 1234567,
			type: "audio/mpeg",
			durationSeconds: 3725,
			guid: "https://example.com/ep1.mp3",
			pubDate: "Tue, 01 Oct 2026 09:00:00 +0800"
		}]
	);
	check("the feed starts with an XML declaration", xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
	check("the feed declares RSS 2.0", xml.includes('<rss version="2.0"'));
	check("the feed declares the itunes namespace", xml.includes('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'));
	check("the channel title is present", xml.includes("<title>The Show</title>"));
	check("the language is present", xml.includes("<language>en</language>"));
	check("the category is present", xml.includes('<itunes:category text="Technology"/>'));
	check("explicit=no is rendered", xml.includes("<itunes:explicit>no</itunes:explicit>"));
	check("the enclosure carries the byte length", xml.includes('length="1234567"'));
	check("the enclosure carries a mime type", xml.includes('type="audio/mpeg"'));
	check("the itunes duration is HH:MM:SS", xml.includes("<itunes:duration>1:02:05</itunes:duration>"));
	check("the guid is non-permalink", xml.includes('<guid isPermaLink="false">'));
	check("the feed is newline-terminated", xml.endsWith("</rss>\n"));
	// XML must not be able to break out of an attribute via the title.
	const evil = plugin.buildFeed({ title: 'x" onload="y', link: "", description: "", language: "en", explicit: false }, []);
	check("quotes in metadata are escaped, not emitted raw", !evil.includes('onload="y"') && evil.includes("&quot;"));

	const minimal = plugin.buildFeed({ title: "T", link: "", description: "", language: "en", explicit: true }, []);
	check("a show with no category omits the element", !minimal.includes("itunes:category"));
	check("a show with no author omits itunes:author", !minimal.includes("itunes:author"));
	check("explicit=true is rendered as yes", minimal.includes("<itunes:explicit>yes</itunes:explicit>"));
}

// --- validateFeed --------------------------------------------------------
{
	const good = plugin.buildFeed(
		{ title: "Show", link: "https://x", description: "d", language: "en", explicit: false },
		[{ title: "E1", description: "d", url: "https://x/e.mp3", length: 10, type: "audio/mpeg", guid: "g" }]
	);
	const goodResult = plugin.validateFeed(good);
	equal("a well-formed feed validates", goodResult.ok, true);
	equal("no problems are reported", goodResult.problems, []);
	equal("the item count is reported", goodResult.counts.items, 1);

	// A missing enclosure length is the failure mode clients reject silently.
	const noLength = '<rss version="2.0"><channel><title>T</title><item><enclosure url="https://x/e.mp3" type="audio/mpeg"/></item></channel></rss>';
	const noLengthResult = plugin.validateFeed(noLength);
	equal("a missing length is caught", noLengthResult.ok, false);
	check("the problem names the missing length", noLengthResult.problems.some((problem) => problem.includes("numeric length")));

	// A non-audio type is rejected even when the length is fine.
	const badType = '<rss version="2.0"><channel><title>T</title><item><enclosure url="https://x/e.mp3" length="10" type="video/mp4"/></item></channel></rss>';
	check("a non-audio enclosure type is caught", plugin.validateFeed(badType).problems.some((problem) => problem.includes("not audio/*")));

	// Items without enclosures are a mismatch.
	const mismatch = '<rss version="2.0"><channel><title>T</title><item><title>no enclosure</title></item></channel></rss>';
	check("an item with no enclosure is caught", plugin.validateFeed(mismatch).problems.some((problem) => problem.includes("enclosure")));

	// Unbalanced tags must be detected.
	const unbalanced = '<rss version="2.0"><channel><title>T</title></channel>';
	check("unbalanced tags are caught", plugin.validateFeed(unbalanced).problems.some((problem) => problem.includes("not well-formed")));

	// A doc with no XML declaration is not a valid feed.
	check("a missing XML declaration is caught", plugin.validateFeed('<rss version="2.0"><channel><title>T</title></channel></rss>').problems.some((problem) => problem.includes("XML declaration")));

	// A doc that is not RSS at all.
	check("a non-RSS root is caught", plugin.validateFeed('<?xml version="1.0"?><feed><title>T</title></feed>').problems.some((problem) => problem.includes("rss version")));

	// A channel with an empty title is not publishable.
	const emptyTitle = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title></title></channel></rss>';
	check("an empty channel title is caught", plugin.validateFeed(emptyTitle).problems.some((problem) => problem.includes("no title")));

	// Self-closing tags must not unbalance the counter.
	const selfClosing = plugin.buildFeed({ title: "T", link: "", description: "", language: "en", explicit: false, imageUrl: "https://x/i.png" }, []);
	check("self-closing elements do not unbalance the tag scan", plugin.validateFeed(selfClosing).problems.every((problem) => !problem.includes("well-formed")));
}

console.log(`podcast logic: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;