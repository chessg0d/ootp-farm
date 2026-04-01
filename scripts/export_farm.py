#!/usr/bin/env python3
"""Export OOTP roster CSV to JSON for the farm viewer.

Usage:
  source ~/farm_venv/bin/activate && python scripts/export_farm.py
"""

import json
import pandas as pd
import numpy as np
from pathlib import Path

CSV_PATH = Path.home() / "Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games/The League.lg/import_export/kansas_city_royals_organization_-_roster_default.csv"
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "farm.json"

# Map Lev + LG columns to display level names
def map_level(row):
    lev = str(row.get("Lev", "")).strip()
    lg = str(row.get("LG", "")).strip()
    if lev == "MLB":
        return "MLB"
    if lev == "AAA":
        return "AAA"
    if lev == "AA":
        return "AA"
    if lev == "A+":
        return "High-A"
    if lev == "A":
        return "Low-A"
    if lev == "R":
        if lg == "DSL":
            return "Rookie-DSL"
        return "Rookie-ACL"
    return "Unknown"

LEVEL_ORDER = ["Rookie-DSL", "Rookie-ACL", "Low-A", "High-A", "AA", "AAA"]

HITTER_POS = {"C", "1B", "2B", "SS", "3B", "LF", "CF", "RF"}
PITCHER_POS = {"SP", "RP", "CL"}

# Batting tool columns (from CON/STU P and POW/MOV P combo cols + individual)
BAT_TOOLS = ["CON P", "HT P", "GAP P", "POW P"]
# The CSV has CON P (batting) and CON P_1 (pitching control) — for pitchers we want STU P, MOV P, CON P_1
PIT_TOOLS = ["STU P", "MOV P", "CON P_1"]

df = pd.read_csv(CSV_PATH)

# Add level
df["Level"] = df.apply(map_level, axis=1)

# Filter out MLB
df = df[df["Level"] != "MLB"].copy()
df = df[df["Level"] != "Unknown"].copy()

# Split hitters vs pitchers by POS
hitters = df[df["POS"].isin(HITTER_POS)].copy()
pitchers = df[df["POS"].isin(PITCHER_POS)].copy()

# Compute ToolAvg — batting tools for hitters, pitching tools for pitchers
h_present = [c for c in BAT_TOOLS if c in hitters.columns]
hitters["ToolAvg"] = hitters[h_present].mean(axis=1).round(1)

p_present = [c for c in PIT_TOOLS if c in pitchers.columns]
pitchers["ToolAvg"] = pitchers[p_present].mean(axis=1).round(1)

# Rename CON P_1 -> CTL P for pitchers (pitching control)
if "CON P_1" in pitchers.columns:
    pitchers = pitchers.rename(columns={"CON P_1": "CTL P"})

# Sort by level order, then POT desc, then ToolAvg desc
for frame in [hitters, pitchers]:
    frame["_lvl"] = frame["Level"].map({l: i for i, l in enumerate(LEVEL_ORDER)}).fillna(99)
    frame.sort_values(["_lvl", "POT", "ToolAvg"], ascending=[True, False, False], inplace=True)
    frame.drop(columns="_lvl", inplace=True)

# Columns to export
bat_cols = ["Level", "POS", "#", "Name", "Age", "B", "T", "POT", "ToolAvg",
            "CON P", "HT P", "GAP P", "POW P", "SctAcc"]
pit_cols = ["Level", "POS", "#", "Name", "Age", "B", "T", "POT", "ToolAvg",
            "STU P", "MOV P", "CTL P", "PBABIP P", "VT", "SctAcc"]

output = {"levels": LEVEL_ORDER, "hitters": [], "pitchers": [], "overview": []}

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
