#!/usr/bin/env python3
"""
analyzer.py — Simplified Tweak Configuration Generator

Generates build configurations from a simple tweakslist without hitting GitHub API.
Uses sensible defaults and minimal detection.

Usage:
    python scripts/analyzer.py
"""

import json
import os
import sys

###############################################################################
# Configuration
###############################################################################

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.json")

DEFAULT_BUILD_CMD = "make clean package DEBUG=0 FINALPACKAGE=1"

# Known dependencies (hardcoded to avoid API calls).
# These represent tweaks that use sibling-relative #import paths such as
# "../YTVideoOverlay/Header.h" and therefore require the dep to be cloned
# as a sibling directory in /tmp/ before compilation.
KNOWN_DEPENDENCIES = {
    "youpip":      ["ytvideooverlay"],
    "youtimestamp":["ytvideooverlay"],
    "youquality":  ["ytvideooverlay"],
    "youmute":     ["ytvideooverlay"],
    "youspeed":    ["ytvideooverlay"],
}

# Header dependencies (which headers each tweak needs)
HEADER_DEPENDENCIES = {
    # Most YouTube tweaks need YouTubeHeader
    "ytlite": ["YouTubeHeader", "PSHeader"],
    "youtimestamp": ["YouTubeHeader"],
    "youpip": ["YouTubeHeader"],
    "youquality":  ["YouTubeHeader"],
    "youmute":     ["YouTubeHeader"],
    "youspeed":    ["YouTubeHeader"],
    "ytvideooverlay": ["YouTubeHeader"],
    "returnyoutubedislikes": ["YouTubeHeader"],
    "ytuhd": ["YouTubeHeader"],
    "youtubeextensions": ["YouTubeHeader", "PSHeader"],
    "openyoutubesafariextension": ["YouTubeHeader"],
    "donteatmycontent": ["YouTubeHeader", "YTHeaders"],
    "ytnohovercards": ["YouTubeHeader"],
    "ytab": ["YouTubeHeader"],
    "ytnoshorts": ["YouTubeHeader"],
    "ytclassicvideoquality": ["YouTubeHeader"],
    "ytnocommunityguidelinesendscreen": ["YouTubeHeader"],
    # Add more as needed - default will be YouTubeHeader if not specified
}

# Available header repositories
HEADER_REPOS = {
    "YouTubeHeader": "https://github.com/PoomSmart/YouTubeHeader.git",
    "PSHeader": "https://github.com/PoomSmart/PSHeader.git",
    "YTHeaders": "https://github.com/therealFoxster/YTHeaders.git",
}

# Tweaks known to have releases (hardcoded to avoid API calls)
HAS_RELEASES = {
    "ytlite",
    "returnyoutubedislikes",
}

# Special build commands (hardcoded to avoid API calls)
SPECIAL_BUILD_CMDS = {
    "ytuhd": "make clean package DEBUG=0 FINALPACKAGE=1 SIDELOAD=1",
}

# .appex bundles (hardcoded)
APPEX_REPOS = {
    "youtubeextensions",
    "openyoutubesafariextension",
}

# Tweaks that are known-broken against the current YouTubeHeader / YouTube version
# and should be excluded from the build entirely.
# Format: { "tweak_id": "reason" }
SKIPPED_TWEAKS = {
    # QTMIcon.tintImage:color: removed; createButton:accessibilityLabel:selector:
    # removed from YTMainAppControlsOverlayView — broken since ~YT 19.x.
    # Re-enable once arichornlover/YouTimeStamp is updated.
    "youtimestamp": "incompatible with current YouTubeHeader (tintImage:color: and createButton:accessibilityLabel:selector: removed)",
}

