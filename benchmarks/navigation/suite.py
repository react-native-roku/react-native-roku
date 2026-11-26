"""Replay or score the versioned Roku navigation benchmarks."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from burst import score
from compare import compare
from solid_report import markdown, scorecard
from warm import measure
from holdout_timing import measure_holdout

HERE = Path(__file__).resolve().parent
SHELF = HERE.parent / "shelf"


DEEP = tuple("deep-" + name + suffix for name in ("window", "second", "triple", "long")
             for suffix in ("", "-fields"))


def extract(args, path, scenario):
    # Regenerate from the immutable trace, refuse to overwrite existing evidence.
    queries = [(HERE / "trace-quality.sql", "trace-stats.csv")]
    if scenario in ("warm", "warm-fields"):
        queries.append((SHELF / "timeline.sql", "timeline.csv"))
    queries.append((HERE / "attribution.sql", "attribution.csv"))
    if scenario.startswith("deep-"):
        queries.append((HERE / "deep/transport.sql", "transport.csv"))
    for query, name in queries:
        data = subprocess.check_output([args.processor, "-q", str(query),
                                        str(path / "device.perfetto-trace")])
        with (path / name).open("xb") as stream:
            stream.write(data)
    if scenario in ("warm", "warm-fields"):
        data = subprocess.check_output([sys.executable, str(SHELF / "trace-summary.py"), str(path)])
        with (path / "device-summary.json").open("xb") as stream:
            stream.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("test", help="run the offline navigation tests")
    rescore = commands.add_parser("rescore", help="score archived catalog bursts offline")
    rescore.add_argument("runs", type=Path, nargs="+")
    comparison = commands.add_parser("compare", help="compare warm launch blocks offline")
    comparison.add_argument("manifest", type=Path)
    comparison.add_argument("--post-apply", action="store_true",
                            help="score the two-apply endpoint after native field attribution")
    report = commands.add_parser("solid-report", help="verify and report a full-title shelf comparison offline")
    report.add_argument("manifest", type=Path)
    for arg in ("react-build", "solid-build", "react-fields", "solid-fields"):
        report.add_argument("--" + arg, type=Path, required=True)
    report.add_argument("--processor", type=Path, required=True, help="compatible trace_processor_shell executable")
    report.add_argument("--format", choices=("json", "markdown"), default="markdown")
    paced = commands.add_parser("post-apply", help="score traced paced catalog applies")
    paced.add_argument("run", type=Path)
    paced.add_argument("--marked", action="store_true", help="verify actual native field contents")
    holdout = commands.add_parser("holdout-timing", help="score traced holdout navigation")
    holdout.add_argument("run", type=Path)
    holdout.add_argument("--marked", action="store_true")
    holdout.add_argument("--attribution", type=Path, help="matched marked timing JSON")
    process = commands.add_parser("extract", help="export CSVs from a saved trace into its directory")
    process.add_argument("scenario", choices=("burst", "warm", "warm-fields", "holdout", "holdout-fields") + DEEP)
    process.add_argument("run", type=Path)
    process.add_argument("--processor", required=True)
    live = commands.add_parser("device", help="run a journey on an already-installed fixture")
    live.add_argument("scenario", choices=("warm", "warm-fields", "reversal", "scrolling", "held", "catalog", "holdout", "holdout-timing", "holdout-fields", "cold", "catalog-cold", "recovery", "images", "settings", "settings-storage", "clipping") + DEEP)
    live.add_argument("renderer", choices=("react", "solid"))
    live.add_argument("zip", type=Path)
    live.add_argument("receipt", type=Path)
    live.add_argument("output", type=Path)
    live.add_argument("--rounds", type=int, help="repeat the independent initializer catalog journey")
    live.add_argument("--rk")
    live.add_argument("--processor")
    args = parser.parse_args()
    if args.command == "test":
        subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(HERE / "tests")], check=True)
        test_env = dict(os.environ)
        test_env.pop("ROKU_SHELF_WORKLOAD", None)
        subprocess.run(["node", "--test", str(HERE / "tests/device.test.mjs"),
                        str(SHELF / "score.test.mjs"), str(SHELF / "burst.test.mjs")], env=test_env, check=True)
        return 0
    if args.command == "rescore":
        results = [score(p) for p in args.runs]
        print(json.dumps(results, indent=2))
        return int(any(r["status"] != "PASS" for r in results))
    if args.command == "solid-report":
        result = scorecard(args.manifest, args.react_build, args.solid_build, args.react_fields, args.solid_fields, args.processor.resolve())
        print(markdown(result) if args.format == "markdown" else json.dumps(result, indent=2))
        return 0
    if args.command == "compare":
        print(json.dumps(compare(args.manifest, args.post_apply), indent=2))
        return 0
    if args.command == "post-apply":
        print(json.dumps(measure(args.run, args.marked), indent=2))
        return 0
    if args.command == "holdout-timing":
        print(json.dumps(measure_holdout(args.run, args.marked, args.attribution), indent=2))
        return 0
    if args.command == "extract":
        extract(args, args.run.resolve(), args.scenario)
        return 0
    if not os.environ.get("ROKU_BENCHMARK_HOST"):
        parser.error("device requires ROKU_BENCHMARK_HOST")
    env = dict(os.environ, ROKU_SHELF_WORKLOAD="catalog")
    paths = [str(p.resolve()) for p in (args.zip, args.receipt, args.output)]
    if args.rounds is not None and (args.scenario != "catalog" or not 1 <= args.rounds <= 2000):
        parser.error("--rounds applies to catalog and must be between 1 and 2000")
    if args.scenario in ("images", "settings", "settings-storage", "clipping"):
        if args.renderer != "react":
            parser.error("the public fixture requires React")
        if args.scenario == "clipping":
            subprocess.run(["node", str(HERE.parent / "clipping/replay.mjs"), *paths], env=env, check=True)
        else:
            subprocess.run(["node", str(HERE.parent / "consumers/replay.mjs"), args.scenario, *paths], env=env, check=True)
        return 0
    if args.scenario in ("held", "catalog", "holdout", "cold", "catalog-cold", "recovery"):
        if args.scenario in ("catalog", "catalog-cold") and args.renderer != "react":
            parser.error("the public initializer catalog is a React Native consumer")
        script = {"catalog": HERE.parent / "catalog/replay.mjs", "held": HERE / "held.mjs",
                  "holdout": HERE / "holdout/replay.mjs", "cold": HERE / "cold.mjs",
                  "catalog-cold": HERE / "cold.mjs", "recovery": HERE / "recovery.mjs"}[args.scenario]
        if args.rounds is not None:
            paths.append(str(args.rounds))
        if args.scenario == "catalog-cold":
            paths.append("public-catalog")
        subprocess.run(["node", str(script), *paths], env=env, check=True)
        return 0
    if args.scenario in DEEP and args.renderer != "react":
        parser.error("deep routes use the public React Native catalog")
    if not args.rk or not args.processor:
        parser.error("traced device runs require --rk and --processor")
    burst = args.scenario in ("reversal", "scrolling")
    trace_scenario = "navigation-burst" if burst else (
        "holdout" if args.scenario == "holdout-timing" else args.scenario)
    env.update(ROKU_CATALOG_BURST_ROUTE=args.scenario, ROKU_BENCHMARK_COHORT="trace")
    captured = subprocess.run(["node", str(SHELF / "trace.mjs"), args.rk, args.renderer, *paths,
                    trace_scenario], env=env)
    if not (args.output / "device.perfetto-trace").is_file():
        return captured.returncode or 1
    extract(args, args.output, "burst" if burst else trace_scenario)
    if args.scenario in DEEP and not args.scenario.startswith("deep-window"):
        result = subprocess.run([sys.executable, str(HERE / "deep/directions.py"),
                                 str(args.output), "--output", str(args.output / "direction-score.json")])
        return captured.returncode or result.returncode
    if captured.returncode:
        return captured.returncode
    if trace_scenario.startswith("holdout"):
        with (args.output / "holdout-timing.json").open("x") as output:
            json.dump(measure_holdout(args.output, trace_scenario == "holdout-fields"), output, indent=2)
    if burst:
        result = score(args.output)
        print(json.dumps(result, indent=2))
        return int(result["status"] != "PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
