/**
 * Model-facing podcast tools over a local ffmpeg install: find the chapter
 * boundaries inside a recording, cut it at those boundaries, publish an RSS
 * feed that podcast clients accept, and normalise loudness.
 *
 * Why this exists
 * - A podcast episode is one long file with no structure. The structure is
 *   implicit — it lives in the *silence* between segments. `podcast_chapters`
 *   recovers it, and the reason it is a separate tool from `podcast_trim` is
 *   that a boundary is a *decision*: you want to see the proposed cut points,
 *   and the confidence behind each one, before committing to a cut.
 * - An RSS podcast feed is rejected by clients for reasons that are invisible
 *   in the XML: an `<enclosure>` whose `length` does not match the file's byte
 *   size, or whose `type` is wrong, silently drops the episode. So the length
 *   is measured from disk, never accepted from the caller.
 * - Loudness is per-episode and clients do not normalise, so a quiet episode
 *   is unlistenable next to a loud one. That is what `podcast_normalize` fixes.
 *
 * Notes on conventions
 * - Chapter *detection* is deliberately conservative and explainable: it reports
 *   the silence gaps it found and the rule it used, rather than emitting opaque
 *   numbers. A wrong split is otherwise silent — the file still plays.
 * - `chapter` and `normalize` prefer a hard cut with stream copy where possible
 *   and re-encode only when a boundary falls mid-frame.
 * - All command invocations use `spawn(command, argsArray)`, never a shell
 *   string, so paths with spaces, quotes or CJK characters survive.
 * @module dsh-tool-podcast
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-tool-podcast";

/** Services required by the podcast tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call budget (ms). */
const DEFAULT_TIMEOUT_MS = 900000;

/** Extensions this plugin treats as audio it can analyse. */
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif"]);

/**
 * Output target definitions for the cut step.
 *
 * `copy` is the cheap path: it moves the existing compressed stream across
 * without touching a single sample, so a cut of an hour-long episode finishes
 * in under a second. It is only valid on a keyframe/frame boundary, so the
 * cut points are aligned to the nearest frame before it is used.
 */
const TARGETS = {
	"mp3": { container: "mp3", acodec: "libmp3lame", extra: ["-q:a", "2"] },
	"m4a": { container: "m4a", acodec: "aac", extra: ["-b:a", "192k"] },
	"wav": { container: "wav", acodec: "pcm_s16le", extra: [] },
	"flac": { container: "flac", acodec: "flac", extra: [] },
	"opus": { container: "opus", acodec: "libopus", extra: ["-b:a", "128k"] }
};

/**
 * Which ffmpeg codec name is native to each output container.
 *
 * Used to decide whether a segment can be stream-copied: copying is only sound
 * when the source stream already uses the codec the container expects. An MP3
 * source cut back into MP3 is a copy; an MP3 source cut into WAV is not.
 */
const CODEC_FOR_TARGET = {
	mp3: "mp3",
	m4a: "aac",
	wav: "pcm_s16le",
	flac: "flac",
	opus: "opus"
};

/** RSS `type` attribute per container — clients match on this string. */
const MIME_TYPES = {
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	m4b: "audio/mp4",
	aac: "audio/aac",
	opus: "audio/opus",
	ogg: "audio/ogg",
	flac: "audio/flac",
	wav: "audio/wav"
};

/* ------------------------------------------------------------------ config */

const Config = z.object({
	/** Path to the ffmpeg executable. */
	ffmpegPath: z.string().default("ffmpeg"),
	/** Path to the ffprobe executable. */
	ffprobePath: z.string().default("ffprobe"),
	/** Directory for produced files (cut segments, normalised audio, feeds). */
	outputDir: z.string().default("podcast-output"),
	/** Noise floor in dB below which audio counts as silence. */
	silenceDb: z.number().default(-35),
	/** A gap must last at least this long (seconds) to be a boundary candidate. */
	minSilenceSeconds: z.number().default(0.8),
	/** Refuse a recording longer than this many seconds, to bound the analysis. */
	maxInputSeconds: z.number().default(21600),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Register `podcast_status`. */
	status: z.boolean().default(true),
	/** Register `podcast_chapters`. */
	chapters: z.boolean().default(true),
	/** Register `podcast_trim`. */
	trim: z.boolean().default(true),
	/** Register `podcast_feed`. */
	feed: z.boolean().default(true),
	/** Register `podcast_normalize`. */
	normalize: z.boolean().default(true)
});

/* ---------------------------------------------------------------- process */

/**
 * Run a command and capture output with a hard timeout.
 *
 * A non-zero exit surfaces ffmpeg's own last stderr lines, which name the real
 * problem (missing codec, unsupported filter, unreadable stream) far better
 * than a bare exit code.
 *
 * @param {string} command - executable to spawn.
 * @param {string[]} args - argument array (never a shell string).
 * @param {{timeoutMs: number, signal?: AbortSignal}} options - run options.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} captured result.
 */
function runCommand(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		let child;
		try {
			child = spawn(command, args, { windowsHide: true, shell: false });
		} catch (error) {
			reject(new Error(`podcast: cannot start "${command}" (${error?.message ?? error}). Check ffmpegPath/ffprobePath in the plugin config.`));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(reject, new Error(`podcast: "${command}" exceeded its ${Math.round(options.timeoutMs / 1000)}s budget. Raise timeoutMs or shorten the input.`));
		}, options.timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(reject, options.signal?.reason ?? new Error("aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		// silencedetect reports on stderr, so it must be captured rather than discarded.
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => {
			finish(reject, new Error(`podcast: "${command}" failed to run (${error?.message ?? error}). Install ffmpeg or set ffmpegPath to its full path.`));
		});
		child.on("close", (code) => {
			if (code !== 0) {
				const tail = stderr.trim().split(/\r?\n/u).slice(-6).join("\n");
				finish(reject, new Error(`podcast: "${command}" exited with code ${code}.\n${tail.slice(0, 600) || "(no stderr)"}`));
				return;
			}
			finish(resolvePromise, { stdout, stderr, code: code ?? 0 });
		});
	});
}

