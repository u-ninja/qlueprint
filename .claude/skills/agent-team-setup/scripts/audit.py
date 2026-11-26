#!/usr/bin/env python3
"""Compares a project's agent team with its repo and reports where they have drifted.

Usage: python3 audit.py [repo-root]

Reports, in order:
  1. Directories nobody owns (no agent file mentions them)
  2. Paths agents claim to own that no longer exist
  3. Departments with fewer than 3 or more than 5 agents
  4. Agent files missing from the roster, and roster names with no file
Read-only. Prints a report; changing the team is a decision for the user.
"""
import os
import re
import sys

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
agents_dir = os.path.join(root, '.claude', 'agents')
roster_path = os.path.join(root, '.claude', 'team', 'ROSTER.md')

SKIP = {'node_modules', '.git', 'dist', 'build', 'target', '.next', '.turbo', 'coverage', '__pycache__',
        '.venv', 'venv', '.claude', '.github', '.vscode', '.idea', 'vendor', 'out', 'tmp'}
# Containers whose children are the real units of ownership
CONTAINERS = {'apps', 'packages', 'services', 'libs', 'crates', 'modules', 'src', 'src-tauri', 'lib', 'cmd', 'internal'}

if not os.path.isdir(agents_dir):
    sys.exit(f'No agents found at {agents_dir}. Run the skill in setup mode first.')

agents = {}
for f in sorted(os.listdir(agents_dir)):
    if f.endswith('.md'):
        text = open(os.path.join(agents_dir, f), encoding='utf-8').read()
        agents[f[:-3]] = text
corpus = '\n'.join(agents.values()).lower()


def visible_dirs(path):
    try:
        return sorted(d for d in os.listdir(path) if os.path.isdir(os.path.join(path, d)) and d not in SKIP and not d.startswith('.'))
    except OSError:
        return []


# 1. Unowned directories: top level, plus the children of container directories
candidates = []
for d in visible_dirs(root):
    if d in CONTAINERS:
        children = visible_dirs(os.path.join(root, d))
        candidates += [f'{d}/{c}' for c in children] or [d]
    else:
        candidates.append(d)
unowned = [c for c in candidates if c.lower() not in corpus and c.split('/')[-1].lower() not in corpus]

# 2. Stale paths in "What you own" sections
bases = [root] + [os.path.join(root, d) for d in visible_dirs(root)]
for d in CONTAINERS:
    bases += [os.path.join(root, d, c) for c in visible_dirs(os.path.join(root, d))]
bases += [os.path.join(b, 'src') for b in bases]
top = set(visible_dirs(root))
stale = []
for name, text in agents.items():
    m = re.search(r'^## What you own\n(.*?)(?=^## |\Z)', text, re.S | re.M)
    if not m:
        continue
    for token in re.findall(r'[\w.\-]+(?:/[\w.\-*]+)+', m.group(1)):
        token = token.rstrip('.,;:')
        first, last = token.split('/')[0], token.split('/')[-1]
        looks_like_path = '.' in last or first in top or first in CONTAINERS
        if '*' in token or token.startswith(('http', 'www')) or not looks_like_path:
            continue
        if not any(os.path.exists(os.path.join(base, token)) for base in bases):
            stale.append((name, token))

# 3 and 4. Roster
sizes, roster_names = {}, set()
if os.path.exists(roster_path):
    dept = None
    for line in open(roster_path, encoding='utf-8'):
        if line.startswith('## '):
            dept = line[3:].strip()
            sizes[dept] = 0
        m = re.match(r'\| `(\w+)` \|', line)
        if m and dept:
            sizes[dept] += 1
            roster_names.add(m.group(1))
off_size = {d: n for d, n in sizes.items() if n < 3 or n > 5}
missing_from_roster = sorted(set(agents) - roster_names) if roster_names else []
no_file = sorted(roster_names - set(agents))

print(f'Team audit for {root}')
print(f'{len(agents)} agents, {len(sizes)} departments\n')
print('Directories no agent owns:' if unowned else 'Every directory has an owner.')
for c in unowned:
    print(f'  - {c}')
if stale:
    print('\nPaths an agent owns that no longer exist:')
    for name, token in stale:
        print(f'  - {name}: {token}')
if off_size:
    print('\nDepartments outside 3-5 agents:')
    for d, n in off_size.items():
        print(f'  - {d}: {n}')
if missing_from_roster:
    print('\nAgent files missing from ROSTER.md: ' + ', '.join(missing_from_roster))
if no_file:
    print('\nROSTER.md names with no agent file: ' + ', '.join(no_file))
if not (unowned or stale or off_size or missing_from_roster or no_file):
    print('\nNo drift found.')
