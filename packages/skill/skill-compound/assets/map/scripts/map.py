"""Run the installed map skill's shared helpers."""
from pathlib import Path
import sys


def main(argv: list[str]) -> int:
    action = argv[0] if argv else ""
    if action not in {"query", "lookup", "open", "status", "stop"}:
        print("usage: map.py {query,lookup,open,status,stop} ...", file=sys.stderr)
        return 2

    scripts = Path(__file__).resolve().parents[2] / "compound" / "scripts"
    sys.path.insert(0, str(scripts))
    if action == "query":
        from code_map import main as query
        return query(["--cache-read-only", *argv[1:]])
    if action == "lookup":
        from symbol_lookup import main as lookup
        return lookup(argv[1:])

    from map_server import main as viewer
    return viewer(argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