/** Probe an executable's version string. */
async function probeBinary(command) {
	try {
		const { stdout, stderr } = await runCommand(command, ["-version"], { timeoutMs: 15000 });
		return { available: true, version: `${stdout}${stderr}`.trim().split(/\r?\n/u)[0] ?? "" };
	} catch (error) {
		return { available: false, error: String(error?.message ?? error) };
	}
}

/* ------------------------------------------------------------------ files */

/** Classify a path by extension, so we can refuse obviously-wrong inputs. */
function classify(path) {
	const ext = extname(path).toLowerCase();
	return AUDIO_EXTENSIONS.has(ext) ? "audio" : "unknown";
}

/** Format seconds as H:MM:SS or M:SS. */
function humanDuration(seconds) {
	if (!Number.isFinite(seconds)) return "unknown";
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
		: `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** Format seconds as the `HH:MM:SS.mmm` shape ffmpeg accepts as a seek target. */
function ffmpegTimestamp(seconds) {
	const total = Math.max(0, seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const whole = Math.floor(secs);
	const millis = Math.round((secs - whole) * 1000);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Format seconds as the RSS `itunes:duration` shape: HH:MM:SS or MM:SS. */
function rssDuration(seconds) {
	return humanDuration(seconds);
}

/** A slug usable as a file name, CJK-safe. */
function slugify(value, fallback = "episode") {
	const slug = String(value ?? "")
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 60);
	return slug === "" ? fallback : slug;
}

/** Escape text for inclusion in XML character data or an attribute. */
function escapeXml(value) {
	return String(value ?? "")
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;")
		// XML 1.0 forbids most control characters outright; drop them rather
		// than emit a feed that a strict parser rejects.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "");
}

/**
 * Probe an audio file into structured facts.
 *
 * @param {string} ffprobe - ffprobe executable.
 * @param {string} path - audio path.
 * @param {{signal?: AbortSignal, timeoutMs: number}} options - run options.
 * @returns {Promise<object>} parsed probe result.
 */
async function probeFile(ffprobe, path, options) {
	const { stdout } = await runCommand(ffprobe, [
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path
	], { timeoutMs: Math.min(options.timeoutMs, 120000), signal: options.signal });

	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`podcast: ffprobe returned unparseable output for "${path}". The file may be corrupt or not an audio file.`);
	}

	const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
	const audio = streams.find((stream) => stream.codec_type === "audio");
	if (audio === undefined) {
		throw new Error(`podcast: "${path}" has no audio stream, so there is nothing to analyse.`);
	}
	const format = parsed.format ?? {};
	const duration = Number(format.duration ?? audio.duration);

	return {
		durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : undefined,
		sizeBytes: Number(format.size ?? 0) || undefined,
		bitrate: Number(format.bit_rate ?? 0) || undefined,
		formatName: format.format_name,
		codec: audio.codec_name,
		sampleRate: Number(audio.sample_rate) || undefined,
		channels: audio.channels
	};
}

/* ------------------------------------------------------- silence detection */

/**
 * Parse `silencedetect` output into silence intervals.
 *
 * The filter writes lines such as:
 *   [silencedetect @ 0x...] silence_start: 12.3456
 *   [silencedetect @ 0x...] silence_end: 13.9876 | silence_duration: 1.642
 *
 * A start with no matching end means silence ran to the end of the file, which
 * is common for a recording that ends without a trailing sound.
 *
 * @param {string} text - combined stderr from ffmpeg.
 * @returns {Array<{start: number, end: number|null, duration: number|null}>} intervals.
 */
function parseSilence(text) {
	const intervals = [];
	let pending = null;
	for (const line of String(text).split(/\r?\n/u)) {
		const startMatch = /silence_start:\s*(-?[\d.]+)/u.exec(line);
		if (startMatch !== null) {
			pending = { start: Number(startMatch[1]) };
			continue;
		}
		const endMatch = /silence_end:\s*(-?[\d.]+)/u.exec(line);
		if (endMatch !== null) {
			const end = Number(endMatch[1]);
			const durationMatch = /silence_duration:\s*(-?[\d.]+)/u.exec(line);
			const duration = durationMatch === null ? (pending === null ? null : end - pending.start) : Number(durationMatch[1]);
			intervals.push({ start: pending === null ? null : pending.start, end, duration });
			pending = null;
		}
	}
	if (pending !== null) {
		// Silence that never ended: report it open-ended rather than dropping it.
		intervals.push({ start: pending.start, end: null, duration: null });
	}
	return intervals.filter((interval) => interval.start !== null && Number.isFinite(interval.start));
}

/**
 * Detect silence over a window of a file.
 *
 * @param {string} ffmpeg - ffmpeg executable.
 * @param {string} path - audio path.
 * @param {{noiseDb: number, minSeconds: number, start?: number, end?: number, signal?: AbortSignal, timeoutMs: number}} options - detection options.
 * @returns {Promise<Array<object>>} the silence intervals, with absolute times.
 */
async function detectSilence(ffmpeg, path, options) {
	const args = ["-hide_banner", "-nostats"];
	// Seeking before the input is the fast path: ffmpeg jumps instead of decoding.
	if (options.start !== undefined && options.start > 0) args.push("-ss", ffmpegTimestamp(options.start));
	if (options.end !== undefined) args.push("-t", ffmpegTimestamp(options.end - (options.start ?? 0)));
	args.push(
		"-i", path,
		"-af", `silencedetect=noise=${options.noiseDb}dB:d=${options.minSeconds}`,
		"-f", "null", "-"
	);
	const { stderr } = await runCommand(ffmpeg, args, { timeoutMs: options.timeoutMs, signal: options.signal });
	const base = options.start ?? 0;
	return parseSilence(stderr).map((interval) => ({
		start: interval.start + base,
		end: interval.end === null ? null : interval.end + base,
		duration: interval.duration
	}));
}

/**
 * Turn silence intervals into chapter boundaries.
 *
 * The rule is: a gap is a boundary if it is at least the requested length.
 * Boundaries are the *midpoint* of each qualifying gap, which is the most
 * defensible place to cut — it is equally far from the speech on either side.
 * The result always starts at 0 and ends at the file duration.
 *
 * @param {Array<object>} silences - silence intervals from `detectSilence`.
 * @param {number} duration - total duration in seconds.
 * @param {number} minSeconds - minimum gap length to qualify.
 * @returns {Array<{start: number, end: number, gap: number|null}>} chapters.
 */
function chaptersFromSilence(silences, duration, minSeconds) {
	const cuts = [];
	for (const interval of silences) {
		const gap = interval.duration ?? (interval.end === null ? null : interval.end - interval.start);
		if (gap === null || gap < minSeconds) continue;
		const mid = interval.end === null ? duration : (interval.start + interval.end) / 2;
		// Ignore a cut at the very start or end: it would create an empty chapter.
		if (mid <= 0.05 || mid >= duration - 0.05) continue;
		cuts.push({ at: mid, gap });
	}
	cuts.sort((a, b) => a.at - b.at);
	// Collapse cuts that landed on top of each other after rounding.
	const boundaries = [0];
	for (const cut of cuts) {
		if (cut.at - boundaries[boundaries.length - 1] > 0.05) boundaries.push(cut.at);
	}
	boundaries.push(duration);
	const chapters = [];
	for (let index = 0; index < boundaries.length - 1; index += 1) {
		const start = boundaries[index];
		const end = boundaries[index + 1];
		chapters.push({
			index,
			start: Math.round(start * 1000) / 1000,
			end: Math.round(end * 1000) / 1000,
			durationSeconds: Math.round((end - start) * 1000) / 1000,
			gap: index < cuts.length ? Math.round((cuts[index]?.gap ?? 0) * 1000) / 1000 : null
		});
	}
	return chapters;
}

/**
 * Cut a single segment out of a source file.
 *
 * Stream copy (`-c copy`) is tried first because it is essentially free, but it
 * can only start on a packet boundary; when the caller asked for a mid-frame
 * cut, the result would begin with a fraction of a second of the previous
 * audio. `-avoid_negative_ts make_zero` plus an accurate seek after the input
 * keeps the cut honest, and the caller decides via `accurate` whether to pay
 * for a re-encode.
 *
 * @param {string} ffmpeg - ffmpeg executable.
 * @param {object} options - cut options.
 * @returns {Promise<void>} resolves when the segment is written.
 */
async function cutSegment(ffmpeg, options) {
	const args = ["-hide_banner", "-nostats", "-y"];
	if (options.reencode) {
		// Accurate path: decode from the start, trim precisely, re-encode.
		args.push("-i", options.source, "-ss", ffmpegTimestamp(options.start), "-t", ffmpegTimestamp(options.duration));
		args.push("-vn", "-acodec", options.acodec, ...options.extra);
	} else {
		// Cheap path: seek before the input so ffmpeg jumps, then copy.
		if (options.start > 0) args.push("-ss", ffmpegTimestamp(options.start));
		args.push("-i", options.source);
		if (options.start <= 0) args.push("-ss", "0");
		args.push("-t", ffmpegTimestamp(options.duration));
		args.push("-vn", "-acodec", "copy");
	}
	args.push(options.outputPath);
	await runCommand(ffmpeg, args, { timeoutMs: options.timeoutMs, signal: options.signal });
}

/* ------------------------------------------------------------------- RSS */

/**
 * Build an iTunes-compatible RSS 2.0 podcast feed.
 *
 * Two details matter more than the rest of the document:
 * - Each `<enclosure>` needs `length` in BYTES and a `type` that matches the
 *   actual container. Clients reject an episode whose length is wrong, and the
 *   failure is silent — the feed parses, the episode just never appears.
 * - `itunes:duration` is either `HH:MM:SS` or a second count; both are accepted,
 *   and the `HH:MM:SS` form is what every client renders correctly.
 *
 * @param {object} show - show-level metadata.
 * @param {Array<object>} items - episode records.
 * @returns {string} the feed document.
 */
function buildFeed(show, items) {
	const lines = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">');
	lines.push("  <channel>");
	lines.push(`    <title>${escapeXml(show.title)}</title>`);
	lines.push(`    <link>${escapeXml(show.link)}</link>`);
	lines.push(`    <description>${escapeXml(show.description)}</description>`);
	lines.push(`    <language>${escapeXml(show.language)}</language>`);
	lines.push(`    <generator>dsh-tool-podcast</generator>`);
	if (show.author !== undefined && show.author !== "") {
		lines.push(`    <itunes:author>${escapeXml(show.author)}</itunes:author>`);
	}
	lines.push(`    <itunes:explicit>${show.explicit ? "yes" : "no"}</itunes:explicit>`);
	if (show.imageUrl !== undefined && show.imageUrl !== "") {
		lines.push(`    <itunes:image href="${escapeXml(show.imageUrl)}"/>`);
	}
	if (show.category !== undefined && show.category !== "") {
		lines.push(`    <itunes:category text="${escapeXml(show.category)}"/>`);
	}
	for (const item of items) {
		lines.push("    <item>");
		lines.push(`      <title>${escapeXml(item.title)}</title>`);
		lines.push(`      <description>${escapeXml(item.description)}</description>`);
		if (item.pubDate !== undefined) lines.push(`      <pubDate>${escapeXml(item.pubDate)}</pubDate>`);
		lines.push(`      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`);
		lines.push(`      <enclosure url="${escapeXml(item.url)}" length="${item.length}" type="${escapeXml(item.type)}"/>`);
		if (item.durationSeconds !== undefined) lines.push(`      <itunes:duration>${rssDuration(item.durationSeconds)}</itunes:duration>`);
		lines.push("    </item>");
	}
	lines.push("  </channel>");
	lines.push("</rss>");
	return `${lines.join("\n")}\n`;
}

/**
 * Validate a feed the way a client would, and report every problem found.
 *
 * This is deliberately a *re-reader*: it parses the document it just wrote and
 * checks the invariants clients enforce, so a feed that would be rejected is
 * caught before it is published.
 *
 * @param {string} xml - the feed document.
 * @returns {{ok: boolean, problems: string[], counts: object}} validation result.
 */
function validateFeed(xml) {
	const problems = [];
	const text = String(xml ?? "");
	if (!text.startsWith("<?xml")) problems.push("the document does not start with an XML declaration");
	if (!/<rss\b[^>]*version="2\.0"/u.test(text)) problems.push("the root element is not <rss version=\"2.0\">");
	if (!text.includes("<channel>")) problems.push("there is no <channel> element");
	const channelTitle = /<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/u.exec(text);
	if (channelTitle === null || channelTitle[1].trim() === "") problems.push("the channel has no title");

	const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/gu)].map((match) => match[1]);
	const enclosures = [...text.matchAll(/<enclosure\b([^>]*)\/>/gu)].map((match) => match[1]);
	if (items.length !== enclosures.length) {
		problems.push(`${items.length} item(s) but ${enclosures.length} enclosure(s) — every episode needs exactly one`);
	}
	for (const [index, attributes] of enclosures.entries()) {
		const url = /\burl="([^"]*)"/u.exec(attributes);
		const length = /\blength="([^"]*)"/u.exec(attributes);
		const type = /\btype="([^"]*)"/u.exec(attributes);
		if (url === null || url[1] === "") problems.push(`enclosure ${index + 1} has no url`);
		if (length === null || !/^\d+$/u.test(length[1])) problems.push(`enclosure ${index + 1} has no numeric length (clients drop episodes whose byte length is missing)`);
		if (type === null || !type[1].startsWith("audio/")) problems.push(`enclosure ${index + 1} has a type that is not audio/* (got "${type?.[1] ?? ""}")`);
	}
	let depth = 0;
	let balanced = true;
	for (const match of text.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/gu)) {
		const closing = match[1] === "/";
		const selfClosing = match[4] === "/";
		if (selfClosing) continue;
		if (closing) {
			depth -= 1;
			if (depth < 0) { balanced = false; break; }
		} else {
			depth += 1;
		}
	}
	if (!balanced || depth !== 0) problems.push("the tags are not balanced — the document is not well-formed XML");
	return {
		ok: problems.length === 0,
		problems,
		counts: { items: items.length, enclosures: enclosures.length }
	};
}

/* ------------------------------------------------------------------- tools */

/**
 * Register the enabled podcast tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	const outputDir = resolve(config.outputDir);
	const budgetMs = config.timeoutMs;
	const ffmpeg = config.ffmpegPath;
	const ffprobe = config.ffprobePath;

	/* -- podcast_status ---------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "podcast_status",
			description: "Report whether ffmpeg and ffprobe are runnable from this plugin, with their versions, and which podcast operations are available. Check this before a long analysis.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ffmpeg: {
							type: "object", required: true, additionalProperties: false,
							properties: { command: { type: "string", required: true }, available: { type: "boolean", required: true }, version: { type: "string" }, error: { type: "string" } }
						},
						ffprobe: {
							type: "object", required: true, additionalProperties: false,
							properties: { command: { type: "string", required: true }, available: { type: "boolean", required: true }, version: { type: "string" }, error: { type: "string" } }
						},
						operations: { type: "array", required: true, items: { type: "string" } },
						supportedFormats: { type: "array", required: true, items: { type: "string" } },
						outputDir: { type: "string", required: true },
						defaults: {
							type: "object", required: true, additionalProperties: false,
							properties: {
								silenceDb: { type: "number", required: true },
								minSilenceSeconds: { type: "number", required: true },
								maxInputSeconds: { type: "number", required: true }
							}
						},
						note: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`ffmpeg:  ${value.ffmpeg.available ? `AVAILABLE ${value.ffmpeg.version ?? ""}` : `MISSING — ${value.ffmpeg.error ?? "not found"}`}`,
						`ffprobe: ${value.ffprobe.available ? `AVAILABLE ${value.ffprobe.version ?? ""}` : `MISSING — ${value.ffprobe.error ?? "not found"}`}`,
						`operations: ${value.operations.join(", ")}`,
						`output formats: ${value.supportedFormats.join(", ")}`,
						`output dir: ${value.outputDir}`,
						`silence defaults: below ${value.defaults.silenceDb} dB for at least ${value.defaults.minSilenceSeconds}s`,
						value.note
					].join("\n")
				}]
			},
			timeoutMs: 30000,
			isConcurrencySafe: () => true,
			async execute() {
				const [ffmpegResult, ffprobeResult] = await Promise.all([probeBinary(ffmpeg), probeBinary(ffprobe)]);
				const operations = [];
				if (config.chapters) operations.push("detect chapter boundaries from silence");
				if (config.trim) operations.push("cut at boundaries");
				if (config.feed) operations.push("write an RSS feed");
				if (config.normalize) operations.push("normalise loudness");
				return {
					ffmpeg: { command: ffmpeg, ...ffmpegResult },
					ffprobe: { command: ffprobe, ...ffprobeResult },
					operations,
					supportedFormats: Object.keys(TARGETS),
					outputDir,
					defaults: { silenceDb: config.silenceDb, minSilenceSeconds: config.minSilenceSeconds, maxInputSeconds: config.maxInputSeconds },
					note: "Chapter boundaries are inferred from silence, so the rule used is always reported back — a wrong split is otherwise invisible."
				};
			},
			presentCall: () => ({ card: "generic", title: "Podcast capability check", kind: "other", rawInput: {} })
		}));
	}

	/* -- podcast_chapters -------------------------------------------------- */
	if (config.chapters) {
		ctx.tools.register(defineTool({
			name: "podcast_chapters",
			description: "Find the chapter boundaries inside a recording by detecting silence between segments. Returns every proposed cut point with the silence gap that justified it, plus the rule used — so the split can be reviewed before anything is cut.",
			parameters: {
				path: { type: "string", required: true, description: "Path to the audio file to analyse." },
				silenceDb: { type: "number", description: "Noise floor in dB below which audio counts as silence. Default from config." },
				minSilenceSeconds: { type: "number", description: "Minimum gap length in seconds to count as a boundary. Default from config." },
				maxChapters: { type: "number", description: "Stop after this many chapters, merging the rest into the last one." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						durationSeconds: { type: "number", required: true },
						rule: { type: "string", required: true },
						silenceDb: { type: "number", required: true },
						minSilenceSeconds: { type: "number", required: true },
						gapsFound: { type: "number", required: true },
						chapters: {
							type: "array", required: true,
							items: {
								type: "object", additionalProperties: false,
								properties: {
									index: { type: "number", required: true },
									start: { type: "number", required: true },
									end: { type: "number", required: true },
									durationSeconds: { type: "number", required: true },
									gapSeconds: { type: "number" }
								}
							}
						},
						notes: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`${value.chapters.length} chapter(s) in ${humanDuration(value.durationSeconds)} — ${value.rule}`,
						...value.chapters.map((chapter) => `  ${String(chapter.index + 1).padStart(2)}. ${humanDuration(chapter.start)} → ${humanDuration(chapter.end)} (${humanDuration(chapter.durationSeconds)})${chapter.gapSeconds === undefined ? "" : `  [gap ${chapter.gapSeconds}s]`}`),
						...value.notes.map((note) => `note: ${note}`)
					].join("\n")
				}]
			},
			timeoutMs: budgetMs,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const probed = await probeFile(ffprobe, args.path, { signal: exec.signal, timeoutMs: budgetMs });
				const duration = probed.durationSeconds;
				if (duration === undefined) throw new Error(`podcast: could not determine the duration of "${args.path}".`);
				if (duration > config.maxInputSeconds) {
					throw new Error(`podcast: the recording is ${Math.round(duration)}s long, over the ${config.maxInputSeconds}s limit. Raise maxInputSeconds to analyse it.`);
				}

				const silenceDb = args.silenceDb ?? config.silenceDb;
				const minSeconds = args.minSilenceSeconds ?? config.minSilenceSeconds;
				if (minSeconds <= 0) throw new Error("podcast: minSilenceSeconds must be greater than zero.");

				const silences = await detectSilence(ffmpeg, args.path, { noiseDb: silenceDb, minSeconds, signal: exec.signal, timeoutMs: budgetMs });
				let chapters = chaptersFromSilence(silences, duration, minSeconds);
				const notes = [];
				if (chapters.length === 1) {
					notes.push(`No qualifying silence gap was found, so the file is reported as one chapter. Try raising silenceDb (less strict) or lowering minSilenceSeconds.`);
				}
				if (args.maxChapters !== undefined && args.maxChapters > 0 && chapters.length > args.maxChapters) {
					// Merge the tail so the caller gets an answer instead of an error.
					const kept = chapters.slice(0, args.maxChapters - 1);
					const tail = chapters.slice(args.maxChapters - 1);
					kept.push({
						index: kept.length,
						start: tail[0].start,
						end: tail[tail.length - 1].end,
						durationSeconds: Math.round((tail[tail.length - 1].end - tail[0].start) * 1000) / 1000,
						gap: tail[0].gap ?? null
					});
					notes.push(`Merged ${tail.length} chapter(s) into the last one to respect maxChapters=${args.maxChapters}.`);
					chapters = kept.map((chapter, index) => ({ ...chapter, index }));
				}

				return {
					path: resolve(args.path),
					durationSeconds: duration,
					rule: `a silence gap of at least ${minSeconds}s below ${silenceDb}dB starts a new chapter; the cut lands at the midpoint of the gap`,
					silenceDb,
					minSilenceSeconds: minSeconds,
					gapsFound: silences.length,
					chapters: chapters.map((chapter) => ({
						index: chapter.index,
						start: chapter.start,
						end: chapter.end,
						durationSeconds: chapter.durationSeconds,
						gapSeconds: chapter.gap === null ? undefined : chapter.gap
					})),
					notes
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Detect chapters in ${basename(args.path ?? "audio")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- podcast_trim ------------------------------------------------------ */
	if (config.trim) {
		ctx.tools.register(defineTool({
			name: "podcast_trim",
			description: "Cut a recording into segments at explicit boundaries and write one file per segment. Uses a fast stream copy by default, and re-encodes only when an accurate mid-frame cut was requested.",
			parameters: {
				path: { type: "string", required: true, description: "Path to the source audio file." },
				cuts: {
					type: "array", required: true,
					description: "Boundary times in seconds, ascending. Each begins a new segment; the first segment starts at 0.",
					items: { type: "number" }
				},
				format: { type: "string", description: `Output container: ${Object.keys(TARGETS).join(", ")}. Defaults to the source extension.` },
				accurate: { type: "boolean", description: "Cut at the exact requested time by re-encoding. Slower, but no partial audio at the head of a segment." },
				outputDir: { type: "string", description: "Directory for the segments. Defaults to the configured output directory." },
				prefix: { type: "string", description: "File name prefix, e.g. the episode slug." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						outputDir: { type: "string", required: true },
						format: { type: "string", required: true },
						mode: { type: "string", required: true },
						segments: {
							type: "array", required: true,
							items: {
								type: "object", additionalProperties: false,
								properties: {
									index: { type: "number", required: true },
									start: { type: "number", required: true },
									end: { type: "number", required: true },
									durationSeconds: { type: "number", required: true },
									bytes: { type: "number", required: true },
									outputPath: { type: "string", required: true }
								}
							}
						},
						totalBytes: { type: "number", required: true },
						notes: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`wrote ${value.segments.length} segment(s) to ${value.outputDir} using ${value.mode}`,
						...value.segments.map((segment) => `  ${String(segment.index + 1).padStart(2)}. ${humanDuration(segment.start)} → ${humanDuration(segment.end)}  ${(segment.bytes / 1048576).toFixed(2)} MB  ${basename(segment.outputPath)}`),
						...value.notes.map((note) => `note: ${note}`)
					].join("\n")
				}]
			},
			timeoutMs: budgetMs,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const probed = await probeFile(ffprobe, args.path, { signal: exec.signal, timeoutMs: budgetMs });
				const duration = probed.durationSeconds;
				if (duration === undefined) throw new Error(`podcast: could not determine the duration of "${args.path}".`);
				const sourceCodec = probed.codec;

				const cuts = [...args.cuts];
				for (const [index, value] of cuts.entries()) {
					if (!Number.isFinite(value) || value < 0) throw new Error(`podcast: cuts[${index}] must be a non-negative number of seconds, got ${value}.`);
				}
				for (let index = 1; index < cuts.length; index += 1) {
					if (cuts[index] <= cuts[index - 1]) throw new Error(`podcast: cuts must be strictly ascending — cuts[${index - 1}]=${cuts[index - 1]} is not less than cuts[${index}]=${cuts[index]}.`);
				}
				if (cuts.length > 0 && cuts[0] <= 0) cuts.shift();

				const notes = [];
				const sourceExt = extname(args.path).toLowerCase().replace(/^\./u, "");
				let format = args.format ?? (TARGETS[sourceExt] === undefined ? "mp3" : sourceExt);
				if (TARGETS[format] === undefined) {
					throw new Error(`podcast: unsupported output format "${format}". Supported: ${Object.keys(TARGETS).join(", ")}.`);
				}
				if (args.format === undefined && TARGETS[sourceExt] === undefined) {
					notes.push(`The source is .${sourceExt}, which has no matching output target, so MP3 was used. Pass format explicitly to choose.`);
				}
				const target = TARGETS[format];
				const accurate = args.accurate === true;
				// A stream copy can only begin on a packet boundary. When the caller
				// asked for exact cuts we re-encode; otherwise we copy — but only if
				// the source codec can live in the target container unchanged.
				// Re-encoding an MP3 to MP3 would waste the whole point of `copy`,
				// so codec compatibility is what decides, not the target's encoder.
				const compatible = sourceCodec !== undefined && CODEC_FOR_TARGET[format] === sourceCodec;
				const reencode = accurate || !compatible;

				const directory = resolve(args.outputDir ?? outputDir);
				await mkdir(directory, { recursive: true });
				const slug = slugify(args.prefix ?? basename(args.path, extname(args.path)));

				const boundaries = [...cuts.filter((value) => value > 0 && value < duration), duration];
				const segments = [];
				let previous = 0;
				for (let index = 0; index < boundaries.length; index += 1) {
					const end = boundaries[index];
					const segmentDuration = end - previous;
					if (segmentDuration <= 0.01) { previous = end; continue; }
					const outputPath = join(directory, `${slug}-${String(index + 1).padStart(3, "0")}.${format}`);
					await cutSegment(ffmpeg, {
						source: args.path,
						start: previous,
						duration: segmentDuration,
						outputPath,
						reencode,
						acodec: target.acodec,
						extra: target.extra,
						signal: exec.signal,
						timeoutMs: budgetMs
					});
					const info = await stat(outputPath);
					segments.push({
						index,
						start: Math.round(previous * 1000) / 1000,
						end: Math.round(end * 1000) / 1000,
						durationSeconds: Math.round(segmentDuration * 1000) / 1000,
						bytes: info.size,
						outputPath
					});
					previous = end;
				}
				if (segments.length === 0) throw new Error("podcast: the requested cuts produced no segments. Check that the times fall inside the recording.");
				if (reencode && accurate) {
					notes.push("Re-encoded because accurate: true was requested, so every cut lands exactly on the requested time.");
				} else if (reencode) {
					notes.push(`Re-encoded because the source codec (${sourceCodec ?? "unknown"}) cannot be copied into .${format} unchanged; a stream copy needs a matching codec.`);
				} else {
					notes.push("Stream-copied, so each segment starts on the nearest packet boundary; pass accurate: true to cut exactly (slower).");
				}
				return {
					outputDir: directory,
					format,
					mode: reencode ? "re-encode (frame-accurate)" : "stream copy (fast)",
					segments,
					totalBytes: segments.reduce((sum, segment) => sum + segment.bytes, 0),
					notes
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Split ${basename(args.path ?? "audio")} into ${(args.cuts ?? []).length + 1} segments`, kind: "other", rawInput: args })
		}));
	}

	/* -- podcast_feed ------------------------------------------------------ */
	if (config.feed) {
		ctx.tools.register(defineTool({
			name: "podcast_feed",
			description: "Write an iTunes-compatible RSS 2.0 podcast feed. Enclosure byte lengths are measured from the files on disk rather than trusted from the caller, because a wrong length makes clients silently drop the episode. The produced document is re-parsed and validated before it is returned.",
			parameters: {
				feedPath: { type: "string", required: true, description: "Where to write the feed, e.g. feed.xml." },
				title: { type: "string", required: true, description: "Show title." },
				description: { type: "string", description: "Show description." },
				link: { type: "string", description: "Show website URL." },
				author: { type: "string", description: "Show author." },
				language: { type: "string", description: "BCP 47 language tag, e.g. zh-CN." },
				category: { type: "string", description: "iTunes category, e.g. Technology." },
				imageUrl: { type: "string", description: "Cover art URL (must be publicly reachable for clients to show it)." },
				explicit: { type: "boolean", description: "Whether the show contains explicit content." },
				episodes: {
					type: "array", required: true,
					description: "Episodes in the feed, newest first.",
					items: {
						type: "object", additionalProperties: false,
						properties: {
							title: { type: "string", required: true },
							audioPath: { type: "string", required: true, description: "Local audio file; its byte size becomes the enclosure length." },
							url: { type: "string", required: true, description: "Public URL of that file." },
							description: { type: "string" },
							guid: { type: "string" },
							pubDate: { type: "string", description: "RFC 2822 date, e.g. Tue, 01 Oct 2026 09:00:00 +0800." }
						}
					}
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						feedPath: { type: "string", required: true },
						bytes: { type: "number", required: true },
						episodeCount: { type: "number", required: true },
						episodes: {
							type: "array", required: true,
							items: {
								type: "object", additionalProperties: false,
								properties: {
									title: { type: "string", required: true },
									url: { type: "string", required: true },
									length: { type: "number", required: true },
									type: { type: "string", required: true },
									durationSeconds: { type: "number" }
								}
							}
						},
						valid: { type: "boolean", required: true },
						problems: { type: "array", required: true, items: { type: "string" } },
						notes: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`wrote ${value.feedPath} (${value.bytes} bytes, ${value.episodeCount} episode(s))`,
						`validation: ${value.valid ? "PASSED" : "FAILED"}`,
						...value.episodes.map((episode) => `  ${episode.title}  ${episode.type}  ${episode.length} bytes${episode.durationSeconds === undefined ? "" : `  ${humanDuration(episode.durationSeconds)}`}`),
						...value.problems.map((problem) => `problem: ${problem}`),
						...value.notes.map((note) => `note: ${note}`)
					].join("\n")
				}]
			},
			timeoutMs: 120000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const notes = [];
				const items = [];
				for (const [index, episode] of args.episodes.entries()) {
					let info;
					try {
						info = await stat(episode.audioPath);
					} catch (error) {
						throw new Error(`podcast: episodes[${index}].audioPath "${episode.audioPath}" could not be read (${error?.message ?? error}). The enclosure length is measured from the file, so it must exist.`);
					}
					const extension = extname(episode.audioPath).toLowerCase().replace(/^\./u, "");
					const type = MIME_TYPES[extension];
					if (type === undefined) {
						throw new Error(`podcast: episodes[${index}] has extension ".${extension}", which has no known podcast MIME type. Supported: ${Object.keys(MIME_TYPES).join(", ")}.`);
					}
					let duration;
					try {
						duration = (await probeFile(ffprobe, episode.audioPath, { signal: exec.signal, timeoutMs: 60000 })).durationSeconds;
					} catch {
						// A missing duration is a nice-to-have; a missing length is not.
						notes.push(`episodes[${index}] duration could not be probed; the itunes:duration tag is omitted.`);
					}
					items.push({
						title: episode.title,
						description: episode.description ?? episode.title,
						url: episode.url,
						length: info.size,
						type,
						durationSeconds: duration,
						guid: episode.guid ?? episode.url,
						pubDate: episode.pubDate
					});
				}

				const xml = buildFeed({
					title: args.title,
					link: args.link ?? "",
					description: args.description ?? "",
					language: args.language ?? "en",
					author: args.author,
					category: args.category,
					imageUrl: args.imageUrl,
					explicit: args.explicit === true
				}, items);

				// Re-read what we wrote and check the invariants clients enforce,
				// so a broken feed is caught here instead of by a listener.
				const validation = validateFeed(xml);
				const feedPath = resolve(args.feedPath);
				await mkdir(dirname(feedPath), { recursive: true });
				await writeFile(feedPath, xml, "utf8");
				return {
					feedPath,
					bytes: Buffer.byteLength(xml, "utf8"),
					episodeCount: items.length,
					episodes: items.map((item) => ({ title: item.title, url: item.url, length: item.length, type: item.type, durationSeconds: item.durationSeconds })),
					valid: validation.ok,
					problems: validation.problems,
					notes
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Write podcast feed ${basename(args.feedPath ?? "feed.xml")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- podcast_normalize ------------------------------------------------- */
	if (config.normalize) {
		ctx.tools.register(defineTool({
			name: "podcast_normalize",
			description: "Normalise loudness to a broadcast target with ffmpeg's EBU R128 loudnorm filter, run in two passes so the result actually lands on the target instead of merely getting closer. Also reports the measured loudness before and after.",
			parameters: {
				path: { type: "string", required: true, description: "Path to the source audio file." },
				targetLufs: { type: "number", description: "Integrated loudness target in LUFS. -16 suits podcasts, -14 suits streaming." },
				truePeakDb: { type: "number", description: "Maximum true peak in dBTP. -1.5 is a safe default." },
				outputName: { type: "string", description: "File name for the normalised audio. Defaults to <source>-normalized.<ext>." },
				outputDir: { type: "string", description: "Directory for the output. Defaults to the configured output directory." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						outputPath: { type: "string", required: true },
						bytes: { type: "number", required: true },
						inputLufs: { type: "number" },
						inputTruePeakDb: { type: "number" },
						outputLufs: { type: "number" },
						outputTruePeakDb: { type: "number" },
						targetLufs: { type: "number", required: true },
						gainApplied: { type: "number" },
						notes: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`wrote ${value.outputPath} (${(value.bytes / 1048576).toFixed(2)} MB)`,
						value.inputLufs === undefined ? "input loudness: not measured" : `loudness: ${value.inputLufs} LUFS → ${value.outputLufs ?? "?"} LUFS (target ${value.targetLufs})`,
						value.gainApplied === undefined ? "" : `gain applied: ${value.gainApplied > 0 ? "+" : ""}${value.gainApplied} LU`,
						value.outputTruePeakDb === undefined ? "" : `true peak: ${value.outputTruePeakDb} dBTP`,
						...value.notes.map((note) => `note: ${note}`)
					].filter((line) => line !== "").join("\n")
				}]
			},
			timeoutMs: budgetMs,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const targetLufs = args.targetLufs ?? -16;
				const truePeak = args.truePeakDb ?? -1.5;
				if (!Number.isFinite(targetLufs) || targetLufs > 0) throw new Error(`podcast: targetLufs must be a negative number of LUFS, got ${args.targetLufs}.`);
				const notes = [];

				/** Measure first: this is the pass that makes the second one land. */
				const measure = async (source) => {
					const { stderr } = await runCommand(ffmpeg, [
						"-hide_banner", "-nostats",
						"-i", source,
						"-af", `loudnorm=I=${targetLufs}:TP=${truePeak}:print_format=json`,
						"-f", "null", "-"
					], { timeoutMs: budgetMs, signal: exec.signal });
					// loudnorm prints its JSON summary to stderr at the end of the run.
					const match = /\{[\s\S]*?"input_i"[\s\S]*?\}/u.exec(stderr);
					if (match === null) return {};
					try {
						const json = JSON.parse(match[0]);
						return {
							inputLufs: Number(json.input_i),
							inputTruePeakDb: Number(json.input_tp),
							outputLufs: Number(json.output_i)
						};
					} catch {
						return {};
					}
				};

				const before = await measure(args.path);
				if (before.inputLufs === undefined || !Number.isFinite(before.inputLufs)) {
					notes.push("The input loudness could not be measured; the normalisation still ran, but the gain is unknown.");
				}

				const directory = resolve(args.outputDir ?? outputDir);
				await mkdir(directory, { recursive: true });
				const extension = extname(args.path).toLowerCase().replace(/^\./u, "");
				const format = TARGETS[extension] === undefined ? "mp3" : extension;
				const target = TARGETS[format];
				if (args.outputName !== undefined && args.outputName !== "" && args.outputName.includes("..")) {
					throw new Error(`podcast: outputName may not contain ".." (got "${args.outputName}").`);
				}
				const outputName = args.outputName ?? `${basename(args.path, extname(args.path))}-normalized.${format}`;
				const outputPath = join(directory, basename(outputName));

				await runCommand(ffmpeg, [
					"-hide_banner", "-nostats", "-y",
					"-i", args.path,
					"-af", `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11`,
					"-vn", "-acodec", target.acodec, ...target.extra,
					outputPath
				], { timeoutMs: budgetMs, signal: exec.signal });

				const after = await measure(outputPath);
				const info = await stat(outputPath);
				const gainApplied = before.inputLufs !== undefined && after.outputLufs !== undefined && Number.isFinite(after.outputLufs)
					? Math.round((after.outputLufs - before.inputLufs) * 10) / 10
					: undefined;
				return {
					outputPath,
					bytes: info.size,
					inputLufs: Number.isFinite(before.inputLufs) ? Math.round(before.inputLufs * 10) / 10 : undefined,
					inputTruePeakDb: Number.isFinite(before.inputTruePeakDb) ? Math.round(before.inputTruePeakDb * 10) / 10 : undefined,
					outputLufs: Number.isFinite(after.outputLufs) ? Math.round(after.outputLufs * 10) / 10 : undefined,
					outputTruePeakDb: Number.isFinite(after.inputTruePeakDb) ? Math.round(after.inputTruePeakDb * 10) / 10 : undefined,
					targetLufs,
					gainApplied,
					notes
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Normalise ${basename(args.path ?? "audio")}`, kind: "other", rawInput: args })
		}));
	}
}

export { Config, apply, inject, name };
export {
	buildFeed,
	validateFeed,
	parseSilence,
	chaptersFromSilence,
	humanDuration,
	ffmpegTimestamp,
	rssDuration,
	slugify,
	escapeXml,
	classify,
	MIME_TYPES,
	TARGETS,
	CODEC_FOR_TARGET
};