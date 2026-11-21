"""Package a Git revision and the pinned Lean Windows runtime into one release ZIP."""

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile


LEAN_VERSION = "4.36.0"
LEAN_ARCHIVE_SHA256 = "5af5f955df6cfe37082d71c56c7d47fe620faa9f59e14b917b43976c08dc676b"
RUNTIME_FILE = re.compile(
    r"(?:bin/(?:lean\.exe|[^/]+\.dll)|lib/lean/(?:[^/]+/)*[^/]+\.(?:olean(?:\.private|\.server)?|ir|dll)"
    r"|LICENSE(?:S)?(?:\.txt|/.*)?)"
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lean_archive", type=Path, help="Official lean-4.36.0-windows.zip")
    parser.add_argument("output", type=Path)
    parser.add_argument("--revision", default="HEAD", help="Git revision of NaoMa to package")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == args.lean_archive.resolve():
        parser.error("Choose an output path separate from the official Lean archive.")
    with args.lean_archive.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != LEAN_ARCHIVE_SHA256:
            parser.error("The Lean archive does not match the pinned release.")
    root = Path(__file__).resolve().parents[2]
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as staging:
        package = Path(staging) / "NaoMa.zip"
        subprocess.run(
            ["git", "archive", "--format=zip", "--prefix=NaoMa/", "-o", str(package), args.revision],
            cwd=root, check=True,
        )
        prefix = f"lean-{LEAN_VERSION}-windows/"
        runtime = f"NaoMa/proof-reader/lean/{LEAN_VERSION}/"
        with zipfile.ZipFile(args.lean_archive) as source, zipfile.ZipFile(
            package, "a", compression=zipfile.ZIP_DEFLATED, compresslevel=1
        ) as dest:
            required = {"bin/lean.exe", "LICENSE", "LICENSES"}
            for item in source.infolist():
                if item.is_dir() or not item.filename.startswith(prefix):
                    continue
                name = item.filename[len(prefix):]
                if ".." in name.split("/") or not RUNTIME_FILE.fullmatch(name):
                    continue
                with source.open(item) as inp, dest.open(runtime + name, "w") as out:
                    shutil.copyfileobj(inp, out, length=1024 * 1024)
                required.discard(name)
            if required:
                raise ValueError(f"Official runtime is missing {sorted(required)}")
        package.replace(output)


if __name__ == "__main__":
    main()
