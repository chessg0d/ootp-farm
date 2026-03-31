#!/usr/bin/env python3
"""Export OOTP S+ CSV roster files to JSON for the farm viewer.

Usage:
  source ~/farm_venv/bin/activate && python scripts/export_farm.py
"""

import json
import pandas as pd
from pathlib import Path

CSV_FOLDER = Path.home() / "Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games/The League.lg/import_export"
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "farm.json"

LEVEL_RULES = [
    ("(aaa",                "AAA"),
    ("(aa",                 "AA"),
    ("(a+",                 "High-A"),
    ("(a__kc)",             "Low-A"),
    ("(acl)",               "Rookie-ACL"),
    ("dsl_royals_fortuna",  "Rookie-DSL1"),
    ("dsl_royals_ventura",  "Rookie-DSL2"),
    ("(dsl)",               "Rookie-DSL"),
]

LEVEL_ORDER = ["Rookie-DSL1", "Rookie-DSL2", "Rookie-DSL", "Rookie-ACL",
               "Low-A", "High-A", "AA", "AAA"]

BAT_TOOLS = ["CON P", "HT P", "GAP P", "POW P", "EYE P"]
PIT_TOOLS = ["STU P", "MOV P", "CON P"]


def detect_level(filename: str) -> str:
    name = filename.lower()
    for key, level in LEVEL_RULES:
        if key in name:
            return level
    return "Unknown"


def load_csvs(pattern, tools):
    files = sorted(CSV_FOLDER.glob(pattern))
    frames = []
    for f in files:
        df = pd.read_csv(f)
        df["Level"] = detect_level(f.name)
        present = [c for c in tools if c in df.columns]
        df["ToolAvg"] = df[present].mean(axis=1).round(1)
        frames.append(df)
    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames, ignore_index=True)
    combined["_lvl"] = combined["Level"].map({l: i for i, l in enumerate(LEVEL_ORDER)}).fillna(99)
    combined.sort_values(["_lvl", "POT", "ToolAvg"], ascending=[True, False, False], inplace=True)
    combined.drop(columns="_lvl", inplace=True)
    return combined


hitters = load_csvs("*batting_potential.csv", BAT_TOOLS)
pitchers = load_csvs("*pitching_potential.csv", PIT_TOOLS)

# Build output structure
output = {"levels": LEVEL_ORDER, "hitters": [], "pitchers": [], "overview": []}

bat_cols = ["Level", "POS", "#", "Name", "Age", "B", "T", "POT", "ToolAvg",
            "CON P", "HT P", "K P", "GAP P", "POW P", "EYE P", "SPE", "STE", "RUN", "DEF", "SctAcc"]
pit_cols = ["Level", "POS", "#", "Name", "Age", "B", "T", "POT", "ToolAvg",
            "STU P", "MOV P", "HRA P", "PBABIP P", "CON P", "VELO", "STM", "G/F", "HLD", "SctAcc"]

for _, row in hitters.iterrows():
    output["hitters"].append({c: (row[c] if pd.notna(row.get(c)) else "") for c in bat_cols if c in row.index})

for _, row in pitchers.iterrows():
    output["pitchers"].append({c: (row[c] if pd.notna(row.get(c)) else "") for c in pit_cols if c in row.index})

for level in LEVEL_ORDER:
    b = hitters[hitters["Level"] == level] if not hitters.empty else pd.DataFrame()
    p = pitchers[pitchers["Level"] == level] if not pitchers.empty else pd.DataFrame()
    if b.empty and p.empty:
        continue
    output["overview"].append({
        "level": level,
        "hitters": len(b),
        "pitchers": len(p),
        "avgPotBat": round(b["POT"].mean(), 1) if not b.empty else None,
        "avgPotPit": round(p["POT"].mean(), 1) if not p.empty else None,
        "bestBat": f"{b.iloc[0]['Name']} ({int(b.iloc[0]['POT'])})" if not b.empty else None,
        "bestPit": f"{p.iloc[0]['Name']} ({int(p.iloc[0]['POT'])})" if not p.empty else None,
    })

def convert(obj):
    import numpy as np
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT, "w") as f:
    json.dump(output, f, default=convert, indent=2)

print(f"Exported {len(output['hitters'])} hitters + {len(output['pitchers'])} pitchers -> {OUTPUT}")
