"""Build-time dependency notices, including bundled native curl licenses."""
from importlib.metadata import distributions
from pathlib import Path
import sys

out = []
for package in sorted(distributions(), key=lambda d: d.metadata['Name'].lower()):
    out.append(f"\n=== {package.metadata['Name']} {package.version} ===\n")
    out.append(package.metadata.get('License-Expression') or package.metadata.get('License') or 'See included license text.')
    for file in package.files or []:
        if any(word in str(file).lower() for word in ['license', 'copying', 'notice']) and not str(file).endswith('.py'):
            path = package.locate_file(file)
            if path.is_file():
                try:
                    out.append(f"\n--- {file} ---\n{path.read_text(encoding='utf-8')}")
                except UnicodeError:
                    pass
Path(sys.argv[1]).write_text('\n'.join(out), encoding='utf-8')
