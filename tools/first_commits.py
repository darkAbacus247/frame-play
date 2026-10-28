"""Write FIRST_COMMITS.md: every file tracked at a commit, with the time of
the commit that first added it, read from this repository's git history
(the author time git records, in UTC).

PROVENANCE.md points to the table; it is made again at the freeze.
Run: python -B tools/first_commits.py [COMMIT]   (default HEAD)
MIT license, as the rest of the repository.
"""
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'FIRST_COMMITS.md'


def git(*args):
    # quotepath off for this one command only, so a path is printed as it is
    r = subprocess.run(['git', '-c', 'core.quotepath=off', *args], cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', check=True)
    return r.stdout


def utc(seconds):
    return datetime.fromtimestamp(int(seconds), timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


def first_commits(commit='HEAD'):
    """[(path, time, short hash)] for every file tracked at `commit`, by the
    commit that first added the path (renames are not followed), oldest
    first, then by path."""
    files = [f for f in git('ls-tree', '-r', '--name-only', commit).split('\n') if f]
    first = {}
    when = None
    for line in git('log', '--reverse', '--no-renames', '--diff-filter=A', '--format=%x01%H %at', '--name-only', commit).split('\n'):
        if line.startswith('\x01'):
            sha, at = line[1:].split()
            when = (utc(at), sha[:7])
        elif line and line not in first:
            first[line] = when
    rows = [(f, *first[f]) for f in files]
    return sorted(rows, key=lambda r: (r[1], r[0]))


def table(commit='HEAD'):
    sha, at = git('log', '-1', '--format=%H %at', commit).split()
    rows = first_commits(sha)
    lines = [
        '# First commit of every file',
        '',
        'Every file tracked at commit %s (%s UTC), with the time of the commit that' % (sha[:7], utc(at)),
        'first added it (UTC, the author time git records) and that commit. Made from',
        "this repository's git history by `python -B tools/first_commits.py`; made",
        'again at the freeze.',
        '',
        '| File | First committed (UTC) | Commit |',
        '|---|---|---|',
    ]
    lines += ['| `%s` | %s | %s |' % r for r in rows]
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    text = table(sys.argv[1] if len(sys.argv) > 1 else 'HEAD')
    OUT.write_bytes(text.encode('utf-8'))
    print('%s: %d files' % (OUT.name, text.count('\n| `')))
