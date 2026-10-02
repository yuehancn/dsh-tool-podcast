#!/usr/bin/env python3
"""Independent verification of the podcast feed that dsh-tool-podcast writes.

The point of this script is that it shares no code with the plugin. It reads the
feed with `feedparser` — the reference RSS/Atom parser used across the Python
ecosystem — and then checks the invariants a podcast *client* enforces, which are
stricter than RSS well-formedness:

  1. the document parses at all (feedparser reports bozo on malformed XML);
  2. every item has exactly one <enclosure>;
  3. the enclosure `type` is an audio/* media type with a known file extension;
  4. the enclosure `length` is an integer and equals the real byte size of the
     referenced file on disk. This is the check that catches the failure mode
     clients reject silently;
  5. itunes:duration is present and parses back to a sane number of seconds;
  6. the channel carries the itunes namespace and a non-empty title.

Usage:
    python verify-feed.py <feed.xml> [--expected expected.json] [--audio-dir DIR]

Exit code 0 when everything passes, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

try:
    import feedparser
except ImportError:  # pragma: no cover - environment problem, not a feed problem
    print("feedparser is required: python -m pip install feedparser", file=sys.stderr)
    raise SystemExit(2)


# Extensions a podcast client is willing to play, mapped to the type it expects.
EXTENSION_TYPE = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".aac": "audio/aac",
    ".opus": "audio/opus",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


def parse_duration(text: str | None) -> float | None:
    """Parse an itunes:duration value into seconds.

    Both shapes are legal RSS: a plain integer of seconds, or HH:MM:SS. A few
    feeds emit MM:SS, so that is accepted too.
    """
    if text is None:
        return None
    text = text.strip()
    if text == "":
        return None
    if re.fullmatch(r"\d+", text):
        return float(text)
    parts = text.split(":")
    if not all(re.fullmatch(r"\d+(\.\d+)?", part) for part in parts):
        return None
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def resolve_audio_path(url: str, audio_dir: str | None) -> str | None:
    """Map an enclosure URL onto a local file, when one can be found."""
    if audio_dir is None:
        return None
    name = os.path.basename(url.split("?")[0])
    candidate = os.path.join(audio_dir, name)
    return candidate if os.path.exists(candidate) else None


def verify(feed_path: str, expected_path: str | None, audio_dir: str | None) -> int:
    problems: list[str] = []
    checks = 0

    with open(feed_path, "r", encoding="utf-8") as handle:
        raw = handle.read()

    parsed = feedparser.parse(raw)

    # 1. Well-formedness. feedparser sets bozo=1 on XML it had to recover from.
    checks += 1
    if parsed.bozo:
        problems.append(f"the document did not parse cleanly: {parsed.get('bozo_exception')}")
    checks += 1
    if not parsed.entries:
        problems.append("no episodes were parsed from the feed")

    channel = parsed.feed
    checks += 1
    if not channel.get("title"):
        problems.append("the channel has no title")
    checks += 1
    if not raw.startswith("<?xml"):
        problems.append("the document does not start with an XML declaration")
    checks += 1
    if "itunes.com/dtds/podcast-1.0.dtd" not in raw:
        problems.append("the itunes namespace is not declared, so clients will not treat this as a podcast")

    expected = None
    if expected_path is not None and os.path.exists(expected_path):
        with open(expected_path, "r", encoding="utf-8") as handle:
            expected = json.load(handle)
        checks += 1
        if expected.get("title") and channel.get("title") != expected["title"]:
            problems.append(f"channel title is {channel.get('title')!r}, expected {expected['title']!r}")

    rows = []
    for index, entry in enumerate(parsed.entries):
        label = entry.get("title", f"entry {index + 1}")

        # 2. Exactly one enclosure.
        enclosures = [link for link in entry.get("links", []) if link.get("rel") == "enclosure"]
        checks += 1
        if len(enclosures) != 1:
            problems.append(f"{label}: expected exactly one enclosure, found {len(enclosures)}")
            continue
        enclosure = enclosures[0]

        url = enclosure.get("href", "")
        media_type = enclosure.get("type", "")
        length_raw = enclosure.get("length", "")

        # 3. An audio media type that matches the file extension.
        checks += 1
        if not media_type.startswith("audio/"):
            problems.append(f"{label}: enclosure type is {media_type!r}, not an audio media type")
        extension = os.path.splitext(url.split("?")[0])[1].lower()
        checks += 1
        if extension in EXTENSION_TYPE:
            if media_type != EXTENSION_TYPE[extension]:
                problems.append(f"{label}: enclosure type {media_type!r} does not match the .{extension.lstrip('.')} extension (want {EXTENSION_TYPE[extension]!r})")
        else:
            problems.append(f"{label}: enclosure URL has no recognised audio extension ({extension!r})")

        # 4. A numeric length that matches the file on disk.
        checks += 1
        if not re.fullmatch(r"\d+", str(length_raw)):
            problems.append(f"{label}: enclosure length {length_raw!r} is not an integer; clients drop such episodes")
            length_value = None
        else:
            length_value = int(length_raw)

        local = resolve_audio_path(url, audio_dir)
        if local is not None and length_value is not None:
            real = os.path.getsize(local)
            checks += 1
            if length_value != real:
                problems.append(f"{label}: enclosure length is {length_value} but {os.path.basename(local)} is {real} bytes")

        # 5. A parseable duration.
        duration_text = entry.get("itunes_duration")
        checks += 1
        seconds = parse_duration(duration_text)
        if seconds is None:
            problems.append(f"{label}: itunes:duration is missing or unparseable ({duration_text!r})")
        elif seconds <= 0:
            problems.append(f"{label}: itunes:duration parses to {seconds}s, which is not a usable length")

        rows.append({
            "title": label,
            "type": media_type,
            "length": length_value,
            "duration_s": round(seconds, 1) if seconds is not None else None,
            "guid": entry.get("id", ""),
        })

    # Compare against the recorded ground truth when it is available.
    if expected is not None:
        checks += 1
        if len(parsed.entries) != len(expected.get("episodes", [])):
            problems.append(f"the feed has {len(parsed.entries)} episode(s), expected {len(expected.get('episodes', []))}")
        for index, want in enumerate(expected.get("episodes", [])):
            if index >= len(rows):
                break
            got = rows[index]
            checks += 1
            if want.get("url") and want["url"] not in raw:
                problems.append(f"episode {index + 1}: URL {want['url']!r} is not present in the feed")
            if want.get("length") is not None and got["length"] != want["length"]:
                problems.append(f"episode {index + 1}: length is {got['length']}, expected {want['length']}")

    # --- report -----------------------------------------------------------
    print(f"feed: {os.path.basename(feed_path)}")
    print(f"  title:    {channel.get('title')}")
    print(f"  language: {channel.get('language')}")
    print(f"  episodes: {len(parsed.entries)}")
    print()
    header = f"{'title':<24}{'type':<14}{'length':>12}{'duration':>11}  guid"
    print(header)
    print("-" * len(header))
    for row in rows:
        print(f"{row['title'][:23]:<24}{row['type']:<14}{str(row['length']):>12}{(str(row['duration_s']) + 's'):>11}  {row['guid'][:40]}")
    print()

    if problems:
        print(f"PROBLEMS ({len(problems)}):")
        for problem in problems:
            print(f"  - {problem}")
        print()
        print(f"checks run: {checks}, problems: {len(problems)}")
        return 1

    print(f"checks run: {checks}, problems: 0")
    print("feed verified")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a podcast feed independently of the plugin that wrote it.")
    parser.add_argument("feed", help="path to the RSS feed to verify")
    parser.add_argument("--expected", default=None, help="JSON file describing the expected feed contents")
    parser.add_argument("--audio-dir", default=None, help="directory holding the published audio, so byte lengths can be checked")
    args = parser.parse_args()

    if not os.path.exists(args.feed):
        print(f"feed not found: {args.feed}", file=sys.stderr)
        return 2

    expected = args.expected
    if expected is None:
        sibling = os.path.join(os.path.dirname(args.feed), "expected.json")
        if os.path.exists(sibling):
            expected = sibling

    return verify(args.feed, expected, args.audio_dir)


if __name__ == "__main__":
    raise SystemExit(main())