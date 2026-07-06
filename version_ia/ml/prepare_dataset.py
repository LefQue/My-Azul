#!/usr/bin/env python3.12
"""
Usage:
  python3.12 prepare_dataset.py training-data/*.json --out dataset --val-split 0.15

Reads one or more training-data-*.json files exported by index-scan-train.html
(each file: a JSON array of {"label": "B"|"Y"|"R"|"K"|"W"|"empty", "dataUrl": "data:image/png;base64,..."}),
decodes the base64 PNGs, and writes a Keras image_dataset_from_directory-compatible layout:

  dataset/train/B/00000.png ...
  dataset/train/empty/00000.png ...
  dataset/validation/B/00000.png ...
  dataset/validation/empty/00000.png ...

The split is stratified per label (not Keras's built-in validation_split), so a rare class
can't end up with zero validation examples by bad luck.
"""
import argparse
import base64
import hashlib
import json
import random
from pathlib import Path

LABELS = ["B", "Y", "R", "K", "W", "empty"]


def load_examples(json_paths: list[Path]) -> list[dict]:
    examples = []
    for p in json_paths:
        examples.extend(json.loads(p.read_text()))
    return examples


def dedupe_examples(examples: list[dict]) -> list[dict]:
    # une même image (même dataUrl) peut apparaître dans plusieurs fichiers envoyés séparément
    # (ex: renvoi accidentel de tout ce qui était accumulé) -- on ne garde qu'une occurrence.
    seen = set()
    unique = []
    for e in examples:
        h = hashlib.md5(e["dataUrl"].encode()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        unique.append(e)
    n_dupes = len(examples) - len(unique)
    if n_dupes:
        print(f"Doublons écartés : {n_dupes} image(s) identique(s) déjà vue(s) dans un autre fichier.")
    return unique


def stratified_split(examples: list[dict], val_ratio: float, seed: int = 42):
    by_label: dict[str, list[dict]] = {}
    for e in examples:
        by_label.setdefault(e["label"], []).append(e)

    rng = random.Random(seed)
    train, val = [], []
    for label, items in by_label.items():
        rng.shuffle(items)
        n_val = max(1, round(len(items) * val_ratio)) if len(items) > 1 else 0
        val.extend(items[:n_val])
        train.extend(items[n_val:])
    return train, val


def write_split(split_name: str, items: list[dict], out_root: Path):
    for i, e in enumerate(items):
        _, b64 = e["dataUrl"].split(",", 1)
        label_dir = out_root / split_name / e["label"]
        label_dir.mkdir(parents=True, exist_ok=True)
        (label_dir / f"{i:05d}.png").write_bytes(base64.b64decode(b64))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("json_files", nargs="+", type=Path, help="training-data-*.json files (glob expanded by your shell)")
    ap.add_argument("--out", type=Path, default=Path("dataset"), help="output dataset directory")
    ap.add_argument("--val-split", type=float, default=0.15, help="fraction of each class held out for validation")
    args = ap.parse_args()

    examples = load_examples(args.json_files)
    if not examples:
        raise SystemExit("Aucun exemple trouvé dans les fichiers fournis.")
    examples = dedupe_examples(examples)

    counts = {label: sum(1 for e in examples if e["label"] == label) for label in LABELS}
    print("Comptage par classe :")
    for label in LABELS:
        print(f"  {label:>6}: {counts[label]}")
    total = sum(counts.values())
    print(f"  {'total':>6}: {total}")

    low = [label for label, n in counts.items() if n < 40]
    if low:
        print(f"\nAttention : classes sous-représentées (< 40 exemples) : {', '.join(low)}")
        print("Envisage de prendre des photos supplémentaires ciblant ces couleurs/l'état vide avant d'entraîner.")

    train, val = stratified_split(examples, args.val_split)
    write_split("train", train, args.out)
    write_split("validation", val, args.out)
    print(f"\ntrain={len(train)}  validation={len(val)}  -> écrit dans {args.out}/")


if __name__ == "__main__":
    main()
