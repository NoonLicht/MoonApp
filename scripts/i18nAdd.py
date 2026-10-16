# -*- coding: utf-8 -*-
"""Добавить ключи локализации сразу во все словари src/i18n.

Использование: python scripts/i18nAdd.py keys.json
keys.json: {"ab.chatterboxDesc": ["ru", "en", "es", "fr", "zh", "ar"], ...}
Ключ — путь через точку; существующие значения перезаписываются.
"""
import json
import sys

LANGS = ["ru", "en", "es", "fr", "zh", "ar"]


def put(tree, path, value):
    parts = path.split(".")
    cur = tree
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


def main():
    keys = json.load(open(sys.argv[1], encoding="utf8"))
    for i, lang in enumerate(LANGS):
        path = "src/i18n/%s.json" % lang
        tree = json.load(open(path, encoding="utf8"))
        for key, vals in keys.items():
            put(tree, key, vals[i] if i < len(vals) else vals[1])
        with open(path, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(tree, ensure_ascii=False, indent=2) + "\n")


main()
