#!/usr/bin/env python3
"""Plumb boundary check: the flyover renders visual geometry and drone cinematography;
it never produces insurance material quantity takeoffs (squares, bundles, lineal feet).
Scope: ensures no quantity estimation or quoting routines exist in engine/*.py.
Run: python3 tests/test_compliance.py
"""
import pathlib, re, sys

# Strictly ban insurance takeoff and quoting terms from being computed in the flyover engine
QUANTITY_BANNED = ["estimate_squares", "compute_takeoff", "insurance_quote", "material_allowance_calc"]
ENGINE = pathlib.Path(__file__).resolve().parent.parent / "engine"

def test_no_quoting_routines():
    hits = []
    for f in sorted(ENGINE.glob("*.py")):
        text = f.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), 1):
            for name in QUANTITY_BANNED:
                if re.search(r"\b" + re.escape(name) + r"\b", line, re.IGNORECASE):
                    hits.append(f"{f.name}:{i}: {name}: {line.strip()}")
    assert not hits, "Plumb-banned quoting routines found in engine code:\n" + "\n".join(hits)

if __name__ == "__main__":
    try:
        test_no_quoting_routines()
    except AssertionError as e:
        print(f"FAIL: {e}"); sys.exit(1)
    print(f"PASS: Flyover engine remains strictly visual/cinematographic (no quantity takeoffs).")