# For tweaks that ship multiple .deb variants in a release (e.g. rootless + roothide),
# specify a substring that must appear in the chosen filename (deb_filter) and/or
# a substring that must NOT appear (deb_exclude).
# The build workflow uses these to pick the correct asset from the GitHub API response.
DEB_FILTERS = {
    # YTLite ships iphoneos-arm64 (rootless) and iphoneos-arm64e (roothide) debs.
    # We always want the rootless one.
    "ytlite": {"deb_filter": "iphoneos-arm64", "deb_exclude": "roothide"},
    # Return YouTube Dislikes also ships both variants.
    "returnyoutubedislikes": {"deb_exclude": "roothide"},
}

# Shell commands to run inside the clone directory before the main build_cmd.
# Used to patch incompatibilities between a tweak and its dependencies without
# forking either repo.
PRE_BUILD_CMDS = {
    # YTVideoOverlay added a required `metadata` second arg to initYTVideoOverlay().
    # YouTimeStamp hasn't been updated yet — patch the call site to pass nil.
    # NOTE: currently moot since youtimestamp is in SKIPPED_TWEAKS, but kept here
    # so re-enabling it in SKIPPED_TWEAKS is the only change needed.
    "youtimestamp": "sed -i '' 's/initYTVideoOverlay(TweakKey);/initYTVideoOverlay(TweakKey, nil);/' Tweak.x",
}

###############################################################################
# Utility Functions
###############################################################################

def normalize_id(repo):
    """Convert 'Owner/RepoName' to 'reponame'."""
    name = repo.split("/")[-1]
    # Remove common separators
    return name.replace("-", "").replace("_", "").replace(".", "").lower()


def make_id(repo):
    """Generate ID from repo."""
    return normalize_id(repo)


###############################################################################
# Simple Analyzer
###############################################################################

def analyze_tweak(repo, all_tweaks):
    """Analyze a single tweak with minimal detection."""
    tweak_id = make_id(repo)

    print(f"Analyzing {repo}...")

    # Determine fetch method
    if tweak_id in HAS_RELEASES:
        fetch = "release"
        print(f"  ✓ {tweak_id}: fetch=release (known to have releases)")
    elif tweak_id in APPEX_REPOS:
        fetch = "appex"
        print(f"  ✓ {tweak_id}: fetch=appex (contains .appex)")
    else:
        fetch = "build"
        print(f"  ✓ {tweak_id}: fetch=build (default)")

    # Get build command
    build_cmd = SPECIAL_BUILD_CMDS.get(tweak_id, DEFAULT_BUILD_CMD)
    if build_cmd != DEFAULT_BUILD_CMD:
        print(f"    Special build command: {build_cmd}")

    # Get dependencies
    depends_on = KNOWN_DEPENDENCIES.get(tweak_id, [])
    if depends_on:
        print(f"    Dependencies: {depends_on}")

    # Get header dependencies
    headers = HEADER_DEPENDENCIES.get(tweak_id, ["YouTubeHeader"])
    if headers:
        print(f"    Required headers: {', '.join(headers)}")

    # Get deb asset filters (for release tweaks with multiple variants)
    deb_opts = DEB_FILTERS.get(tweak_id, {})
    if deb_opts:
        print(f"    Deb filters: {deb_opts}")

    # Get pre-build patch command
    pre_build_cmd = PRE_BUILD_CMDS.get(tweak_id)
    if pre_build_cmd:
        print(f"    Pre-build patch: {pre_build_cmd}")

    # Build config
    config = {
        "id": tweak_id,
        "repo": repo,
        "fetch": fetch,
    }

    if fetch == "build":
        config["build_cmd"] = build_cmd

    # deb_filter / deb_exclude only apply to release tweaks
    if fetch == "release" and deb_opts:
        if "deb_filter" in deb_opts:
            config["deb_filter"] = deb_opts["deb_filter"]
        if "deb_exclude" in deb_opts:
            config["deb_exclude"] = deb_opts["deb_exclude"]

    if depends_on:
        config["depends_on"] = depends_on

    if pre_build_cmd:
        config["pre_build_cmd"] = pre_build_cmd

    if headers:
        config["headers"] = headers

    return config


def topological_sort(configs):
    """Simple topological sort for build order."""
    # Build dependency graph
    graph = {}
    all_ids = set()

    for cfg in configs:
        tweak_id = cfg["id"]
        all_ids.add(tweak_id)
        graph[tweak_id] = set(cfg.get("depends_on", []))

    # Kahn's algorithm - count how many dependencies each node has
    in_degree = {node: len(graph[node]) for node in all_ids}

    # Start with nodes that have no dependencies
    queue = [node for node in all_ids if in_degree[node] == 0]
    result = []

    while queue:
        queue.sort()  # For deterministic order
        node = queue.pop(0)
        result.append(node)

        # For each tweak that depends on this node, decrement its in_degree
        for other in all_ids:
            if node in graph.get(other, set()):
                in_degree[other] -= 1
                if in_degree[other] == 0:
                    queue.append(other)

    if len(result) != len(all_ids):
        print("⚠️  Warning: Circular dependency detected, using arbitrary order")
        return sorted(all_ids)

    return result


def collect_all_headers(configs):
    """Collect all unique headers needed across all tweaks."""
    all_headers = set()
    for cfg in configs:
        headers = cfg.get("headers", [])
        all_headers.update(headers)
    return sorted(all_headers)


###############################################################################
# Main
###############################################################################

def main():
    """Main analyzer logic."""
    print("=" * 60)
    print("YTLitePlus Tweak Analyzer (Simplified)")
    print("=" * 60)
    print()

    # Load config
    if not os.path.exists(CONFIG_PATH):
        print(f"❌ Config file not found: {CONFIG_PATH}")
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    tweakslist = config.get("tweakslist", [])
    if not tweakslist:
        print("❌ No tweaks found in config.json tweakslist")
        sys.exit(1)

    print(f"Found {len(tweakslist)} tweak(s) to analyze")
    print()

    # Filter out tweaks that are known-broken
    skipped = []
    active_tweakslist = []
    for repo in tweakslist:
        tid = make_id(repo)
        if tid in SKIPPED_TWEAKS:
            skipped.append((repo, SKIPPED_TWEAKS[tid]))
        else:
            active_tweakslist.append(repo)

    if skipped:
        print("⏭️  Skipping incompatible tweaks:")
        for repo, reason in skipped:
            print(f"  • {repo}: {reason}")
        print()

    tweakslist = active_tweakslist

    # Build mapping of all tweaks
    all_tweaks = {make_id(repo): repo for repo in tweakslist}

    # Analyze each tweak
    configs = []
    for repo in tweakslist:
        try:
            cfg = analyze_tweak(repo, all_tweaks)
            configs.append(cfg)
        except Exception as e:
            print(f"❌ Failed to analyze {repo}: {e}")
            sys.exit(1)

    print()

    # Build order
    build_order = topological_sort(configs)

    print("Build order:", " → ".join(build_order))
    print()

    # Collect all required headers
    required_headers = collect_all_headers(configs)
    header_config = {}
    for header in required_headers:
        if header in HEADER_REPOS:
            header_config[header] = HEADER_REPOS[header]

    if header_config:
        print("Required headers:")
        for header, repo in header_config.items():
            print(f"  • {header}: {repo}")
        print()

    # Assemble output
    output = {
        "tweakslist": tweakslist,
        "config": configs,
        "build_order": build_order,
        "headers": header_config,
        "metadata": {
            "total_tweaks": len(tweakslist),
            "successfully_analyzed": len(configs),
            "required_headers": list(required_headers),
        }
    }

    # Save
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"✅ Updated {CONFIG_PATH}")
    print(f"✅ Successfully analyzed {len(configs)}/{len(tweakslist)} tweaks")
    print(f"✅ Detected {len(required_headers)} required header(s)")


if __name__ == "__main__":
    main()